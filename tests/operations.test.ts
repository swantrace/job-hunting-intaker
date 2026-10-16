import { expect, test } from 'bun:test';
import { ApiError } from '../src/api/client';
import { limits } from '../src/contracts/intake';
import {
  advance,
  finished,
  makeOperation,
  notificationId,
  totals,
} from '../src/queue/operations';
import {
  change,
  cleanup,
  initialState,
  publicState,
  readState,
} from '../src/storage/state';
import { fakeStorage, item, server, status } from './support';

test('splits captures into durable batches and unique retry identities before upload', () => {
  const operation = makeOperation(
    server,
    Array.from({ length: 41 }, (_, i) => item(i)),
  );
  expect(operation.batches.map((batch) => batch.itemCount)).toEqual([
    20, 20, 1,
  ]);
  expect(new Set(operation.batches.map((batch) => batch.id)).size).toBe(3);
  expect(
    new Set(
      operation.batches.flatMap((batch) =>
        batch.items.map((item) => item.clientItemId),
      ),
    ).size,
  ).toBe(41);
  expect(finished(operation)).toBe(false);
});
test('split boundary accounts for JSON bytes as well as item count', () => {
  const operation = makeOperation(server, [item(), item()], {
    schemaVersion: 1,
    authenticated: true,
    pollingIntervalSeconds: 30,
    limits: { ...limits, maxBodyBytes: 400 },
  });
  expect(operation.batches).toHaveLength(2);
});
test('lost acceptance response replays the same body/key; acceptance purges local text', async () => {
  const state = initialState();
  state.servers = [server];
  const operation = makeOperation(server, [item()]);
  state.operations = [operation];
  const stored = fakeStorage(state);
  const original = JSON.stringify(operation.batches[0].payload);
  const key = operation.batches[0].id;
  await advance(
    operation.id,
    key,
    async () => {
      throw new ApiError(0, 0, 'Synthetic network interruption');
    },
    100000,
  );
  expect(stored().operations[0].batches[0].state).toBe('pending');
  let submittedKey: string | undefined;
  await advance(
    operation.id,
    key,
    async (_server, _path, payload, id) => {
      submittedKey = id;
      expect(JSON.stringify(payload)).toBe(original);
      return { status: status(payload?.items ?? []), nextAt: 300000 };
    },
    Number.MAX_SAFE_INTEGER - 60000,
  );
  expect(submittedKey).toBe(key);
  expect(stored().operations[0].batches[0].payload).toBeUndefined();
  expect(stored().operations[0].batches[0].state).toBe('tracking');
  const accepted = stored().operations[0].batches[0];
  await advance(
    operation.id,
    key,
    async (_server, _path, payload) => {
      expect(payload).toBeUndefined();
      return {
        status: status(
          accepted.items.map((row) => ({
            ...item(),
            clientItemId: row.clientItemId,
          })),
          true,
        ),
        nextAt: 0,
      };
    },
    Number.MAX_SAFE_INTEGER,
  );
  expect(finished(stored().operations[0])).toBe(true);
  expect(totals(stored().operations[0]).decisions).toBe(2);
});
test('401 blocks for reconnect; 409 terminates instead of endless retry', async () => {
  for (const code of [401, 409]) {
    const state = initialState();
    state.servers = [server];
    const operation = makeOperation(server, [item()]);
    state.operations = [operation];
    fakeStorage(state);
    await advance(operation.id, operation.batches[0].id, async () => {
      throw new ApiError(code, 0, 'Synthetic error');
    });
    expect((await readState()).operations[0].batches[0].state).toBe(
      code === 401 ? 'blocked' : 'failed',
    );
  }
});
test('changing targets cannot retarget an already persisted operation', async () => {
  const state = initialState();
  const operation = makeOperation(server, [item()]);
  state.operations = [operation];
  state.servers = [{ ...server, origin: 'https://different.example.com' }];
  fakeStorage(state);
  let calls = 0;
  await advance(operation.id, operation.batches[0].id, async () => {
    calls++;
    throw new Error('Must never call another server');
  });
  expect(calls).toBe(0);
  expect((await readState()).operations[0].batches[0].state).toBe('blocked');
});
test('public UI/diagnostics never receive tokens or pending batch text; rules-only export is safe', () => {
  const state = initialState();
  state.servers = [server];
  state.operations = [makeOperation(server, [item()])];
  const serialized = JSON.stringify(publicState(state));
  expect(serialized).not.toContain(server.token);
  expect(serialized).not.toContain('Build safe web applications.');
  expect(
    JSON.stringify({ schemaVersion: 1, rules: state.rules }),
  ).not.toContain(server.token);
});
test('notifications are stable across restart and multi-batch completion waits for all batches', async () => {
  const operation = makeOperation(
    server,
    Array.from({ length: 21 }, (_, i) => item(i)),
  );
  operation.batches[0].state = 'done';
  expect(finished(operation)).toBe(false);
  operation.batches[1].state = 'done';
  expect(finished(operation)).toBe(true);
  expect(await notificationId(operation)).toBe(
    await notificationId(structuredClone(operation)),
  );
});
test('unconfirmed text expires and atomic storage updates do not lose concurrent changes', async () => {
  const state = initialState();
  const operation = makeOperation(server, [item()]);
  state.operations = [operation];
  fakeStorage(state);
  await Promise.all([
    change((state) => {
      state.notifications = true;
    }),
    change((state) => {
      state.selectedServerId = server.id;
    }),
  ]);
  expect((await readState()).notifications).toBe(true);
  expect((await readState()).selectedServerId).toBe(server.id);
  cleanup(state, operation.createdAt + 86400001);
  expect(state.operations[0].batches[0].payload).toBeUndefined();
  expect(state.operations[0].batches[0].state).toBe('failed');
});

test('five transient failures pause instead of retrying forever, preserving the retry payload', async () => {
  const state = initialState();
  state.servers = [server];
  const operation = makeOperation(server, [item()]);
  state.operations = [operation];
  fakeStorage(state);
  let now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    await advance(
      operation.id,
      operation.batches[0].id,
      async () => {
        throw new ApiError(503, 0, 'Synthetic unavailable');
      },
      now,
    );
    now = (await readState()).operations[0].batches[0].nextAt + 1;
  }
  const batch = (await readState()).operations[0].batches[0];
  expect(batch.state).toBe('blocked');
  expect(batch.attempts).toBe(5);
  expect(batch.payload).toBeDefined();
});

test('storage quota rejection never partially overwrites durable state', async () => {
  const stored = fakeStorage();
  await expect(
    change((state) => {
      state.previews.push({
        id: crypto.randomUUID(),
        tabId: 1,
        groupId: 1,
        url: 'https://example.com/job',
        title: 'Synthetic',
        createdAt: Date.now(),
        checked: true,
        warnings: [],
        item: { ...item(), rawText: 'x'.repeat(9 * 1024 * 1024) },
      });
    }),
  ).rejects.toThrow('storage is full');
  expect(stored().previews).toHaveLength(0);
});
