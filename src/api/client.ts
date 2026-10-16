import {
  type BatchPayload,
  batchStatusSchema,
  capabilitiesSchema,
} from '../contracts/intake';

export function normalizeOrigin(value: string) {
  const url = new URL(value.trim());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      ))
  )
    throw new Error(
      'Use an HTTPS origin, or HTTP localhost/127.0.0.1 for development.',
    );
  return url.origin;
}
export function hostPermission(url: string) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
export function safeAppLink(
  origin: string,
  path: string,
  kind: 'status' | 'review' = 'review',
) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Invalid server link.');
  const url = new URL(path, normalizeOrigin(origin));
  const allowed =
    kind === 'status'
      ? /^\/api\/v1\/job-intake\/batches\/\d+$/
      : /^\/applications(?:\/import|\/\d+\/workspace)?$/;
  if (
    url.origin !== origin ||
    !allowed.test(url.pathname) ||
    url.username ||
    url.password
  )
    throw new Error('Server returned an unsafe link.');
  return url.href;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAt: number,
    message: string,
  ) {
    super(message);
  }
}
export function retryAt(
  header: string | null,
  attempt: number,
  now = Date.now(),
) {
  const delay = header
    ? Number.isFinite(Number(header))
      ? Number(header) * 1000
      : Date.parse(header) - now
    : NaN;
  return (
    now +
    (Number.isFinite(delay)
      ? Math.max(30000, delay)
      : Math.min(900000, 30000 * 2 ** attempt) +
        Math.floor(Math.random() * 1000))
  );
}
export type Server = {
  id: string;
  label: string;
  origin: string;
  token: string;
};
export async function request(
  server: Server,
  path: string,
  payload?: BatchPayload,
  key?: string,
) {
  const url =
    path === '/api/v1/job-intake/capabilities' ||
    path === '/api/v1/job-intake/batches'
      ? new URL(path, normalizeOrigin(server.origin)).href
      : safeAppLink(server.origin, path, 'status');
  let response: Response;
  try {
    response = await fetch(url, {
      method: payload ? 'POST' : 'GET',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${server.token}`,
        ...(payload
          ? { 'Content-Type': 'application/json', 'Idempotency-Key': key ?? '' }
          : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch {
    throw new ApiError(
      0,
      retryAt(null, 0),
      'Network request failed or timed out. The same submission will be retried safely.',
    );
  }
  if (Number(response.headers.get('Content-Length') ?? 0) > 1000000)
    throw new ApiError(
      502,
      retryAt(null, 0),
      'API response exceeds the size limit.',
    );
  const raw = await response.text();
  if (raw.length > 1000000)
    throw new ApiError(
      502,
      retryAt(null, 0),
      'API response exceeds the size limit.',
    );
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ApiError(
      502,
      retryAt(null, 0),
      'Expected JSON from the intake API. Check the server URL.',
    );
  }
  if (
    (!response.ok && response.status !== 422) ||
    (response.status === 422 && !batchStatusSchema.safeParse(body).success)
  ) {
    const message =
      response.status === 401 || response.status === 403
        ? 'Reconnect: check the intake API token in Settings.'
        : response.status === 409
          ? 'Submission identity conflict. Clear this operation and explicitly create a new import.'
          : response.status === 422
            ? 'The server rejected the submission contract.'
            : `Intake API returned HTTP ${response.status}.`;
    throw new ApiError(
      response.status,
      retryAt(response.headers.get('Retry-After'), 0),
      message,
    );
  }
  return { body, nextAt: retryAt(response.headers.get('Retry-After'), 0) };
}
export async function capabilities(server: Server) {
  return capabilitiesSchema.parse(
    (await request(server, '/api/v1/job-intake/capabilities')).body,
  );
}
export async function batchRequest(
  server: Server,
  path: string,
  payload?: BatchPayload,
  key?: string,
) {
  const response = await request(server, path, payload, key);
  const parsed = batchStatusSchema.safeParse(response.body);
  if (!parsed.success)
    throw new ApiError(
      502,
      retryAt(null, 0),
      'Invalid batch status returned by server.',
    );
  const status = parsed.data;
  safeAppLink(server.origin, status.statusUrl, 'status');
  safeAppLink(server.origin, status.reviewUrl);
  if (status.statusUrl !== `/api/v1/job-intake/batches/${status.batchId}`)
    throw new ApiError(502, retryAt(null, 0), 'Batch identity mismatch.');
  for (const item of status.items)
    if (item.applicationUrl) safeAppLink(server.origin, item.applicationUrl);
  if (
    payload &&
    (status.items.length !== payload.items.length ||
      status.items.some(
        (item) =>
          !payload.items.some(
            (sent) => sent.clientItemId === item.clientItemId,
          ),
      ))
  )
    throw new ApiError(
      502,
      retryAt(null, 0),
      'Server response does not match the submitted items.',
    );
  return { status, nextAt: response.nextAt };
}
