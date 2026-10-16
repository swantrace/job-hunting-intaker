import type { Server } from '../api/client';
import type {
  BatchPayload,
  BatchStatus,
  Capabilities,
  CaptureItem,
} from '../contracts/intake';
import { starterRules } from '../rules/defaults';
import type { SiteRule } from '../rules/schema';

export type Preview = {
  id: string;
  groupId: number;
  tabId: number;
  tabClosed?: boolean;
  url: string;
  title: string;
  createdAt: number;
  checked: boolean;
  ruleId?: string;
  item?: CaptureItem;
  error?: string;
  warnings: string[];
  diagnostics?: Record<string, string>;
};
export type PendingBatch = {
  id: string;
  payload?: BatchPayload;
  items: { clientItemId: string; title: string; url: string }[];
  state: 'pending' | 'tracking' | 'blocked' | 'failed' | 'done';
  status?: BatchStatus;
  itemCount: number;
  attempts: number;
  nextAt: number;
  error?: string;
};
export type Operation = {
  id: string;
  serverId: string;
  origin: string;
  createdAt: number;
  batches: PendingBatch[];
  notified: boolean;
  seen: boolean;
  notificationId?: string;
};
export type State = {
  version: 1;
  servers: Server[];
  selectedServerId?: string;
  capabilities: Record<string, Capabilities>;
  rules: SiteRule[];
  previews: Preview[];
  captureError?: string;
  capture?: {
    id: string;
    groupId: number;
    tabIds: number[];
    index: number;
    ruleId?: string;
    startedAt: number;
  };
  operations: Operation[];
  notifications: boolean;
};
export const initialState = (): State => ({
  version: 1,
  servers: [
    {
      id: '8c79f970-eac3-47df-92af-369d7cd56619',
      label: 'Production',
      origin: 'https://job-hunting.fly.dev',
      token: '',
    },
  ],
  selectedServerId: '8c79f970-eac3-47df-92af-369d7cd56619',
  capabilities: {},
  rules: structuredClone(starterRules),
  previews: [],
  operations: [],
  notifications: false,
});
const key = 'jobIntake.v1';
let tail: Promise<unknown> = Promise.resolve();
export async function readState(): Promise<State> {
  return (
    ((await chrome.storage.local.get(key))[key] as State | undefined) ??
    initialState()
  );
}
/** One writer: options/popup send messages, never mutate durable state directly. */
export function change<T>(
  action: (state: State) => T | Promise<T>,
): Promise<T> {
  const work = tail.then(async () => {
    const state = await readState();
    const result = await action(state);
    if (
      new TextEncoder().encode(JSON.stringify(state)).length >
      8 * 1024 * 1024
    )
      throw new Error(
        'Local capture storage is full. Clear previews or old operations.',
      );
    await chrome.storage.local.set({ [key]: state });
    return result;
  });
  tail = work.catch(() => undefined);
  return work;
}
export function publicState(state: State) {
  return {
    ...state,
    servers: state.servers.map(({ token, ...server }) => ({
      ...server,
      hasToken: !!token,
    })),
    operations: state.operations.map((operation) => ({
      ...operation,
      batches: operation.batches.map(({ payload, ...batch }) => ({
        ...batch,
        hasPendingText: !!payload,
      })),
    })),
  };
}
export function cleanup(state: State, now = Date.now()) {
  for (const operation of state.operations)
    if (now - operation.createdAt > 86400000)
      for (const batch of operation.batches)
        if (batch.payload) {
          delete batch.payload;
          batch.state = 'failed';
          batch.error =
            'Unconfirmed submission text expired after 24 hours. Capture again if needed.';
        }
  state.previews = state.previews.filter(
    (row) => now - row.createdAt < 86400000,
  );
  if (state.capture && now - state.capture.startedAt > 1800000) {
    state.capture = undefined;
  }
}
