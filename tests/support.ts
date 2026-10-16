import type { CaptureItem } from '../src/contracts/intake';
import { initialState, type State } from '../src/storage/state';
export function fakeStorage(initial: State = initialState()) {
  let stored = structuredClone(initial);
  globalThis.chrome = {
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
    },
    storage: {
      local: {
        get: async () => ({ 'jobIntake.v1': structuredClone(stored) }),
        set: async (value: Record<string, State>) => {
          stored = structuredClone(value['jobIntake.v1']);
        },
      },
    },
  } as unknown as typeof chrome;
  return () => structuredClone(stored);
}
export const server = {
  id: crypto.randomUUID(),
  label: 'Synthetic',
  origin: 'https://tracker.example.com',
  token: 'synthetic-test-token-only',
};
export const item = (index = 1) => ({
  clientItemId: crypto.randomUUID(),
  sourceUrl: `https://jobs.example.com/${index}`,
  rawText: 'Build safe web applications.',
  suggestedMetadata: { jobTitle: `Engineer ${index}`, postedDate: null },
});
export function status(items: CaptureItem[], isTerminal = false) {
  return {
    schemaVersion: 1 as const,
    batchId: 1,
    revision: isTerminal ? 2 : 1,
    status: isTerminal ? ('completed' as const) : ('processing' as const),
    isTerminal,
    terminalRevision: isTerminal ? 'stable-event-id' : null,
    total: items.length,
    counts: {
      accepted: isTerminal ? 0 : items.length,
      queued: 0,
      processing: 0,
      completed: isTerminal ? items.length : 0,
      duplicate: 0,
      failed: 0,
      rejected: 0,
    },
    decisionCount: isTerminal ? 2 : 0,
    statusUrl: '/api/v1/job-intake/batches/1',
    reviewUrl: '/applications/import?batchId=1',
    items: items.map((item) => ({
      clientItemId: item.clientItemId,
      itemId: 1,
      status: isTerminal ? ('completed' as const) : ('accepted' as const),
      stage: isTerminal ? 'done' : 'intake',
      applicationUrl: '/applications/1/workspace?workspaceTab=review',
      decisionCount: isTerminal ? 2 : 0,
      error: null,
    })),
  };
}
