import { expect, test } from 'bun:test';
import { extractFromPage } from '../src/extraction/page';
import { extractTab } from '../src/extraction/tab';
import { starterRules } from '../src/rules/defaults';

const rule = starterRules[1];
const url = 'https://ca.indeed.com/viewjob?jk=synthetic';
function setup({
  missing = false,
  permission = true,
  discarded = false,
  frozen = false,
  pageError = false,
  userSwitch = false,
  scriptFailure = false,
  loadingChecks = 0,
} = {}) {
  let scripts = 0;
  let tabFrozen = frozen;
  let tabDiscarded = discarded;
  let activated = false;
  let checksLeft = loadingChecks;
  let activeId = 7;
  const updates: number[] = [];
  globalThis.chrome = {
    tabs: {
      get: async () => {
        if (missing) throw new Error('No tab with id: 42');
        return {
          id: 42,
          url,
          groupId: 1,
          status: activated && checksLeft-- > 0 ? 'loading' : 'complete',
          discarded: tabDiscarded,
          frozen: tabFrozen,
          windowId: 1,
        };
      },
      query: async () => [{ id: activeId }],
      update: async (id: number) => {
        updates.push(id);
        activeId = id;
        if (id === 42) {
          tabFrozen = false;
          tabDiscarded = false;
          activated = true;
        }
      },
    },
    permissions: { contains: async () => permission },
    scripting: {
      executeScript: async ({ func }: { func: unknown }) => {
        if (checksLeft > 0)
          throw new Error('Script ran before reload completed.');
        scripts++;
        if (scriptFailure)
          throw new Error('Cannot access contents of the page.');
        if (userSwitch) activeId = 99;
        if (func !== extractFromPage)
          return [{ result: { url, readyState: 'complete' } }];
        return [
          {
            result: pageError
              ? {
                  error: 'No job description found. Tried: .description',
                  warnings: [],
                  diagnostics: { stage: 'Validating job description' },
                }
              : { warnings: [], diagnostics: { root: '#root' } },
          },
        ];
      },
    },
  } as unknown as typeof chrome;
  return Object.assign(() => scripts, { updates, active: () => activeId });
}

test('missing tabs preserve Chrome error and identify stage, URL, rule and tab', async () => {
  setup({ missing: true });
  const result = await extractTab(42, rule, url);
  expect(result.error).toContain('No tab with id: 42');
  expect(result.error).toContain(url);
  expect(result.diagnostics).toMatchObject({
    tabId: '42',
    stage: 'Reading tab details',
    rule: 'indeed-detail v2',
  });
});

test('a replaced tab ID is rebound only to a unique exact URL in the selected group', async () => {
  setup();
  const get = chrome.tabs.get.bind(chrome.tabs);
  chrome.tabs.get = (async (id: number) => {
    if (id === 42) throw new Error('No tab with id: 42');
    return get(id);
  }) as typeof chrome.tabs.get;
  chrome.tabs.query = (async (query: chrome.tabs.QueryInfo) =>
    query.groupId === 1
      ? [{ id: 84, url, groupId: 1, windowId: 1, status: 'complete' }]
      : [{ id: 7 }]) as typeof chrome.tabs.query;
  const result = await extractTab(42, rule, url, 1);
  expect(result.error).toBeUndefined();
  expect(result.diagnostics).toMatchObject({
    tabId: '84',
    replacedTabId: '42',
  });
});

test('duplicate URLs do not cause an arbitrary replacement tab to be captured', async () => {
  setup({ missing: true });
  chrome.tabs.query = (async () => [
    { id: 84, url },
    { id: 85, url },
  ]) as unknown as typeof chrome.tabs.query;
  const result = await extractTab(42, rule, url, 1);
  expect(result.error).toContain('No tab with id: 42');
  expect(result.diagnostics?.replacedTabId).toBeUndefined();
});

test('permission failures identify the exact host before injecting scripts', async () => {
  const count = setup({ permission: false });
  const result = await extractTab(42, rule, url);
  expect(result.error).toContain('permission is missing for ca.indeed.com');
  expect(result.diagnostics?.requiredPermission).toBe(
    'https://ca.indeed.com/*',
  );
  expect(result.diagnostics?.stage).toBe('Checking website permission');
  expect(count()).toBe(0);
});

test('discarded tabs activate, finish reloading, extract, and restore the original tab', async () => {
  const state = setup({ discarded: true, loadingChecks: 2 });
  const result = await extractTab(42, rule, url, 1);
  expect(result.error).toBeUndefined();
  expect(state.updates).toEqual([42, 7]);
  expect(state()).toBe(2);
  expect(result.diagnostics).toMatchObject({
    discarded: 'false',
    tabStatus: 'complete',
    wakeAction: 'Activated discarded tab and waited for reload',
  });
});

test('discarded tabs are not activated without website permission', async () => {
  const state = setup({ discarded: true, permission: false });
  expect((await extractTab(42, rule, url)).error).toContain(
    'permission is missing',
  );
  expect(state.updates).toEqual([]);
});

test('frozen tabs are activated before extraction and the original active tab is restored', async () => {
  const state = setup({ frozen: true });
  const result = await extractTab(42, rule, url, 1);
  expect(result.error).toBeUndefined();
  expect(state.updates).toEqual([42, 7]);
  expect(state.active()).toBe(7);
  expect(result.diagnostics?.wakeAction).toBe(
    'Activated frozen tab before extraction',
  );
  expect(state()).toBe(2);
});

test('a user-selected tab is not overridden when extraction finishes', async () => {
  const state = setup({ frozen: true, userSwitch: true });
  expect((await extractTab(42, rule, url)).error).toBeUndefined();
  expect(state.updates).toEqual([42]);
  expect(state.active()).toBe(99);
});

test('the original tab is restored even when extraction fails after activation', async () => {
  const state = setup({ frozen: true, scriptFailure: true });
  expect((await extractTab(42, rule, url)).error).toContain(
    'Cannot access contents of the page',
  );
  expect(state.updates).toEqual([42, 7]);
});

test('website permission is checked before waking a frozen tab', async () => {
  const state = setup({ frozen: true, permission: false });
  expect((await extractTab(42, rule, url)).error).toContain(
    'permission is missing',
  );
  expect(state.updates).toEqual([]);
});

test('the page probe and parser preserve selector errors and page diagnostics', async () => {
  const count = setup({ pageError: true });
  const result = await extractTab(42, rule, url);
  expect(count()).toBe(2);
  expect(result.error).toContain('Tried: .description');
  expect(result.diagnostics).toMatchObject({
    stage: 'Validating job description',
    documentState: 'complete',
    url,
    tabStatus: 'complete',
  });
});

test('successful extraction carries page state and root diagnostics', async () => {
  setup();
  const result = await extractTab(42, rule, url);
  expect(result.error).toBeUndefined();
  expect(result.diagnostics).toMatchObject({
    root: '#root',
    documentState: 'complete',
  });
});
