import { totals } from '../queue/operations';
import { matchRule } from '../rules/schema';
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
let previewSignature = '';
let dirty = false;
const dirtyRows = new Set<string>();
let loading = false;
const requestedOperation = new URL(location.href).searchParams.get('operation');
get('settings').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});
async function groups() {
  const rows = await send<chrome.tabGroups.TabGroup[]>({ type: 'GROUPS' });
  const select = get<HTMLSelectElement>('group');
  const selected = select.value;
  select.replaceChildren();
  for (const group of rows) {
    const option = element('option', group.title || `Group ${group.id}`);
    option.value = String(group.id);
    select.append(option);
  }
  if (rows.some((row) => String(row.id) === selected)) select.value = selected;
  if (!rows.length)
    select.append(new Option('Create a tab group in this window first', ''));
}
async function refresh() {
  if (loading) return;
  loading = true;
  try {
    state = await send<PublicState>({ type: 'STATE' });
    const server = get<HTMLSelectElement>('server');
    const previous = server.value;
    server.replaceChildren(
      ...state.servers.map(
        (row) => new Option(`${row.label} · ${row.origin}`, row.id),
      ),
    );
    server.value = state.selectedServerId ?? previous;
    const behavior =
      state.capabilities[state.selectedServerId ?? '']?.repeatImportBehavior;
    get('repeat-import-notice').textContent =
      behavior === 'refresh-analysis'
        ? 'Re-importing an existing job refreshes candidate analysis. Unchanged text reuses job analysis; edited application details are preserved. This may incur AI costs. Documents are not generated automatically.'
        : 'Re-import behavior depends on the server version. Update Job Tracker to refresh existing jobs instead of skipping duplicates.';
    if (!state.servers.length)
      server.append(new Option('Configure a server in Settings', ''));
    const rule = get<HTMLSelectElement>('capture-rule');
    const choice = rule.value;
    rule.replaceChildren(
      new Option('Match automatically (recommended)', ''),
      ...state.rules
        .filter((row) => row.enabled)
        .map((row) => new Option(row.label, row.id)),
    );
    rule.value = choice;
    const signature = JSON.stringify(state.previews);
    if (!dirty && signature !== previewSignature) {
      renderPreviews();
      previewSignature = signature;
    }
    get('capture-status').textContent = state.capture
      ? `Capturing ${state.capture.index + 1} / ${state.capture.tabIds.length}…`
      : `${state.previews.filter((row) => row.item).length} captured · ${state.previews.filter((row) => row.error).length} need attention`;
    if (state.captureError)
      get('capture-status').textContent += ` · ${state.captureError}`;
    get<HTMLButtonElement>('capture').disabled = !!state.capture;
    const selected = state.previews.filter(
      (row) => row.checked && row.item,
    ).length;
    const submit = get<HTMLButtonElement>('submit');
    submit.disabled =
      !selected || !!state.capture || dirty || !state.selectedServerId;
    submit.textContent = dirty
      ? 'Save preview changes before importing'
      : `Import ${selected} selected job${selected === 1 ? '' : 's'}`;
    renderOperations();
  } finally {
    loading = false;
  }
}
function renderPreviews() {
  const root = get('previews');
  root.replaceChildren();
  for (const row of state.previews) {
    const issue = row.error || row.warnings.join(' · ');
    const card = element(
      'details',
      '',
      `rounded-box border bg-base-100 p-3 ${row.error ? 'border-error' : issue ? 'border-warning' : 'border-base-300'}`,
    );
    const summary = element(
      'summary',
      row.item?.suggestedMetadata?.jobTitle || row.title,
      'font-medium cursor-pointer',
    );
    if (issue) {
      summary.append(
        element(
          'span',
          row.error ? 'Needs attention' : 'Check warnings',
          `badge badge-sm whitespace-nowrap ml-2 ${row.error ? 'badge-error' : 'badge-warning'}`,
        ),
        element(
          'span',
          issue,
          `block text-sm font-normal break-words mt-2 ${row.error ? 'text-error' : 'text-base-content/80'}`,
        ),
      );
    }
    card.append(summary);
    const url = element(
      'p',
      row.url,
      'break-all text-xs text-base-content/60 my-2',
    );
    card.append(url);
    const choices = state.rules.filter((rule) => {
      try {
        return !!matchRule([rule], row.url, rule.id);
      } catch {
        return false;
      }
    });
    if (choices.length) {
      const selector = element('select', '', 'select select-sm w-full');
      selector.setAttribute('aria-label', 'Extraction rule for this job');
      selector.replaceChildren(
        ...choices.map((rule) => new Option(rule.label, rule.id)),
      );
      selector.value = row.ruleId ?? choices[0].id;
      card.append(
        selector,
        action('Recapture this job', async () => {
          if (dirtyRows.has(row.id))
            throw new Error('Save this preview’s changes before recapturing.');
          await send({
            type: 'RECAPTURE_PREVIEW',
            id: row.id,
            ruleId: selector.value,
          });
          await refresh();
        }),
      );
    }
    if (row.error)
      for (const warning of row.warnings)
        card.append(element('p', warning, 'text-warning text-sm my-1'));
    const form = element('form', '', 'space-y-2');
    const selection = element('label', '', 'label gap-2');
    const checked = element('input', '', 'checkbox checkbox-sm');
    checked.type = 'checkbox';
    checked.name = 'selected';
    checked.checked = row.checked;
    selection.append(
      checked,
      document.createTextNode('Include in this import'),
    );
    form.append(selection);
    const meta = row.item?.suggestedMetadata;
    for (const [label, name, value, type] of [
      ['Job title', 'jobTitle', meta?.jobTitle ?? '', 'text'],
      ['Company', 'companyName', meta?.companyName ?? '', 'text'],
      ['Location', 'location', meta?.location ?? '', 'text'],
      ['Posted date (if known)', 'postedDate', meta?.postedDate ?? '', 'date'],
      [
        'Application source',
        'applicationSource',
        row.item?.applicationSource ?? '',
        'text',
      ],
    ])
      form.append(inputField(label, name, value, type));
    const salaryField = element('fieldset', '', 'fieldset');
    const salaryLabel = element(
      'label',
      'Salary (up to 500 characters)',
      'label',
    );
    salaryLabel.htmlFor = `salary-${row.id}`;
    const salary = element('textarea', '', 'textarea w-full');
    salary.id = salaryLabel.htmlFor;
    salary.name = 'salary';
    salary.value = meta?.salary ?? '';
    salary.rows = 2;
    salary.maxLength = 500;
    salaryField.append(salaryLabel, salary);
    form.append(salaryField);
    const caption = element(
      'label',
      'Job description (paste here if extraction failed)',
      'label',
    );
    caption.htmlFor = `text-${row.id}`;
    const body = element('textarea', '', 'textarea w-full min-h-40');
    body.id = caption.htmlFor;
    body.name = 'rawText';
    body.value = row.item?.rawText ?? '';
    body.maxLength = 60000;
    form.append(caption, body);
    const save = element('button', 'Save preview', 'btn btn-sm');
    save.type = 'submit';
    form.append(save);
    form.addEventListener('input', () => {
      dirtyRows.add(row.id);
      dirty = true;
      get<HTMLButtonElement>('submit').disabled = true;
      get('submit').textContent = 'Save preview changes before importing';
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      save.disabled = true;
      try {
        await send({
          type: 'EDIT_PREVIEW',
          id: row.id,
          checked: checked.checked,
          rawText: String(values.rawText ?? ''),
          jobTitle: String(values.jobTitle ?? ''),
          companyName: String(values.companyName ?? ''),
          location: String(values.location ?? ''),
          salary: String(values.salary ?? ''),
          postedDate: String(values.postedDate ?? ''),
          applicationSource: String(values.applicationSource ?? ''),
        });
        dirtyRows.delete(row.id);
        dirty = dirtyRows.size > 0;
        await refresh();
      } catch (error) {
        report(error);
      } finally {
        save.disabled = false;
      }
    });
    card.append(form);
    if (row.diagnostics) {
      const diagnostics = element(
        'pre',
        JSON.stringify(row.diagnostics, null, 2),
        'text-xs whitespace-pre-wrap mt-3',
      );
      card.append(diagnostics);
    }
    root.append(card);
  }
}
function renderOperations() {
  const root = get('operations');
  root.replaceChildren();
  for (const operation of [...state.operations].reverse()) {
    if (requestedOperation && requestedOperation !== operation.id) continue;
    const card = element(
      'article',
      '',
      'rounded-box border border-base-300 bg-base-100 p-4 space-y-2',
    );
    card.append(
      element(
        'h3',
        `${new Date(operation.createdAt).toLocaleString()} · ${operation.origin}`,
        'text-sm font-medium',
      ),
    );
    const counts = totals(operation as Parameters<typeof totals>[0]);
    card.append(
      element(
        'p',
        `${counts.completed} analyzed · ${counts.duplicate} duplicate · ${counts.failed + counts.rejected} failed/rejected · ${counts.decisions} decisions`,
        'text-sm',
      ),
    );
    for (const [index, batch] of operation.batches.entries()) {
      card.append(
        element(
          'p',
          `Batch ${index + 1}: ${batch.state}${batch.status ? ` · ${batch.status.status}` : ''}${batch.error ? ` · ${batch.error}` : ''}`,
          'text-xs',
        ),
      );
      for (const item of batch.status?.items ?? []) {
        const line = element(
          'div',
          '',
          'flex flex-wrap gap-2 items-center text-xs',
        );
        line.append(
          element(
            'span',
            `${batch.items.find((row) => row.clientItemId === item.clientItemId)?.title ?? 'Job'} · ${item.status} · ${item.stage}${item.error ? ` · ${item.error.message}` : ''}`,
          ),
        );
        if (item.applicationUrl)
          line.append(
            action(
              'Open application',
              () =>
                send({
                  type: 'OPEN_APPLICATION',
                  operationId: operation.id,
                  batchId: batch.status?.batchId,
                  itemId: item.itemId,
                }),
              'btn btn-ghost btn-xs',
            ),
          );
        card.append(line);
      }
    }
    const buttons = element('div', '', 'flex flex-wrap gap-2');
    if (!requestedOperation || operation.batches.length === 1)
      buttons.append(
        action('View results', () =>
          send({ type: 'VIEW_RESULTS', id: operation.id }),
        ),
      );
    if (operation.batches.some((batch) => batch.state === 'blocked'))
      buttons.append(
        action('Resume after reconnecting', async () => {
          await send({ type: 'RESUME', id: operation.id });
          await refresh();
        }),
      );
    buttons.append(
      action(
        'Clear local record',
        async () => {
          if (
            confirm(
              'Remove local tracking and unsent text? Server jobs are not cancelled or deleted.',
            )
          ) {
            await send({ type: 'CLEAR_OPERATION', id: operation.id });
            await refresh();
          }
        },
        'btn btn-ghost btn-sm',
      ),
    );
    card.append(buttons);
    root.append(card);
  }
  if (!root.children.length)
    root.append(
      element('p', 'No imports yet.', 'text-sm text-base-content/60'),
    );
}
get('server').addEventListener('change', () => {
  void send({
    type: 'SELECT_SERVER',
    id: get<HTMLSelectElement>('server').value,
  })
    .then(refresh)
    .catch(report);
});
get('capture').addEventListener('click', async () => {
  try {
    if (dirty) throw new Error('Save or clear preview changes first.');
    const group = get<HTMLSelectElement>('group').value;
    if (!group) throw new Error('Choose a tab group.');
    await send({
      type: 'CAPTURE',
      groupId: Number(group),
      ...(get<HTMLSelectElement>('capture-rule').value
        ? { ruleId: get<HTMLSelectElement>('capture-rule').value }
        : {}),
    });
    await refresh();
  } catch (error) {
    report(error);
  }
});
get('refresh').addEventListener('click', () => {
  void groups().catch(report);
});
get('clear-previews').addEventListener('click', () => {
  if (confirm('Clear captured text and stop capture?'))
    void send({ type: 'CLEAR_PREVIEWS' })
      .then(() => {
        dirtyRows.clear();
        dirty = false;
        return refresh();
      })
      .catch(report);
});
get('submit').addEventListener('click', async () => {
  const button = get<HTMLButtonElement>('submit');
  button.disabled = true;
  try {
    if (
      !confirm(
        `Import the selected jobs to ${state.servers.find((row) => row.id === state.selectedServerId)?.origin}? This starts paid AI analysis on the server.`,
      )
    )
      return;
    await send({ type: 'SUBMIT' });
    previewSignature = '';
    await refresh();
  } catch (error) {
    report(error);
  } finally {
    await refresh();
  }
});
void Promise.all([groups(), refresh()]).catch(report);
// Only paints the open popup. Durable scheduling lives in chrome.alarms.
window.setInterval(() => {
  void refresh().catch(report);
}, 2000);
