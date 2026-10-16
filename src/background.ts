import { z } from 'zod';
import {
  capabilities,
  hostPermission,
  normalizeOrigin,
  safeAppLink,
} from './api/client';
import { itemSchema } from './contracts/intake';
import { extractFromPage } from './extraction/page';
import {
  advance,
  finished,
  makeOperation,
  notificationId,
  totals,
} from './queue/operations';
import { matchRule, ruleFileSchema, ruleSchema } from './rules/schema';
import { trustedSender } from './security';
import {
  change,
  cleanup,
  type Operation,
  type Preview,
  publicState,
  readState,
} from './storage/state';

const alarm = 'job-intake-progress';
let running = false;
let capturing = false;
const uuid = z.uuid();
const messages = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('STATE') }),
  z.strictObject({ type: z.literal('GROUPS') }),
  z.strictObject({ type: z.literal('TABS') }),
  z.strictObject({
    type: z.literal('SAVE_SERVER'),
    id: uuid,
    label: z.string().trim().min(1).max(100),
    origin: z.string().max(2048),
    token: z.string().trim().min(16).max(500).optional(),
  }),
  z.strictObject({ type: z.literal('SELECT_SERVER'), id: uuid }),
  z.strictObject({ type: z.literal('TEST_CONNECTION'), id: uuid }),
  z.strictObject({ type: z.literal('SAVE_RULE'), rule: ruleSchema }),
  z.strictObject({ type: z.literal('DELETE_RULE'), id: z.string().max(100) }),
  z.strictObject({ type: z.literal('IMPORT_RULES'), file: ruleFileSchema }),
  z.strictObject({
    type: z.literal('TEST_EXTRACTION'),
    tabId: z.number().int(),
    rule: ruleSchema,
  }),
  z.strictObject({
    type: z.literal('CAPTURE'),
    groupId: z.number().int().nonnegative(),
    ruleId: z.string().max(100).optional(),
  }),
  z.strictObject({
    type: z.literal('EDIT_PREVIEW'),
    id: uuid,
    checked: z.boolean(),
    rawText: z.string().max(60000),
    jobTitle: z.string().max(200),
    companyName: z.string().max(200),
    location: z.string().max(200),
    salary: z.string().max(150),
    postedDate: z.string().max(10),
    applicationSource: z.string().max(150),
  }),
  z.strictObject({ type: z.literal('SUBMIT') }),
  z.strictObject({ type: z.literal('CLEAR_PREVIEWS') }),
  z.strictObject({
    type: z.literal('RECAPTURE_PREVIEW'),
    id: uuid,
    ruleId: z.string().max(100),
  }),
  z.strictObject({ type: z.literal('RESUME'), id: uuid }),
  z.strictObject({ type: z.literal('CLEAR_OPERATION'), id: uuid }),
  z.strictObject({ type: z.literal('VIEW_RESULTS'), id: uuid }),
  z.strictObject({
    type: z.literal('OPEN_APPLICATION'),
    operationId: uuid,
    batchId: z.number().int().positive(),
    itemId: z.number().int(),
  }),
  z.strictObject({ type: z.literal('NOTIFICATIONS'), enabled: z.boolean() }),
]);
async function ensureAlarm() {
  if (!(await chrome.alarms.get(alarm)))
    await chrome.alarms.create(alarm, { periodInMinutes: 0.5 });
}
async function currentWindow() {
  const window = await chrome.windows.getLastFocused({
    windowTypes: ['normal'],
  });
  if (window.id === undefined)
    throw new Error('No normal browser window is available.');
  return window.id;
}
async function tabs() {
  return (await chrome.tabs.query({ windowId: await currentWindow() })).flatMap(
    (tab) =>
      tab.id !== undefined && tab.url && /^https?:/.test(tab.url)
        ? [
            {
              id: tab.id,
              url: tab.url,
              title: tab.title ?? '',
              groupId: tab.groupId,
            },
          ]
        : [],
  );
}
async function extract(
  tabId: number,
  rule: z.infer<typeof ruleSchema>,
  expectedUrl?: string,
) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || (expectedUrl && tab.url !== expectedUrl))
    throw new Error('Tab navigated after selection. Capture the group again.');
  matchRule([rule], tab.url, rule.id);
  if (
    !(await chrome.permissions.contains({ origins: [hostPermission(tab.url)] }))
  )
    throw new Error('Website permission is missing. Grant access in Settings.');
  const result = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'ISOLATED',
    func: extractFromPage,
    args: [rule],
  });
  const value = result[0]?.result;
  const after = await chrome.tabs.get(tabId);
  if (
    !value ||
    after.url !== tab.url ||
    (value.item && value.item.sourceUrl !== tab.url)
  )
    throw new Error('Page changed during capture. Capture again.');
  return value;
}
async function captureNext() {
  if (capturing) return;
  capturing = true;
  let activeId: string | undefined;
  try {
    while (true) {
      const state = await readState();
      const capture = state.capture;
      if (!capture) break;
      activeId = capture.id;
      if (capture.index >= capture.tabIds.length) {
        await change((state) => {
          state.capture = undefined;
        });
        break;
      }
      const tabId = capture.tabIds[capture.index];
      const preview = state.previews.find((row) => row.tabId === tabId);
      if (!preview) {
        await change((state) => {
          if (state.capture) state.capture.index++;
        });
        continue;
      }
      let result: Preview;
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId !== capture.groupId)
          throw new Error('Tab is no longer in the chosen group.');
        const rule = matchRule(state.rules, preview.url, capture.ruleId);
        const extracted = await extract(tabId, rule, preview.url);
        const item = extracted.item
          ? itemSchema.parse({ ...extracted.item, clientItemId: preview.id })
          : undefined;
        result = {
          ...preview,
          ...extracted,
          item,
          checked: !!item,
          ruleId: rule.id,
        };
      } catch (error) {
        result = {
          ...preview,
          checked: false,
          error: error instanceof Error ? error.message : 'Capture failed.',
        };
      }
      await change((state) => {
        if (state.capture?.id !== capture.id) return;
        state.previews = state.previews.map((row) =>
          row.id === preview.id ? result : row,
        );
        state.capture.index++;
      });
    }
  } catch {
    await change((state) => {
      if (state.capture?.id !== activeId) return;
      state.capture = undefined;
      state.previews = state.previews.filter((row) => !!row.item);
      state.captureError =
        'Capture stopped at the local storage limit. Import or clear the captured jobs, then capture a smaller group.';
    });
  } finally {
    capturing = false;
  }
}
async function notify(operation: Operation) {
  const state = await readState();
  if (
    state.notifications &&
    (await chrome.permissions.contains({ permissions: ['notifications'] }))
  ) {
    const id = await notificationId(operation);
    await change((state) => {
      const stored = state.operations.find((row) => row.id === operation.id);
      if (stored) stored.notificationId = id;
    });
    const counts = totals(operation);
    await chrome.notifications
      .create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: 'Job analysis finished',
        message: `${counts.completed} analyzed · ${counts.duplicate} duplicate · ${counts.failed + counts.rejected} failed/rejected · ${counts.decisions} decisions to review`,
      })
      .catch(() => undefined); // OS delivery is optional; badge/results must still update.
  }
  await change((state) => {
    const stored = state.operations.find((row) => row.id === operation.id);
    if (stored) stored.notified = true;
  });
}
async function tick() {
  if (running) return;
  running = true;
  try {
    await change(cleanup);
    void captureNext().catch(() => undefined);
    const state = await readState();
    // One upload/poll at a time; model concurrency belongs to the backend.
    for (const operation of state.operations)
      for (const batch of operation.batches)
        await advance(operation.id, batch.id);
    const updated = await readState();
    for (const operation of updated.operations)
      if (finished(operation) && !operation.notified) await notify(operation);
    const pending = updated.operations.filter(
      (operation) => !operation.seen || !finished(operation),
    ).length;
    await chrome.action.setBadgeText({ text: pending ? String(pending) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#0369a1' });
  } finally {
    running = false;
  }
}
function kick() {
  void tick().catch(() => undefined);
}
async function viewResults(id: string) {
  const operation = (await readState()).operations.find((row) => row.id === id);
  if (!operation) throw new Error('Operation not found.');
  await change((state) => {
    const stored = state.operations.find((row) => row.id === id);
    if (stored) stored.seen = true;
  });
  if (operation.batches.length === 1 && operation.batches[0].status)
    await chrome.tabs.create({
      url: safeAppLink(operation.origin, operation.batches[0].status.reviewUrl),
    });
  else
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`popup/index.html?operation=${operation.id}`),
    });
}
async function handle(value: unknown) {
  const message = messages.parse(value);
  await ensureAlarm();
  switch (message.type) {
    case 'STATE':
      kick();
      return publicState(await readState());
    case 'GROUPS':
      return chrome.tabGroups.query({ windowId: await currentWindow() });
    case 'TABS':
      return tabs();
    case 'SAVE_SERVER': {
      const origin = normalizeOrigin(message.origin);
      if (
        !(await chrome.permissions.contains({
          origins: [hostPermission(origin)],
        }))
      )
        throw new Error('Grant access to the Job Tracker origin first.');
      await change((state) => {
        const previous = state.servers.find((row) => row.id === message.id);
        if (
          previous?.origin !== origin &&
          state.operations.some(
            (row) => row.serverId === message.id && !finished(row),
          )
        )
          throw new Error(
            'Create a new server profile instead: unfinished jobs are bound to this origin.',
          );
        const token = message.token ?? previous?.token;
        if (!token) throw new Error('An intake API token is required.');
        state.servers = [
          ...state.servers.filter((row) => row.id !== message.id),
          { id: message.id, label: message.label, origin, token },
        ];
        state.selectedServerId = message.id;
        delete state.capabilities[message.id];
      });
      return true;
    }
    case 'SELECT_SERVER':
      return change((state) => {
        if (!state.servers.some((row) => row.id === message.id))
          throw new Error('Server not found.');
        state.selectedServerId = message.id;
      });
    case 'TEST_CONNECTION': {
      const server = (await readState()).servers.find(
        (row) => row.id === message.id,
      );
      if (!server) throw new Error('Save the server profile first.');
      const result = await capabilities(server);
      await change((state) => {
        state.capabilities[message.id] = result;
      });
      return result;
    }
    case 'SAVE_RULE':
      return change((state) => {
        const existing = state.rules.find((row) => row.id === message.rule.id);
        const next = {
          ...message.rule,
          version: existing ? existing.version + 1 : 1,
        };
        state.rules = [
          ...state.rules.filter((row) => row.id !== next.id),
          next,
        ];
      });
    case 'DELETE_RULE':
      return change((state) => {
        state.rules = state.rules.filter((row) => row.id !== message.id);
      });
    case 'IMPORT_RULES':
      return change((state) => {
        const imported = new Map(
          message.file.rules.map((rule) => [rule.id, rule]),
        );
        for (const existing of state.rules)
          if (!imported.has(existing.id)) imported.set(existing.id, existing);
        state.rules = [...imported.values()];
      });
    case 'TEST_EXTRACTION':
      return extract(message.tabId, message.rule);
    case 'CAPTURE': {
      const group = await chrome.tabGroups.get(message.groupId);
      if (group.windowId !== (await currentWindow()))
        throw new Error('Choose a group in the current window.');
      const selected = await chrome.tabs.query({
        groupId: message.groupId,
        windowId: group.windowId,
      });
      if (selected.length > 100)
        throw new Error('Capture at most 100 tabs at once. Split this group.');
      await change((state) => {
        if (state.capture)
          throw new Error(
            'A capture is already in progress. Clear it before starting again.',
          );
        state.previews = selected.flatMap((tab) =>
          tab.id !== undefined && tab.url
            ? [
                {
                  id: crypto.randomUUID(),
                  groupId: message.groupId,
                  tabId: tab.id,
                  url: tab.url,
                  title: tab.title ?? 'Job post',
                  createdAt: Date.now(),
                  checked: false,
                  warnings: [],
                },
              ]
            : [],
        );
        delete state.captureError;
        state.capture = {
          id: crypto.randomUUID(),
          groupId: message.groupId,
          tabIds: state.previews.map((row) => row.tabId),
          index: 0,
          startedAt: Date.now(),
          ruleId: message.ruleId,
        };
      });
      kick();
      return true;
    }
    case 'CLEAR_PREVIEWS':
      return change((state) => {
        state.previews = [];
        state.capture = undefined;
        delete state.captureError;
      });
    case 'RECAPTURE_PREVIEW':
      await change((state) => {
        if (state.capture)
          throw new Error('Wait for the current capture to finish.');
        const row = state.previews.find((row) => row.id === message.id);
        if (!row) throw new Error('Preview not found.');
        state.capture = {
          id: crypto.randomUUID(),
          groupId: row.groupId,
          tabIds: [row.tabId],
          index: 0,
          ruleId: message.ruleId,
          startedAt: Date.now(),
        };
        delete state.captureError;
      });
      kick();
      return true;
    case 'EDIT_PREVIEW':
      return change((state) => {
        const row = state.previews.find((row) => row.id === message.id);
        if (!row) throw new Error('Preview not found.');
        const base = row.item ?? {
          clientItemId: row.id,
          sourceUrl: row.url,
          rawText: message.rawText,
        };
        row.item = itemSchema.parse({
          ...base,
          capture: {
            ...base.capture,
            fieldSources: {
              jobTitle: 'user',
              companyName: 'user',
              location: 'user',
              salary: 'user',
              postedDate: 'user',
            },
          },
          rawText: message.rawText,
          applicationSource: message.applicationSource || null,
          suggestedMetadata: {
            jobTitle: message.jobTitle || null,
            companyName: message.companyName || null,
            location: message.location || null,
            salary: message.salary || null,
            postedDate: message.postedDate || null,
          },
        });
        row.checked = message.checked;
        delete row.error;
      });
    case 'SUBMIT':
      return change((state) => {
        if (state.capture) throw new Error('Wait for capture to finish.');
        const server = state.servers.find(
          (row) => row.id === state.selectedServerId,
        );
        if (!server) throw new Error('Configure a server in Settings first.');
        const selected = state.previews.filter(
          (row) => row.checked && row.item,
        );
        const operation = makeOperation(
          server,
          selected.flatMap((row) => (row.item ? [row.item] : [])),
          state.capabilities[server.id],
        );
        state.operations.push(operation);
        state.previews = state.previews.filter(
          (row) => !selected.some((sent) => sent.id === row.id),
        );
        kick();
        return operation.id;
      });
    case 'RESUME':
      await change((state) => {
        const row = state.operations.find((row) => row.id === message.id);
        if (!row) throw new Error('Operation not found.');
        for (const batch of row.batches)
          if (batch.state === 'blocked') {
            batch.state = batch.payload ? 'pending' : 'tracking';
            batch.attempts = 0;
            batch.nextAt = 0;
            delete batch.error;
          }
      });
      kick();
      return true;
    case 'CLEAR_OPERATION':
      return change((state) => {
        state.operations = state.operations.filter(
          (row) => row.id !== message.id,
        );
      });
    case 'VIEW_RESULTS':
      return viewResults(message.id);
    case 'OPEN_APPLICATION': {
      const row = (await readState()).operations.find(
        (row) => row.id === message.operationId,
      );
      const item = row?.batches
        .find((batch) => batch.status?.batchId === message.batchId)
        ?.status?.items.find((item) => item.itemId === message.itemId);
      if (!row || !item?.applicationUrl)
        throw new Error('Application link not found.');
      return chrome.tabs.create({
        url: safeAppLink(row.origin, item.applicationUrl),
      });
    }
    case 'NOTIFICATIONS':
      if (
        message.enabled &&
        !(await chrome.permissions.contains({ permissions: ['notifications'] }))
      )
        throw new Error('Notification permission was not granted.');
      return change((state) => {
        state.notifications = message.enabled;
      });
  }
}

// Register synchronously so events can wake a suspended MV3 worker.
chrome.runtime.onMessage.addListener((value, sender, respond) => {
  if (!trustedSender(sender)) {
    respond({ ok: false, error: 'Untrusted extension message.' });
    return false;
  }
  void storageReady
    .then(() => handle(value))
    .then((data) => respond({ ok: true, data }))
    .catch((error) =>
      respond({
        ok: false,
        error:
          error instanceof z.ZodError
            ? 'Invalid extension request. Check field values and limits.'
            : error instanceof Error
              ? error.message
              : 'Extension request failed.',
      }),
    );
  return true;
});
chrome.alarms.onAlarm.addListener((event) => {
  if (event.name === alarm) kick();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm().then(kick);
});
chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm().then(kick);
});
let notificationListenerReady = false;
function registerNotificationListener() {
  if (notificationListenerReady || !chrome.notifications?.onClicked) return;
  chrome.notifications.onClicked.addListener((id) => {
    void readState()
      .then((state) => {
        const row = state.operations.find((row) => row.notificationId === id);
        if (row) return viewResults(row.id);
      })
      .catch(() => undefined);
  });
  notificationListenerReady = true;
}
registerNotificationListener();
chrome.permissions.onAdded.addListener(registerNotificationListener);
const storageReady = chrome.storage.local.setAccessLevel({
  accessLevel: 'TRUSTED_CONTEXTS',
});
void storageReady.then(ensureAlarm).then(kick);
