# Extension intake API v1

The Chrome extension belongs in a separate repository. This app accepts captured
job text; it does not visit the supplied URLs. The extension owns extraction,
website selectors, polling, and browser notifications.

Machine-readable contract: [OpenAPI](job-intake-api.openapi.json).
Synthetic request: [batch fixture](fixtures/job-intake-batch.json).
The schema source is `src/lib/job-intake/openapi.ts`; keep the published JSON in
sync when changing the contract. API `schemaVersion: 1` is independent of the
portable backup format version.

## Configure and start

Upgrade note: run migrations through `0032_skill_decision_basis` before starting
this version. It preserves decisions and adds decision provenance; no career
facts or generated files are deleted. Candidate results from the earlier review
policy become stale. Re-capture/import a group to refresh candidates in bulk;
unchanged jobs reuse the compatible completed Job Analysis. Reconfirm historical
decisions if their saved basis cannot be verified. No automatic document upload.

1. Back up `jobs.db`, then run `bun run db:migrate`. Migration 0031 preserves
   existing applications and children, adds intake tracking, and allows unknown
   posted dates. Existing duplicates are retained rather than silently merged.
2. Complete Career Data onboarding in the browser: candidate facts and at least
   one active direction are needed. Unknown skills need no prior approval.
3. Generate a dedicated secret with `openssl rand -hex 32`, and place it in local
   `.env` as `JOB_INTAKE_API_TOKEN=...`. Keep it separate from website credentials
   and OpenAI credentials. Empty disables the API. Restart after changing it.
4. Set `OPENAI_API_KEY` and optionally `OPENAI_MAX_CONCURRENT_REQUESTS=3`.
5. Run `bun run dev` locally, or deploy normally after configuring production
   secrets. For Fly, use `fly secrets set --app <app> JOB_INTAKE_API_TOKEN='<token>'`.
   Persist **both** `DB_FILE_NAME` and `QUEUE_FILE_NAME` on the existing volume.

Do not expose an unauthenticated development website to the Internet. Production
must use HTTPS. The extension should allow HTTP only for explicitly configured
loopback development hosts. Store the token in extension-owned storage and make
requests from its service worker, never inject the secret into a webpage.
Extension `host_permissions` cover the app origin; arbitrary web-origin CORS is
intentionally not enabled. Website Basic Auth/CSRF remain enabled independently.
Rotating the dedicated secret revokes the previous extension credential.

## Connect, submit, poll

Use an environment variable to avoid putting credentials in saved command text:

```sh
export JOB_TRACKER_URL=http://localhost:5173
# Set JOB_INTAKE_API_TOKEN in this terminal without committing its value.
curl --fail-with-body "$JOB_TRACKER_URL/api/v1/job-intake/capabilities" \
  -H "Authorization: Bearer $JOB_INTAKE_API_TOKEN"

curl --fail-with-body "$JOB_TRACKER_URL/api/v1/job-intake/batches" \
  -H "Authorization: Bearer $JOB_INTAKE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 12c389ae-aae0-4bf5-8632-07729229071e' \
  --data-binary @docs/fixtures/job-intake-batch.json
```

Submitting this fixture **does** run paid analysis when configured; it is not a
dry run. Tests use synthetic model responses and do not require a real key.
For each new user submission generate fresh UUIDs for the idempotency key,
`clientBatchId`, and every `clientItemId`. Retries must retain the same key and
exact payload. Reusing an identity with changed input is a 409.

POST returns 202 after durable database acceptance, or 200 for an identical
replay. Follow the relative `statusUrl` using the same bearer token. Poll at
the advertised interval/`Retry-After` (normally 30 seconds), backing off after
429/503. Never equate HTTP acceptance with analysis completion.

Limits: 20 items, 4 MiB request, 60,000 characters and 128 KiB UTF-8 per text.
Salary accepts up to 500 characters of free-form compensation text; application
source remains limited to 150 characters. Over-limit fields are rejected, not truncated.
Invalid envelope/duplicate item IDs fail the entire request; malformed individual
jobs are persisted as rejected while valid jobs continue. All-rejected requests
return 422 **with a queryable batch ID**. Other errors use
`{error:{code,message,fieldErrors?},requestId}`. Admission is 60 POSTs/minute per
process; it is not a provider RPM/TPM quota.

## Identity and metadata

- URL is mandatory. Original URL is preserved for navigation. All statuses,
  including Archived/Rejected, participate in identity matching. A new submission
  for an existing job refreshes analysis, never creates another application or
  changes its status. Metadata on an existing application is preserved.
- If text is unchanged and a compatible completed Job Analysis exists, reuse it
  and rerun Candidate Analysis with current career data. Changed text appends an
  immutable posting version and runs both stages. In-flight identical runs are
  shared; transport retries with the same submission/key never create new work.
  This refresh may incur paid AI requests. Capabilities advertise
  `repeatImportBehavior: "refresh-analysis"`; old servers may still skip duplicates.
- LinkedIn view/currentJobId and Indeed jk/vjk IDs have website-specific
  identities. Generic provider IDs are verified against URL path/query values;
  a DOM-only ID cannot assert a trusted identity for an unrelated URL.
- `identity.policy` lets each extraction rule retain/drop named query parameters
  and explicitly keep/drop hash routing. Defaults retain query and fragment.
  Parameters with repeated values preserve order. Different websites are never
  merged by title/company similarity. If both URL and rules change with no
  shared stable identity, deduplication cannot be guaranteed.
- Page metadata wins over AI suggestions. User edits, including clearing a field,
  win over both. AI fills unknown title/location/date/salary/direction, not
  company/URL/source. Conflicts remain recorded but never block analysis.
- Missing employer uses an identifiable Imported placeholder. Missing posted
  date stays null, not today's date. `capturedAt` is a separate audit timestamp.
- Captures/policies are untrusted, bounded data, not executable instructions.

## Pipeline and review

Each accepted item progresses through job analysis, deterministic skill
resolution, and candidate analysis. Unknown terms create **pending catalog
skills**, never approved skills or personal career evidence. Candidate results
are tied to explicitly recorded child run IDs. No documents are auto-generated.

`completed` means candidate analysis finished, even when `decisionCount > 0`.
`duplicate`, `rejected`, and `failed` are also terminal for this import.
Batch status is `processing`, `completed`, or `completed-with-errors`.
Notify once using the stable `terminalRevision`; later manual reruns do not
re-notify the import. Open the returned `reviewUrl`/`applicationUrl` in the app.

Review defaults to skills needing a decision. Automatic use requires an eligible
personal Career Data skill plus directly related evidence supporting the actual
requirement; catalog approval alone never establishes possession. Transferable
personal evidence requires explicit Include/Skip (extra reason optional) and can
only produce qualified resume Skills entries, not experience or cover-letter
claims. Unknown skills require a reason to Include; React does not establish Vue.
Include/Skip decisions and reasons are reused only within the same application
and skill when normalized requirements and relevant evidence/classification match.
Legacy decisions without a verifiable basis must be confirmed again. Historical
documents remain available but a new Candidate run makes them out of date.
Include is scoped
to the application and never approves a catalog entry or edits career facts.
Manage skill opens a separate tab. Refresh re-reads local state without AI;
unsaved reasons prevent destructive refresh. Synonym merges move references
and preserve reasons; conflicting Include/Skip decisions return to pending.

## Recovery and operational boundaries

Production uses embedded bunqueue with the existing queue database. The jobs
database holds the intake outbox, run IDs, and claims. Startup and 10-second
reconciliation recover enqueue failures without rebuilding completed stages.
Development uses the same persisted intake state with an in-process dispatcher.
Keep a **single app process/machine per SQLite volume**. The provider semaphore
is process-local, shared across parser/candidate/documents/review, not clustered.

Known transient provider responses (429/5xx) receive at most two retries with
Retry-After/backoff. Billing/quota errors do not retry. Network/timeout failures
may have an uncertain provider outcome: exactly-once billing is not promised.
Terminal failures show an actionable code and application link for manual retry.
A worker with no progress for 15 minutes is marked failed rather than remaining
stuck forever. Missing career onboarding also fails explicitly.

Restart recovery never re-pays a completed stage merely to deliver a notification.
If the worker died during an in-flight provider call, the stored stage may need
a deliberate retry; inspect the application instead of repeatedly importing it.

## Verification

```sh
bun run typecheck
bun test
bun run format:check
bun run build
```

The test preload uses temporary databases outside the repository. Integration
tests exercise bearer auth, website isolation, partial rejection, idempotency,
duplicate identities, pending skills, provenance, merge, and candidate terminal
status without calling OpenAI.
