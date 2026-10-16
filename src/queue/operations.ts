import { ApiError, batchRequest, retryAt, type Server } from '../api/client';
import {
  type BatchPayload,
  type Capabilities,
  type CaptureItem,
  itemSchema,
  limits,
} from '../contracts/intake';
import {
  change,
  type Operation,
  type PendingBatch,
  readState,
  type State,
} from '../storage/state';

export function makeOperation(
  server: Server,
  items: CaptureItem[],
  capabilities?: Capabilities,
): Operation {
  if (!items.length) throw new Error('Select at least one valid job.');
  const cap = capabilities?.limits ?? limits;
  const batches: PendingBatch[] = [];
  let payload: BatchPayload = {
    schemaVersion: 1,
    clientBatchId: crypto.randomUUID(),
    items: [],
  };
  const finish = () => {
    if (payload.items.length)
      batches.push({
        id: crypto.randomUUID(),
        payload,
        items: payload.items.map((item) => ({
          clientItemId: item.clientItemId,
          title: item.suggestedMetadata?.jobTitle ?? 'Captured job',
          url: item.sourceUrl,
        })),
        itemCount: payload.items.length,
        state: 'pending',
        attempts: 0,
        nextAt: 0,
      });
    payload = {
      schemaVersion: 1,
      clientBatchId: crypto.randomUUID(),
      items: [],
    };
  };
  for (const value of items) {
    const item = itemSchema.parse({
      ...value,
      clientItemId: crypto.randomUUID(),
    });
    if (
      item.rawText.length > cap.maxTextCharacters ||
      new TextEncoder().encode(item.rawText).length > cap.maxTextBytes
    )
      throw new Error('Job text exceeds this server’s limits.');
    const bytes = (entries: CaptureItem[]) =>
      new TextEncoder().encode(JSON.stringify({ ...payload, items: entries }))
        .length;
    if (
      payload.items.length >= cap.maxItems ||
      bytes([...payload.items, item]) > cap.maxBodyBytes
    )
      finish();
    if (bytes([item]) > cap.maxBodyBytes)
      throw new Error('One captured job exceeds the request limit.');
    payload.items.push(item);
  }
  finish();
  return {
    id: crypto.randomUUID(),
    serverId: server.id,
    origin: server.origin,
    createdAt: Date.now(),
    batches,
    notified: false,
    seen: false,
  };
}
export const finished = (operation: Operation) =>
  operation.batches.every(
    (batch) => batch.state === 'done' || batch.state === 'failed',
  );
export function totals(operation: Operation) {
  const sum = {
    completed: 0,
    duplicate: 0,
    failed: 0,
    rejected: 0,
    decisions: 0,
  };
  for (const batch of operation.batches) {
    if (batch.state === 'failed') {
      sum.failed += batch.itemCount;
      continue;
    }
    for (const key of ['completed', 'duplicate', 'failed', 'rejected'] as const)
      sum[key] += batch.status?.counts[key] ?? 0;
    sum.decisions += batch.status?.decisionCount ?? 0;
  }
  return sum;
}
export type BatchClient = typeof batchRequest;
/** One network round trip per persisted batch per pass. No timer-based worker loop. */
export async function advance(
  operationId: string,
  batchId: string,
  client: BatchClient = batchRequest,
  now = Date.now(),
) {
  const state = await readState();
  const operation = state.operations.find((row) => row.id === operationId);
  const batch = operation?.batches.find((row) => row.id === batchId);
  if (
    !operation ||
    !batch ||
    !['pending', 'tracking'].includes(batch.state) ||
    batch.nextAt > now
  )
    return;
  const server = state.servers.find(
    (row) => row.id === operation.serverId && row.origin === operation.origin,
  );
  if (!server)
    return change((state) => {
      const stored = find(state, operationId, batchId);
      stored.state = 'blocked';
      stored.error =
        'Original server configuration is missing. Restore it in Settings.';
    });
  try {
    const response = await client(
      server,
      batch.status?.statusUrl ?? '/api/v1/job-intake/batches',
      batch.payload,
      batch.payload ? batch.id : undefined,
    );
    if (batch.status && response.status.batchId !== batch.status.batchId)
      throw new ApiError(
        502,
        retryAt(null, 0),
        'Status response changed batch identity.',
      );
    await change((state) => {
      const stored = find(state, operationId, batchId);
      stored.status = response.status;
      stored.state = response.status.isTerminal ? 'done' : 'tracking';
      stored.nextAt = Math.max(
        response.nextAt,
        now +
          (state.capabilities[server.id]?.pollingIntervalSeconds ?? 30) * 1000,
      );
      stored.attempts = 0;
      delete stored.error;
      delete stored.payload;
    });
  } catch (error) {
    await change((state) => {
      const stored = find(state, operationId, batchId);
      stored.attempts++;
      const status = error instanceof ApiError ? error.status : 0;
      const permanent = [400, 404, 409, 413, 422].includes(status);
      stored.state = permanent
        ? 'failed'
        : [401, 403].includes(status) || stored.attempts >= 5
          ? 'blocked'
          : stored.state;
      stored.error =
        error instanceof ApiError
          ? error.message
          : 'Connection unavailable. Retry from the saved operation.';
      stored.nextAt = Math.max(
        error instanceof ApiError ? error.retryAt : 0,
        retryAt(null, stored.attempts, now),
      );
    });
  }
}
function find(state: State, operationId: string, batchId: string) {
  const row = state.operations
    .find((row) => row.id === operationId)
    ?.batches.find((row) => row.id === batchId);
  if (!row) throw new Error('Operation was removed.');
  return row;
}
export async function notificationId(operation: Operation) {
  const signature = operation.batches
    .map((batch) => batch.status?.terminalRevision ?? `${batch.id}:failed`)
    .join('|');
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(signature),
  );
  return `job-intake-${operation.id}-${Array.from(new Uint8Array(hash))
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')}`;
}
