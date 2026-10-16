# Job Hunting Intaker

A Manifest V3 Chrome extension for [Job Tracker](docs/job-intake-api.md).
Capture job posts from a **chosen tab group**, review the extracted text, import
them in batches, and track job/candidate analysis even after closing the popup.

This repository contains **only capture and intake orchestration**. Job parsing,
skills, career facts, candidate analysis, resumes, cover letters, and Google Drive
belong to the Job Tracker app. The extension never calls OpenAI, stores an OpenAI
key, generates documents, or submits applications.

## Install

Requires Bun and Chrome 120+.

```sh
bun install --frozen-lockfile
bun run check
```

Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**,
and select this repository's **dist** directory. After changing code, run
`bun run build` and reload the extension. JavaScript and daisyUI CSS are built
locally; extension pages contain no inline scripts, CDN dependencies, or eval.

The previous Coursera/video/Drive/offscreen exporter has been removed. Old ignored
`.local/` and `config.local.json` files are not read, exported, or deleted.

## Connect Job Tracker

1. Migrate and start the Job Tracker backend. Complete Career Data onboarding.
2. Configure its dedicated `JOB_INTAKE_API_TOKEN` (generate one with
   `openssl rand -hex 32`). This is **not** the site's Basic Auth password.
3. Open extension **Settings**. Enter a profile label, origin, and intake token.
   Select **Save & grant server access**, then **Test connection**.
4. Add another profile for production if needed. Production requires HTTPS.
   HTTP is accepted only for explicit `localhost` or `127.0.0.1` development.
   Do not enter a URL path, username, password, or query in the origin.
5. Optionally enable notifications. Denial does not block import or results.

Tokens are stored in `chrome.storage.local`, restricted to trusted extension
contexts. Only the service worker makes authenticated requests. UI state,
rule exports, page-extraction arguments, and logs never include saved tokens.
Local storage is not an encrypted vault: someone controlling your browser profile
can access it. Rotate the backend token to revoke a lost credential.

Separate profiles keep local and production credentials distinct. Each operation
is permanently bound to its original profile ID and origin. Changing the selected
profile never retargets queued jobs; an origin with unfinished work cannot be
changed in place. Rotate a token on the same profile, then select **Resume after
reconnecting** for a blocked operation.

## Capture a group

1. Open job pages and place them in a Chrome tab group in the current window.
2. Open extension Settings. Edit/save the matching website rule to grant access
   to that website. Presets do not grant access automatically.
3. Choose the group in the popup and select **Capture group**. At most 100 tabs
   are captured per operation. Other tabs are not inspected for job text.
4. Expand each preview to inspect/edit title, company, location, salary, date,
   source, and description. Save changed previews before importing. Failed
   captures allow manual text paste while retaining the original page URL.
5. To exclude a preview, uncheck **Include in this import** and save it.
6. Select **Import N selected jobs** and confirm the destination. This can start
   **paid AI analysis on your server**. Close the popup whenever you like.
7. Results show each sub-batch and application link. The notification opens a
   single batch in Job Tracker, or an extension results page for multiple batches.

Candidate analysis completion is terminal even when Include/Skip decisions remain.
The backend handles duplicates, unknown pending skills, and metadata conflicts;
review those in the app. Documents require a separate explicit app action.

## Website rules

Settings provides **Add / Edit / Save / Cancel / Remove**, JSON import/export,
and **Test extraction** against an explicitly chosen open page.

Basic controls cover exact hostnames, wildcard pathname, root selector fallbacks,
source name, and selectors for each captured field. Enter root fallbacks separated
by semicolons; enter field selector fallbacks one per line. Invalid or multiple
matches produce diagnostics instead of taking a random recommended job.

**Advanced configuration** exposes the complete bounded rule JSON:

- Each field can prefer JSON-LD or CSS, use text/innerText, or read an approved
  attribute (e.g. `datetime`, `content`, `data-job-id`).
- JSON-LD supports arrays and @graph, and selects one JobPosting by URL/ID when
  multiple postings exist. Ambiguous structured data is ignored rather than mixed
  with the focused DOM root. Description HTML is converted to text.
- Provider IDs can come from a query parameter, a path segment, or a DOM attribute.
  The backend independently verifies IDs; DOM-only IDs cannot assert unrelated
  generic URL identities.
- Query keep/drop lists and fragment keep/drop control **deduplication only**.
  Original source URLs are retained. Do not drop identity query parameters or
  hash routing just because they look noisy.
- Only declarative selectors and transformations are accepted: no custom JS,
  regex programs, remote code, automatic clicking, or hidden API crawling.

The basic controls overwrite their corresponding JSON fields on save. Configure
advanced-only attributes/priorities in JSON; editable selector fields stay in the
basic form. Saving a rule increments its version. JSON import replaces matching
IDs only after confirmation and preserves other rules. Exports contain rules
alone—not credentials, descriptions, operations, or browsing history.

LinkedIn/Indeed presets are **starting templates**, not verified universal site
adapters. Save/test them against your actual page, and adapt selectors for search
sidebars or changed layouts. Expand full job descriptions manually. Extraction
uses a bounded wait and checks page URL/job identity before/after reading.
Iframe/shadow-root traversal, CAPTCHA/login bypass, and universal relative-date
parsing are not supported. Unknown posted dates stay null.

## Reliability and privacy

- Batches persist immutable payloads, UUIDs, and retry keys **before** upload.
  Network retries reuse the same payload/key; no duplicate paid job is intentionally
  created after an uncertain response. The backend owns business deduplication.
- Server capabilities constrain item and byte limits; API v1 hard limits are
  20 jobs/batch, 4 MiB/request, 60,000 characters and 128 KiB UTF-8/job.
- 401/403 blocks for reconnect; contract/conflict errors stop. Retry-After and
  exponential backoff apply to transient failures. Five consecutive failures
  block for manual resume rather than spinning forever.
- Startup/popup wakeups recreate missing alarms. Chrome alarms track pending work
  roughly every 30–60 seconds; browser/OS scheduling may delay notification.
- Notifications use a persisted stable ID across restarts. A crash between
  notification creation and its saved acknowledgment may redisplay the same ID;
  absolute exactly-once sound delivery is not promised.
- Received text is cleared locally after the server acknowledges a batch.
  Unconfirmed payloads/previews expire after 24 hours when the worker next wakes.
  **Clear captures / Clear local record** remove local data, not server jobs.
- Local result metadata remains until cleared. Tokens are never synced or included
  in diagnostics. No production token or real job content is committed.
- Capturing normally uses only the selected group; Settings lists open page titles
  to let you explicitly choose a page for a test. Nothing fetches unopened pages.

Chrome permissions: storage, alarms, tabs, tabGroups, and scripting support the
workflow. Website and API host access is requested per configured hostname.
Notifications are optional. The manifest declares broad **optional** HTTPS
capability so users can add websites; it grants no websites by default.

## Development and checks

```sh
bun run typecheck
bun test
bun run format:check
bun run build
bunx playwright install chromium
bun run smoke
```

Unit tests cover the pinned contract fixture, URL safety, rules, splitting,
idempotent retry, purging, target binding, notifications, and storage isolation.
The real Chromium smoke uses synthetic pages and a **local mock API**, with
pre-granted loopback access in a temporary test-only manifest. It tests extraction,
settings, group isolation, authenticated requests, popup closure, worker restart,
and alarm recovery. It does not use production credentials or OpenAI. A generated
screenshot lives under ignored `.local/`.

Also manually verify normal permission prompts, your authenticated website layouts,
a denied permission, and your OS notifications in Chrome. Synthetic DOM tests cannot
prove current LinkedIn/Indeed selectors or OS notification delivery.

## Frozen app contract

- [API OpenAPI 3.1](docs/job-intake-api.openapi.json)
- [Synthetic batch fixture](docs/fixtures/job-intake-batch.json)
- [Backend plan](docs/job-intake-api-plan.md)
- [Extension plan](docs/chrome-extension-plan.md)

These are a fixed API v1 snapshot copied from Job Tracker, not imports from its
business modules. When changing the contract, update the snapshot and tests in
both repositories.

