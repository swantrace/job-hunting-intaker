import { expect, test } from 'bun:test';
import { closePreviewTab } from '../src/storage/close-preview-tab';
import { initialState } from '../src/storage/state';
import { fakeStorage, item } from './support';

function setup({
  missing = false,
  navigated = false,
  matches = 0,
  capturing = false,
  removeFails = false,
} = {}) {
  const state = initialState();
  const captured = item();
  const id = crypto.randomUUID();
  state.previews = [
    {
      id,
      tabId: 42,
      groupId: 1,
      url: captured.sourceUrl,
      title: 'Engineer',
      createdAt: Date.now(),
      checked: true,
      item: captured,
      warnings: [],
    },
  ];
  if (capturing)
    state.capture = {
      id: crypto.randomUUID(),
      groupId: 1,
      tabIds: [42],
      index: 0,
      startedAt: Date.now(),
    };
  const read = fakeStorage(state);
  const removed: number[] = [];
  globalThis.chrome.tabs = {
    get: async () => {
      if (missing) throw new Error('No tab with id: 42');
      return {
        id: 42,
        url: navigated ? 'https://other.example.com' : captured.sourceUrl,
      };
    },
    query: async () =>
      Array.from({ length: matches }, (_, i) => ({
        id: 84 + i,
        url: captured.sourceUrl,
      })),
    remove: async (tabId: number) => {
      if (removeFails) throw new Error('Close failed');
      removed.push(tabId);
    },
  } as unknown as typeof chrome.tabs;
  return { id, read, removed, captured };
}

test('closing a preview tab retains captured text, selection, and preview metadata', async () => {
  const context = setup();
  await closePreviewTab(context.id);
  expect(context.removed).toEqual([42]);
  expect(context.read().previews[0]).toMatchObject({
    tabClosed: true,
    checked: true,
    item: context.captured,
  });
  await closePreviewTab(context.id);
  expect(context.removed).toEqual([42]);
});

test('a missing old ID closes only a unique same-URL replacement in the original group', async () => {
  const context = setup({ missing: true, matches: 1 });
  await closePreviewTab(context.id);
  expect(context.removed).toEqual([84]);
});

test('a navigated tab is never closed', async () => {
  const context = setup({ navigated: true });
  await expect(closePreviewTab(context.id)).rejects.toThrow('navigated');
  expect(context.removed).toEqual([]);
  expect(context.read().previews[0].tabClosed).toBeUndefined();
});

test('ambiguous replacement tabs are not closed', async () => {
  const context = setup({ missing: true, matches: 2 });
  await expect(closePreviewTab(context.id)).rejects.toThrow('Multiple tabs');
  expect(context.removed).toEqual([]);
});

test('an already-missing tab is marked closed without deleting the preview', async () => {
  const context = setup({ missing: true });
  await closePreviewTab(context.id);
  expect(context.removed).toEqual([]);
  expect(context.read().previews[0].tabClosed).toBe(true);
});

test('capture-in-progress, unknown preview IDs, and failed closes leave state unchanged', async () => {
  let context = setup({ capturing: true });
  await expect(closePreviewTab(context.id)).rejects.toThrow(
    'capture to finish',
  );
  expect(context.removed).toEqual([]);
  context = setup();
  await expect(closePreviewTab(crypto.randomUUID())).rejects.toThrow(
    'Preview not found',
  );
  expect(context.removed).toEqual([]);
  context = setup({ removeFails: true });
  await expect(closePreviewTab(context.id)).rejects.toThrow('Close failed');
  expect(context.read().previews[0].tabClosed).toBeUndefined();
});
