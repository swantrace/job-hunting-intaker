import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { type BatchPayload, defaultPolicy } from '../src/contracts/intake';
import { extractFromPage } from '../src/extraction/page';
import { ruleSchema } from '../src/rules/schema';
import type { State } from '../src/storage/state';
import { status } from '../tests/support';

const token = 'synthetic-smoke-token-only';
const accepted = new Map<string, { payload: BatchPayload; id: number }>();
let complete = false;
const api = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (request.headers.get('Authorization') !== `Bearer ${token}`)
        return Response.json(
          { error: { code: 'unauthorized' } },
          { status: 401 },
        );
      if (url.pathname.endsWith('/capabilities'))
        return Response.json({
          schemaVersion: 1,
          authenticated: true,
          repeatImportBehavior: 'refresh-analysis',
          pollingIntervalSeconds: 30,
          limits: {
            maxItems: 20,
            maxBodyBytes: 4194304,
            maxTextCharacters: 60000,
            maxTextBytes: 131072,
          },
        });
      if (request.method === 'POST') {
        const key = request.headers.get('Idempotency-Key') ?? '';
        const payload = (await request.json()) as BatchPayload;
        const old = accepted.get(key);
        if (old) assert.deepEqual(old.payload, payload);
        else accepted.set(key, { payload, id: accepted.size + 1 });
        const row = accepted.get(key);
        assert.ok(row);
        return Response.json(
          {
            ...status(payload.items),
            batchId: row.id,
            statusUrl: `/api/v1/job-intake/batches/${row.id}`,
            reviewUrl: `/applications/import?batchId=${row.id}`,
          },
          { status: old ? 200 : 202 },
        );
      }
      const row = [...accepted.values()].find((row) =>
        url.pathname.endsWith(`/${row.id}`),
      );
      if (row)
        return Response.json({
          ...status(row.payload.items, complete),
          batchId: row.id,
          statusUrl: `/api/v1/job-intake/batches/${row.id}`,
          reviewUrl: `/applications/import?batchId=${row.id}`,
        });
      return Response.json({ error: { code: 'missing' } }, { status: 404 });
    }
    return new Response(
      `<main><h1>Engineer ${url.pathname}</h1><p class="company">Synthetic Company</p><article class="description"><p>Build accessible TypeScript interfaces with a collaborative team.</p><ul><li>Write automated tests.</li><li>Review production changes and maintain reliable services.</li></ul></article></main>`,
      { headers: { 'Content-Type': 'text/html' } },
    );
  },
});
const origin = `http://127.0.0.1:${api.port}`;
const directory = await mkdtemp(join(tmpdir(), 'job-intaker-smoke-'));
const extension = join(directory, 'extension');
await cp(resolve('dist'), extension, { recursive: true });
const manifest = await Bun.file(join(extension, 'manifest.json')).json();
// Test-only fixture permission. The shipped manifest grants no websites by default.
manifest.host_permissions = ['http://127.0.0.1/*'];
manifest.permissions.push('notifications');
await Bun.write(join(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(
  join(directory, 'profile'),
  {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-sandbox',
    ],
  },
);
try {
  let worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`${origin}/job/1`);
  const rule = ruleSchema.parse({
    id: 'synthetic',
    version: 1,
    label: 'Synthetic jobs',
    enabled: true,
    hostnames: ['127.0.0.1'],
    pathPattern: '/job/*',
    rootSelectors: ['main'],
    applicationSource: 'Synthetic Jobs',
    fields: {
      rawText: { selectors: ['.description'], mode: 'text', prefer: 'json-ld' },
      jobTitle: { selectors: ['h1'], mode: 'text', prefer: 'css-selector' },
      companyName: {
        selectors: ['.company'],
        mode: 'text',
        prefer: 'css-selector',
      },
    },
    identityPolicy: defaultPolicy,
  });
  let extracted = await page.evaluate(extractFromPage, rule);
  assert.ok(extracted.item);
  assert.match(extracted.item.rawText, /• Write automated tests/);
  assert.equal(
    extracted.item.suggestedMetadata?.companyName,
    'Synthetic Company',
  );
  await page.setContent(
    '<main><h1>Test</h1><p class="empty"></p><div class="description">Fallback body</div></main>',
  );
  const fallback = structuredClone(rule);
  fallback.fields.rawText.selectors = ['.missing', '.description'];
  assert.equal(
    (await page.evaluate(extractFromPage, fallback)).item?.rawText,
    'Fallback body',
  );
  const invalid = structuredClone(rule);
  invalid.rootSelectors = ['['];
  assert.match(
    (await page.evaluate(extractFromPage, invalid)).error ?? '',
    /Invalid CSS/,
  );
  await page.setContent(
    `<main><div class="description">DOM content<nav>Private navigation</nav><script type="application/json">not job facts</script></div></main><script type="application/ld+json">${JSON.stringify(
      {
        '@graph': [
          {
            '@type': 'JobPosting',
            url: `${origin}/job/other`,
            title: 'Other',
            description: 'Wrong body',
          },
          {
            '@type': 'JobPosting',
            url: `${origin}/job/1`,
            title: 'Right',
            description: '<p>Right paragraph</p><ul><li>Right bullet</li></ul>',
            datePosted: '3 days ago',
          },
        ],
      },
    )}</script>`,
  );
  extracted = await page.evaluate(extractFromPage, rule);
  assert.match(extracted.item?.rawText ?? '', /Right bullet/);
  assert.equal(extracted.item?.suggestedMetadata?.postedDate, null);
  await page.setContent(
    '<main><div class="description">DOM body<nav>Private navigation</nav></div></main><script type="application/ld+json">[{"@type":"JobPosting","title":"A"},{"@type":"JobPosting","title":"B"}]</script>',
  );
  extracted = await page.evaluate(extractFromPage, rule);
  assert.ok(extracted.warnings.some((value) => value.includes('Ambiguous')));
  assert.equal(extracted.item?.rawText, 'DOM body');
  await page.setContent(
    `<main><div class="description">Current job only</div></main><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url: `${origin}/job/unrelated`, description: 'Never use this unrelated posting' })}</script>`,
  );
  assert.equal(
    (await page.evaluate(extractFromPage, rule)).item?.rawText,
    'Current job only',
  );
  await page.setContent('<main></main>');
  await page.evaluate(() => {
    window.setTimeout(() => {
      const root = document.querySelector('main');
      if (root)
        root.innerHTML =
          '<div class="description">Asynchronously loaded description</div>';
    }, 50);
  });
  assert.equal(
    (await page.evaluate(extractFromPage, rule)).item?.rawText,
    'Asynchronously loaded description',
  );
  await page.setContent('<div>No root yet</div>');
  await page.evaluate(() => {
    window.setTimeout(() => history.pushState({}, '', '/job/changed'), 50);
  });
  assert.match(
    (await page.evaluate(extractFromPage, rule)).error ?? '',
    /changed during capture/,
  );
  await page.goto(`${origin}/job/1`);
  const second = await context.newPage();
  await second.goto(`${origin}/job/2`);
  const outside = await context.newPage();
  await outside.goto(`${origin}/outside-group`);
  const groupId = await worker.evaluate(async (origin) => {
    const tabs = await chrome.tabs.query({});
    const ids = tabs
      .filter((tab) => tab.url?.startsWith(`${origin}/job/`))
      .map((tab) => tab.id)
      .filter((id): id is number => typeof id === 'number');
    const [first, ...rest] = ids;
    if (first === undefined) throw new Error('No synthetic tabs');
    const groupId = await chrome.tabs.group({ tabIds: [first, ...rest] });
    await chrome.tabGroups.update(groupId, { title: 'Synthetic jobs' });
    return groupId;
  }, origin);
  const options = await context.newPage();
  const errors: string[] = [];
  options.on('pageerror', (error) => errors.push(error.message));
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.locator('#server-fields [name="label"]').fill('Local smoke');
  await options.locator('[name="origin"]').fill(origin);
  await options.locator('#token').fill(token);
  await options
    .getByRole('button', { name: 'Save & grant server access' })
    .click();
  await options.waitForFunction(() =>
    document
      .querySelector('#connection-status')
      ?.textContent?.includes('Token saved'),
  );
  assert.equal(await options.locator('#token').inputValue(), '');
  await options.locator('#notifications').check();
  await options
    .getByRole('button', { name: 'Test connection', exact: true })
    .click();
  await options.waitForFunction(() =>
    document
      .querySelector('#connection-status')
      ?.textContent?.includes('Connected'),
  );
  await options
    .getByRole('button', { name: 'Add website rule', exact: true })
    .click();
  for (const [name, value] of Object.entries({
    id: 'synthetic',
    label: 'Synthetic jobs',
    hostnames: '127.0.0.1',
    pathPattern: '/job/*',
    rootSelectors: 'main',
    applicationSource: 'Synthetic Jobs',
  }))
    await options.locator(`#rule-basics [name="${name}"]`).fill(value);
  for (const [name, value] of Object.entries({
    rawText: '.description',
    jobTitle: 'h1',
    companyName: '.company',
  }))
    await options.locator(`#rule-fields [name="${name}"]`).fill(value);
  await options
    .getByRole('button', { name: 'Save rule & grant website access' })
    .click();
  await options
    .locator('#rule-list')
    .getByText('Synthetic jobs', { exact: false })
    .waitFor();
  const popup = await context.newPage();
  console.info('Smoke: capture grouped tabs');
  popup.on('pageerror', (error) => errors.push(error.message));
  popup.on('dialog', (dialog) => dialog.accept());
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup
    .getByText('Re-importing an existing job refreshes candidate analysis.', {
      exact: false,
    })
    .waitFor();
  await popup.locator('#group').selectOption(String(groupId));
  await popup
    .getByRole('button', { name: 'Capture group', exact: true })
    .click();
  await popup.waitForFunction(
    () =>
      document
        .querySelector('#capture-status')
        ?.textContent?.startsWith('2 captured'),
    {},
    { timeout: 30000 },
  );
  assert.equal(await popup.locator('#previews details').count(), 2);
  const firstPreview = popup.locator('#previews details').first();
  console.info('Smoke: edit and save a 500-character salary');
  await firstPreview.locator('summary').click();
  const salary = 'Compensation includes salary, bonus, and benefits. '
    .repeat(11)
    .slice(0, 499)
    .concat('.');
  const salaryInput = firstPreview.locator('textarea[name="salary"]');
  assert.equal(await salaryInput.getAttribute('maxlength'), '500');
  await salaryInput.fill(salary);
  await firstPreview
    .getByRole('button', { name: 'Save preview', exact: true })
    .click();
  await popup
    .getByRole('button', { name: 'Import 2 selected jobs', exact: true })
    .waitFor();
  await popup
    .getByRole('button', { name: 'Import 2 selected jobs', exact: true })
    .click();
  console.info('Smoke: wait for accepted batch tracking');
  await popup.waitForFunction(
    () =>
      document.querySelector('#operations')?.textContent?.includes('tracking'),
    {},
    { timeout: 20000 },
  );
  assert.equal(accepted.size, 1);
  const sent = [...accepted.values()][0].payload;
  assert.equal(sent.items.length, 2);
  assert.equal(sent.items[0].suggestedMetadata?.salary, salary);
  assert.ok(
    sent.items.every((item) => !item.sourceUrl.includes('outside-group')),
  );
  await popup.close();
  const persisted = await worker.evaluate(async () => {
    const value = (await chrome.storage.local.get('jobIntake.v1'))[
      'jobIntake.v1'
    ];
    return JSON.stringify(value);
  });
  assert.ok(!persisted.includes('Build accessible TypeScript interfaces'));
  assert.ok(persisted.includes(token));
  // Wake a newly created worker through the popup, with the same persisted operation.
  const cdp = await context.newCDPSession(options);
  const targets = await cdp.send('Target.getTargets');
  const target = targets.targetInfos.find(
    (target) =>
      target.type === 'service_worker' && target.url.includes(extensionId),
  );
  assert.ok(target);
  await cdp.send('Target.closeTarget', { targetId: target.targetId });
  complete = true;
  const reopened = await context.newPage();
  console.info('Smoke: recover operation after worker restart');
  await reopened.goto(`chrome-extension://${extensionId}/popup/index.html`);
  worker =
    context
      .serviceWorkers()
      .find((worker) => worker.url().includes(extensionId)) ??
    (await context.waitForEvent('serviceworker'));
  await worker.evaluate(async () => {
    const scope = globalThis as unknown as { notificationIds: string[] };
    scope.notificationIds = [];
    chrome.notifications.create = (async (id: string) => {
      scope.notificationIds.push(id);
      return id;
    }) as unknown as typeof chrome.notifications.create;
    const value = (await chrome.storage.local.get('jobIntake.v1'))[
      'jobIntake.v1'
    ] as State;
    for (const operation of value.operations)
      for (const batch of operation.batches) batch.nextAt = 0;
    await chrome.storage.local.set({ 'jobIntake.v1': value });
    await chrome.alarms.clear('job-intake-progress');
  });
  // Popup STATE wakes recovery and recreates the alarm, rather than maintaining a popup queue.
  await reopened.waitForFunction(
    () =>
      document
        .querySelector('#operations')
        ?.textContent?.includes('2 analyzed'),
    {},
    { timeout: 20000 },
  );
  assert.equal(accepted.size, 1);
  await reopened.waitForFunction(async () => {
    const state = await chrome.runtime.sendMessage({ type: 'STATE' });
    return state.data?.operations[0]?.notified === true;
  });
  const notificationIds = await worker.evaluate(
    () =>
      (globalThis as unknown as { notificationIds: string[] }).notificationIds,
  );
  assert.equal(notificationIds.length, 1);
  assert.ok(
    await worker.evaluate(() => chrome.alarms.get('job-intake-progress')),
  );
  const state = await reopened.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'STATE' }),
  );
  assert.equal(state.ok, true);
  assert.ok(!JSON.stringify(state).includes(token));
  const untrusted = await worker.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'STATE' }).catch(() => ({ ok: false })),
  );
  assert.equal(untrusted.ok, false);
  await worker.evaluate(async () => {
    const key = 'jobIntake.v1';
    const value = (await chrome.storage.local.get(key))[key] as {
      previews: unknown[];
    };
    const preview = {
      groupId: 1,
      tabId: 1,
      url: 'https://example.com/job',
      createdAt: Date.now(),
      checked: false,
    };
    value.previews = [
      {
        ...preview,
        id: 'failed-preview',
        title: 'Failed extraction',
        error: 'Ambiguous selector (2 matches): .salary',
        warnings: [],
      },
      {
        ...preview,
        id: 'warning-preview',
        title: 'Review extracted values',
        warnings: ['Unrelated JSON-LD ignored.'],
      },
    ];
    await chrome.storage.local.set({ [key]: value });
  });
  await reopened.reload();
  await reopened.locator('#previews summary .badge-error').waitFor();
  const failedPreview = reopened.locator('#previews details').first();
  assert.equal(await failedPreview.getAttribute('open'), null);
  assert.equal(
    await failedPreview.locator('summary .badge-error').innerText(),
    'Needs attention',
  );
  assert.ok(
    await failedPreview
      .getByText('Ambiguous selector (2 matches): .salary', { exact: true })
      .isVisible(),
  );
  const warningPreview = reopened.locator('#previews details').nth(1);
  assert.equal(await warningPreview.getAttribute('open'), null);
  assert.equal(
    await warningPreview.locator('summary .badge-warning').innerText(),
    'Check warnings',
  );
  assert.ok(
    await warningPreview
      .getByText('Unrelated JSON-LD ignored.', { exact: true })
      .isVisible(),
  );
  await mkdir('.local', { recursive: true });
  await reopened.screenshot({
    path: '.local/intaker-popup-smoke.png',
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: extraction, settings, selected-group isolation, authenticated upload, payload purge, worker restart, terminal tracking, alarm recovery, and credential isolation.',
  );
} finally {
  await context.close();
  api.stop(true);
  await rm(directory, { recursive: true, force: true });
}
