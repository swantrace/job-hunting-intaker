# Chrome Extension: Grouped Job Capture Plan

Updated: 2026-10-16. Implemented in the separate job-hunting-intaker repository.
Companion: [job-intake-api-plan.md](job-intake-api-plan.md).
Consume the pinned v1 OpenAPI and fixtures; do not infer backend database structures.

## 1. Scope and journey

1. Configure local/production app origin and dedicated intake Bearer token; test the connection.
2. Select a Tab Group in the current window and capture its already-open jobs.
3. Preview title/company/URL/body completeness and extraction warnings/errors.
4. Explicitly import selected jobs, splitting into bounded batches.
5. Close the popup if desired; the worker persists retry/polling progress.
6. Notify once all child batches finish Candidate Analysis.
7. Open app Review for Include/Skip, then explicitly generate documents.

No OpenAI calls/model keys, personal career data ownership, automatic documents, or job applications.
Do not visit unrelated tabs, bypass login/CAPTCHA, or crawl websites.

## 2. Structure

Use Manifest V3, TypeScript, Bun tooling, native browser APIs, HTML, Tailwind, and daisyUI.
No hydration framework or server is needed.

```text
src/
  background.ts    # Trusted messages, capture, operations, alarms
  contracts/       # Fixed API validation
  extraction/      # DOM and JobPosting JSON-LD
  rules/           # Rule schemas, matching, URL policies
  api/             # Authenticated worker requests/retries
  storage/         # Settings and resumable operation state
  popup/           # Capture, previews, import, results
  options/         # Server and website rule editors
tests/             # Synthetic fixtures and security/contract tests
scripts/           # Build and real-browser smoke checks
```

Keep modules responsibility-focused; do not copy backend business logic or create a generic crawler framework.

## 3. Permissions and trust

Request only needed tabs/tabGroups/scripting/storage/alarms and optional notifications.
activeTab does not grant group-wide access. Request optional host permissions per configured website/API origin.
Do not grant all website access by default.
Restrict local storage to TRUSTED_CONTEXTS. Never sync/export/log tokens.
Validate privileged message senders/frame/tab context; extracted pages return data only.
Pages cannot choose credentialed API origins or headers.
Treat DOM/JSON-LD/URLs/server links as untrusted.
Production uses HTTPS; local HTTP only localhost/127.0.0.1, without certificate bypass.
Rule exports exclude tokens, captured bodies, operations, and browsing history.

## 4. Website rules

Editable/importable/exportable JSON supports Add/Edit/Save/Cancel.
Bundled examples must not overwrite custom edits; selectors need real-layout verification.

| Setting | Purpose |
| --- | --- |
| id/version/label/enabled | Stable rule identity and revision |
| hostnames/path pattern | Bounded matching with * wildcard |
| rootSelectors | Current job, excluding recommendations |
| field selectors | rawText, title, company, location, postedDate, salary |
| read mode | Text/innerText or allowed attribute |
| ordered fallbacks | First valid result, not concatenated unrelated jobs |
| source preference | Per-field JSON-LD/CSS priority |
| applicationSource | Free-text site label |
| providerJobId | Query/path/attribute tied to current job |
| identity policy | Query retention/removal and fragment behavior |

Ambiguous rule matches require selection, not a random winner.
Allow bounded trimming/whitespace/paragraph normalization and supported date parsing.
No eval, custom JavaScript, remote scripts, arbitrary clicks, or unbounded transformations.
Invalid/ambiguous selectors produce field errors. Select an unambiguous enclosing element or first match explicitly.
Unknown dates are null, never capture date. Missing URL/body blocks submission; title/company may be resolved later.

Test extraction shows rule/root, adopted values/sources, fallback use, warnings, and full body preview.
Allow manual body paste and per-item recapture after rule correction.
Attention/error/warning summaries stay visible without expanding previews.
Provide settings navigation back to capture.

### Dynamic and structured content

Match JobPosting JSON-LD arrays/@graph to the current URL/ID, not the first object.
Convert description HTML safely to text, retaining paragraphs and bullets.
Exclude scripts, navigation, recommended jobs, account details, and messages.
Wait only a bounded time for explicit capture; no long unconditional sleep.
Ask users to expand truncated text; do not auto-click arbitrary controls.
Compare URL/job identity before/after SPA capture; discard mismatches.
Report unsupported iframe/shadow layouts clearly.

## 5. Identity and repeated imports

Require sourceUrl and preserve it separately from canonical identity.
Provider IDs identify the actual job, not a list/container; server validates namespace and recomputes identity.

```json
{
  "version": 1,
  "queryMode": "keep-listed",
  "queryParams": ["jobId"],
  "dropQueryParams": ["utm_source"],
  "fragmentMode": "drop"
}
```

keep-all is default; use keep-listed only with known required parameters.
Match names exactly and reject overlapping lists. Preserve repeated values/hash routes unless explicitly configured otherwise.
Do not silently alter host, protocol, path case, or slash semantics.
Show effective policy and diagnostic canonical URL/ID without replacing sourceUrl.
Rule version is provenance, not identity. Backend uniqueness is authoritative.
Never merge cross-site jobs merely by company/title.

A new explicit import refreshes existing analysis while preserving edits/status/history/artifacts.
Unchanged body may reuse Job Analysis and rerun Candidate; changed body creates a posting version and runs both.
Explain possible model usage/cost before resubmission.
Same HTTP key/payload retry does not repeat paid work.

## 6. Request contract and durable submission

POST /api/v1/job-intake/batches with Bearer token and Idempotency-Key.
Required: schemaVersion=1, clientBatchId, item clientItemId/sourceUrl/rawText.
Optional: applicationSource, suggestedMetadata, capture, identity.
Never submit model keys, status/priority, internal IDs, or personal skill claims.

| Limit | Value |
| --- | --- |
| Items | 20 per batch |
| Body | 4 MiB |
| Raw text | 60,000 characters and 128 KiB UTF-8 |
| URL | 2048 characters |
| Title/company/location | 200 each |
| Salary | 500 characters, free text |
| Application source | 150 characters |

Respect tighter advertised capabilities. Empty optional values are null/omitted, not "null".
Salary extraction, preview textarea, worker messages, and request validation share the 500-character limit; never truncate silently.
Persist operation/server binding, child IDs/keys, item IDs, and exact payloads before sending.
Restarts retain retry keys. Editing submitted data creates a new operation/key.
Split batches and bound upload concurrency separately from model concurrency.

- 200/202: persist status/review links and item results.
- 422: distinguish invalid envelope from queryable all-rejected batch.
- 409: stop conflicting retries and explain the issue.
- 401/403: stop and request corrected credentials.
- Network/retryable 5xx/429: bounded backoff, Retry-After, same key/payload.
- Timeout does not prove rejection. One bad extraction must not block valid siblings.
- Only open allowed paths on the configured app origin.
- After acknowledgement, remove local bodies; retain batch tracking IDs/status.
- Allow explicit clearing of unsent previews and completed operations.

## 7. Background progress and notification

Use chrome.alarms and persisted local state, not popup timers.
Register listeners at module scope; recover operations and missing alarms on startup/install/popup activity.
Poll server revision/isTerminal/terminalRevision.
completed means Candidate finished, even with pending Include/Skip decisions.
completed/failed/rejected/legacy duplicate are terminal for this import.
Use supported 30-60-second polling and backoff, without exact timing promises.
Summarize once all child batches terminate, including partial failures.
Show completed/failure/rejected/legacy duplicate counts and pending decisions, not private job bodies.
Expose every relevant result rather than linking only the last batch.
Stable operation/terminal-revision notification IDs plus persisted delivery state avoid stacked duplicates.
Do not promise exactly-once sound after crashes.
Ask notification permission explicitly; denial preserves badge/progress/View results.
Browser/OS shutdown can delay notifications; resume later.
No Web Push/FCM/notification server/permanent connection is required.

## 8. UX and server profiles

Separate local/production origins, credentials, and permissions.
Bind operations to the original server; switching profiles cannot redirect old work or leak tokens.
Use labels, keyboard support, focus, loading indicators, and text errors, not color alone.
Keep attention badges visible in collapsed previews.
Flow: Group -> Capture -> Preview -> Import -> Progress/results.
Use app links for skill/evidence management, not duplicate personal-data editors.

## 9. Delivery and verification

| Stage | Deliverable | Acceptance |
| --- | --- | --- |
| 1 | MV3/TS/build/tests/fixtures | Unpacked extension loads |
| 2 | Profiles/token/permissions/test connection | Credential isolation and clear errors |
| 3 | Rule CRUD/import/export/extraction testing | Safe selectors and URL policies |
| 4 | Group capture and previews | SPA safety, structured text, per-tab errors |
| 5 | Split submission and durable retry | Idempotency, limits, recovery |
| 6 | Alarms/badge/notifications | Popup-independent tracking, stable IDs |
| 7 | English setup/privacy docs and integration checks | Synthetic browser verification |

Test JSON-LD arrays/@graph/multiple jobs, HTML conversion, missing/ambiguous selectors, fallbacks,
truncation, unrelated content, SPA changes, unsupported frames, required/repeated query/hash parameters,
rule changes, null/date/URL/byte boundaries, salary 500/501, auth/conflict/throttle/partial failures.
Mock permissions/alarms/storage/notifications, hostile senders, restarts, server switching, and lost responses.
Run real Chromium smoke checks for capture, long salary edits, submission, tracking, and recovery.
Do not commit logged-in HTML, credentials, private captures, generated bundles, or dependencies.

## 10. Official references

- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Tab groups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)
- [Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
- [Storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
