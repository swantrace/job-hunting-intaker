import { expect, test } from 'bun:test';
import fixture from '../docs/fixtures/job-intake-batch.json';
import {
  ApiError,
  batchRequest,
  capabilities,
  normalizeOrigin,
  retryAt,
  safeAppLink,
} from '../src/api/client';
import {
  batchStatusSchema,
  capabilitiesSchema,
  itemSchema,
} from '../src/contracts/intake';
import { item, server, status } from './support';

test('published backend fixture is accepted without importing backend business logic', () => {
  expect(itemSchema.safeParse(fixture.items[0]).success).toBe(true);
});
test('rejects malformed URLs, dates, forged fields and Unicode byte overflow', () => {
  for (const value of [
    { ...item(), sourceUrl: 'javascript:alert(1)' },
    { ...item(), sourceUrl: 'https://user:secret@example.com' },
    { ...item(), suggestedMetadata: { postedDate: '2026-02-30' } },
    { ...item(), status: 'Applied' },
    { ...item(), rawText: '😀'.repeat(40000) },
  ])
    expect(itemSchema.safeParse(value).success).toBe(false);
});
test('candidate completion, not pending user decisions, defines terminal status', () => {
  const items = [item()];
  expect(batchStatusSchema.parse(status(items, true)).isTerminal).toBe(true);
  expect(
    batchStatusSchema.safeParse({ ...status(items), isTerminal: true }).success,
  ).toBe(false);
  expect(
    batchStatusSchema.safeParse({
      ...status(items, true),
      terminalRevision: null,
    }).success,
  ).toBe(false);
});
test('API targets and server links cannot leak a bearer token or open arbitrary origins', () => {
  expect(normalizeOrigin('http://localhost:5173/')).toBe(
    'http://localhost:5173',
  );
  for (const origin of [
    'http://192.168.1.2:5173',
    'https://user:password@site.com',
    'https://site.com/path',
    'file:///tmp/foo',
    'https://site.com/?x=1',
  ])
    expect(() => normalizeOrigin(origin)).toThrow();
  for (const path of [
    'https://evil.test/applications',
    '//evil.test/applications',
    '/auth/google/start',
    '/applications/../export',
  ])
    expect(() => safeAppLink(server.origin, path)).toThrow();
  expect(
    safeAppLink(server.origin, '/applications/1/workspace?workspaceTab=review'),
  ).toBe(`${server.origin}/applications/1/workspace?workspaceTab=review`);
});
test('Retry-After is honored, including HTTP dates', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');
  expect(retryAt('90', 0, now)).toBe(now + 90000);
  expect(retryAt('Fri, 16 Oct 2026 00:02:00 GMT', 0, now)).toBe(now + 120000);
});
test('capabilities are bounded by this fixed v1 contract', () => {
  expect(
    capabilitiesSchema.safeParse({ schemaVersion: 2, authenticated: true })
      .success,
  ).toBe(false);
});
test('worker fetch omits website credentials, disallows redirects, handles all-rejected 422', async () => {
  const original = globalThis.fetch;
  try {
    let captured: RequestInit | undefined;
    globalThis.fetch = (async (_url, init) => {
      captured = init;
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
    }) as typeof fetch;
    expect((await capabilities(server)).repeatImportBehavior).toBe(
      'refresh-analysis',
    );
    expect(captured?.credentials).toBe('omit');
    expect(captured?.redirect).toBe('error');
    expect(new Headers(captured?.headers).get('Authorization')).toBe(
      `Bearer ${server.token}`,
    );
    const sent = [item()];
    const response = status(sent, true);
    response.status = 'completed-with-errors' as typeof response.status;
    response.counts.completed = 0;
    response.counts.rejected = 1;
    response.items[0].status =
      'rejected' as (typeof response.items)[0]['status'];
    globalThis.fetch = (async () =>
      Response.json(response, { status: 422 })) as unknown as typeof fetch;
    expect(
      (
        await batchRequest(
          server,
          '/api/v1/job-intake/batches',
          { schemaVersion: 1, clientBatchId: crypto.randomUUID(), items: sent },
          crypto.randomUUID(),
        )
      ).status.isTerminal,
    ).toBe(true);
    globalThis.fetch = (async () =>
      Response.json(
        { error: { code: 'unauthorized' } },
        { status: 401 },
      )) as unknown as typeof fetch;
    await expect(capabilities(server)).rejects.toBeInstanceOf(ApiError);
  } finally {
    globalThis.fetch = original;
  }
});
