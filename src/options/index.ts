import { hostPermission, normalizeOrigin } from '../api/client';
import { defaultPolicy, fields } from '../contracts/intake';
import {
  extractionTimeoutMs,
  withExtractionTimeout,
} from '../extraction/timeout';
import {
  canonicalUrl,
  ruleFileSchema,
  ruleSchema,
  type SiteRule,
} from '../rules/schema';
import {
  action,
  element,
  get,
  inputField,
  type PublicState,
  report,
  send,
} from '../ui';

let state: PublicState;
let editing: string | undefined;
const split = (value: string) =>
  value
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
function fieldValue(root: HTMLElement, name: string) {
  return (
    root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? ''
  );
}
async function load() {
  state = await send<PublicState>({ type: 'STATE' });
  const select = get<HTMLSelectElement>('profile');
  select.replaceChildren(
    ...state.servers.map(
      (row) => new Option(`${row.label} · ${row.origin}`, row.id),
    ),
  );
  select.value = state.selectedServerId ?? '';
  populateServer(select.value);
  get<HTMLInputElement>('notifications').checked = state.notifications;
  const list = get('rule-list');
  list.replaceChildren();
  for (const rule of state.rules) {
    const row = element(
      'div',
      '',
      'flex flex-wrap items-center gap-2 border-b border-base-300 py-2',
    );
    row.append(
      element(
        'span',
        `${rule.label} · v${rule.version} · ${rule.enabled ? 'enabled' : 'disabled'}`,
        'flex-1 text-sm',
      ),
      action('Edit', () => editRule(rule)),
      action(
        'Remove',
        async () => {
          if (confirm(`Remove ${rule.label}?`)) {
            await send({ type: 'DELETE_RULE', id: rule.id });
            await load();
          }
        },
        'btn btn-ghost btn-sm',
      ),
    );
    list.append(row);
  }
}
function populateServer(id?: string) {
  const server = state.servers.find((row) => row.id === id);
  get<HTMLInputElement>('profile-id').value = server?.id ?? crypto.randomUUID();
  const root = get('server-fields');
  root.replaceChildren(
    inputField('Profile label', 'label', server?.label ?? 'Local'),
    inputField(
      'Origin (no path)',
      'origin',
      server?.origin ?? 'http://localhost:5173',
      'url',
    ),
  );
  get<HTMLInputElement>('token').value = '';
  get('connection-status').textContent = server?.hasToken
    ? 'Token saved. Test connection to verify current access.'
    : 'Not configured.';
}
function editRule(rule?: SiteRule) {
  editing = rule?.id;
  const value =
    rule ??
    ruleSchema.parse({
      id: `website-${crypto.randomUUID().slice(0, 8)}`,
      version: 1,
      label: 'New website',
      enabled: true,
      hostnames: ['jobs.example.com'],
      pathPattern: '/*',
      rootSelectors: ['main'],
      applicationSource: '',
      fields: {
        rawText: {
          selectors: ['.job-description'],
          mode: 'text',
          prefer: 'json-ld',
        },
      },
      identityPolicy: defaultPolicy,
    });
  get<HTMLTextAreaElement>('rule-json').value = JSON.stringify(value, null, 2);
  get<HTMLInputElement>('rule-enabled').checked = value.enabled;
  const basics = get('rule-basics');
  basics.replaceChildren();
  for (const [label, name, text] of [
    ['Stable ID', 'id', value.id],
    ['Name', 'label', value.label],
    [
      'Website hostnames (comma separated)',
      'hostnames',
      value.hostnames.join(', '),
    ],
    ['Path pattern (* wildcard)', 'pathPattern', value.pathPattern],
    [
      'Root selectors (semicolon separated)',
      'rootSelectors',
      value.rootSelectors.join('; '),
    ],
    ['Application source', 'applicationSource', value.applicationSource],
  ])
    basics.append(inputField(label, name, text));
  const idInput = basics.querySelector<HTMLInputElement>('[name="id"]');
  if (idInput) idInput.readOnly = !!rule;
  const controls = get('rule-fields');
  controls.replaceChildren();
  for (const name of ['rawText', ...fields] as const) {
    const field = value.fields[name];
    const box = element(
      'fieldset',
      '',
      'fieldset rounded-box border border-base-300 p-3',
    );
    box.append(
      element(
        'legend',
        name === 'rawText' ? 'Job description (required)' : name,
        'fieldset-legend',
      ),
    );
    const label = element(
      'label',
      'CSS fallback selectors, one per line',
      'label',
    );
    label.htmlFor = `selectors-${name}`;
    const input = element('textarea', '', 'textarea w-full');
    input.id = label.htmlFor;
    input.name = name;
    input.value = field?.selectors.join('\n') ?? '';
    box.append(label, input);
    controls.append(box);
  }
  get('rule-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  basics.querySelector<HTMLInputElement>('[name="label"]')?.focus();
}
function readRule() {
  const value = JSON.parse(get<HTMLTextAreaElement>('rule-json').value);
  const basics = get('rule-basics');
  for (const key of ['id', 'label', 'pathPattern', 'applicationSource'])
    value[key] = fieldValue(basics, key);
  // Root selectors use newline or semicolon separation to support CSS commas.
  value.hostnames = split(fieldValue(basics, 'hostnames'));
  value.rootSelectors = fieldValue(basics, 'rootSelectors')
    .split(/\n|;/)
    .map((v) => v.trim())
    .filter(Boolean);
  value.enabled = get<HTMLInputElement>('rule-enabled').checked;
  for (const name of ['rawText', ...fields]) {
    const selectors =
      get('rule-fields')
        .querySelector<HTMLTextAreaElement>(`[name="${name}"]`)
        ?.value.split('\n')
        .map((v) => v.trim())
        .filter(Boolean) ?? [];
    if (selectors.length || name === 'rawText')
      value.fields[name] = {
        mode: 'text',
        prefer: 'json-ld',
        ...value.fields[name],
        selectors,
      };
    else delete value.fields[name];
  }
  return ruleSchema.parse(value);
}
async function refreshTabs() {
  const tabs = await send<{ id: number; url: string; title: string }[]>({
    type: 'TABS',
  });
  get<HTMLSelectElement>('test-tab').replaceChildren(
    ...tabs.map(
      (tab) => new Option(`${tab.title} · ${tab.url}`, String(tab.id)),
    ),
  );
}
get('profile').addEventListener('change', () => {
  const id = get<HTMLSelectElement>('profile').value;
  populateServer(id);
  void send({ type: 'SELECT_SERVER', id }).catch(report);
});
get('new-profile').addEventListener('click', () => populateServer());
get('server-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const origin = normalizeOrigin(fieldValue(get('server-fields'), 'origin'));
    if (
      !(await chrome.permissions.request({ origins: [hostPermission(origin)] }))
    )
      throw new Error('Server access was not granted.');
    const token = get<HTMLInputElement>('token').value.trim();
    await send({
      type: 'SAVE_SERVER',
      id: get<HTMLInputElement>('profile-id').value,
      label: fieldValue(get('server-fields'), 'label'),
      origin,
      ...(token ? { token } : {}),
    });
    await load();
  } catch (error) {
    report(error);
  }
});
get('test-connection').addEventListener('click', async () => {
  try {
    get('connection-status').textContent = 'Checking…';
    await send({
      type: 'TEST_CONNECTION',
      id: get<HTMLInputElement>('profile-id').value,
    });
    get('connection-status').textContent = 'Connected · API v1 authenticated.';
  } catch (error) {
    get('connection-status').textContent = 'Connection failed.';
    report(error);
  }
});
get('notifications').addEventListener('change', async () => {
  const checkbox = get<HTMLInputElement>('notifications');
  try {
    if (
      checkbox.checked &&
      !(await chrome.permissions.request({ permissions: ['notifications'] }))
    )
      throw new Error(
        'Notifications were not granted; badge and results remain available.',
      );
    await send({ type: 'NOTIFICATIONS', enabled: checkbox.checked });
  } catch (error) {
    checkbox.checked = false;
    report(error);
  }
});
get('add-rule').addEventListener('click', () => editRule());
get('cancel-rule').addEventListener('click', () =>
  editRule(state.rules.find((rule) => rule.id === editing)),
);
get('rule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const rule = readRule();
    if (
      !(await chrome.permissions.request({
        origins: rule.hostnames.map((host) =>
          hostPermission(
            `${host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https'}://${host}`,
          ),
        ),
      }))
    )
      throw new Error('Website access was not granted.');
    await send({ type: 'SAVE_RULE', rule });
    await load();
    editRule(state.rules.find((row) => row.id === rule.id));
  } catch (error) {
    report(error);
  }
});
get('export-rules').addEventListener('click', () => {
  const blob = new Blob(
    [JSON.stringify({ schemaVersion: 1, rules: state.rules }, null, 2)],
    { type: 'application/json' },
  );
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = 'job-intaker-rules.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
});
get('import-rules').addEventListener('change', async (event) => {
  try {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 262144) throw new Error('Rule file exceeds 256 KiB.');
    const parsed = ruleFileSchema.parse(JSON.parse(await file.text()));
    if (
      state.rules.some((old) =>
        parsed.rules.some((next) => next.id === old.id),
      ) &&
      !confirm('Replace rules with matching IDs? Other rules are preserved.')
    )
      return;
    await send({ type: 'IMPORT_RULES', file: parsed });
    await load();
  } catch (error) {
    report(error);
  }
});
get('test-extraction').addEventListener('click', async () => {
  const button = get<HTMLButtonElement>('test-extraction');
  if (button.disabled) return;
  button.disabled = true;
  get('extraction-result').textContent = '';
  try {
    const rule = readRule();
    const origins = rule.hostnames.map((host) =>
      hostPermission(
        `${host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https'}://${host}`,
      ),
    );
    if (!(await chrome.permissions.request({ origins })))
      throw new Error('Website access was not granted.');
    get('extraction-result').textContent = 'Testing…';
    const result = await withExtractionTimeout(
      () =>
        send<{ item?: { sourceUrl: string }; error?: string }>({
          type: 'TEST_EXTRACTION',
          tabId: Number(get<HTMLSelectElement>('test-tab').value),
          rule,
        }),
      () =>
        'The extension worker did not respond. Reload the extension and reopen Settings.',
      extractionTimeoutMs + 1000,
    );
    get('extraction-result').textContent = JSON.stringify(
      {
        ...result,
        ...(result.item
          ? {
              deduplicationUrl: canonicalUrl(
                result.item.sourceUrl,
                rule.identityPolicy,
              ),
            }
          : {}),
      },
      null,
      2,
    );
  } catch (error) {
    get('extraction-result').textContent =
      error instanceof Error ? error.message : 'Extraction failed.';
    report(error);
  } finally {
    button.disabled = false;
  }
});
get('refresh-tabs').addEventListener('click', () => {
  void refreshTabs().catch(report);
});
void load()
  .then(() => {
    editRule(state.rules[0]);
    return refreshTabs();
  })
  .catch(report);
