# Project instructions

This is the user's WhatsApp workspace backend. The repository is
https://github.com/AnonymousDANIEL/whatsapp and its working branch is main.

## User's update preference

The user requested direct GitHub uploads for the initial application and for
later explicitly requested backend changes or new features. For a concrete
requested change, prepare and validate the change, then commit it to this
repository without asking again for routine upload permission. Preserve current
remote changes and use a non-forced, fast-forward update. Follow any newer user
instruction about branches, reviews or deployment.

Record the exact resulting commit and check the GitHub Actions result. Do not
state that Railway has deployed unless the deployed state was actually checked.
Code and CI cannot replace the first-time Railway service and variable setup.

## Application boundaries

- Keep separate account, task, message history and employee pages, with the simple dark
  blue visual style.
- Use Owner / USER ID roles. Only Owner manages IDs; users share the same capabilities within their assigned WhatsApp accounts. User deletions retain audit history; Owner can explicitly purge application records.
- The original WhatsApp screen has only server-enforced view / operate access;
  do not claim menu-specific controls within an unchanged official page.
- Keep submitted, delivered, read, failed, invalid and unknown outcomes distinct.
- Never automatically retry an unknown send result.
- Never send a live WhatsApp message as a test. Use fake clients and disposable
  test databases unless the user explicitly requests a particular live test.
- Never commit .env, real passwords or tokens, live contacts, WhatsApp login
  profiles, database dumps, node_modules, screenshots of real chats or /data.
- Source changes belong in GitHub. No duplicate source archive is needed unless
  the user asks for one.

## Verification

Use npm ci with PUPPETEER_SKIP_DOWNLOAD=true. Run npm run check and relevant
tests. The integration test requires TEST_DATABASE_URL and creates a temporary
database; never point it at production. Keep the GitHub workflow running tests
against PostgreSQL and building both Docker images.

Report skipped or unavailable checks accurately in docs/VALIDATION.md. Real
WhatsApp login, remote media/voice and large-account load require separate
target-environment checks; do not call them tested based on a successful build.

## Prepaid access (2026-10-11)

- All USERs pay the single Owner-configured MYR rate through manual prepaid credit. Owner remains unlimited. Never invent an official WhatsApp tariff for the Web integration; an unset price blocks USER sends.
- USER can create up to 10 assigned accounts and rename/reconnect them. Only QR linking is available to USER; reject chat viewing and interactive controls on HTTP and WebSocket paths. QR-only sessions use read-only screens and end on connection. Assigned users may create paid sending tasks but cannot modify another creator's tasks. Hide USER slot counters while retaining the server-side limit.
- Keep immutable credit movements separate from deletable chat/task/audit data. Reserve funds atomically before sending, settle/refund once, retain uncertain holds for review, and never overspend or re-charge old sends.

- Online FPX uses Billplz merchant credentials encrypted under APP_VAULT_KEY. Credit only verified live payments once; honor the maintenance switch for new orders and never credit from browser redirects or sandbox payments.
- Owner-requested USER password visibility uses purpose-bound encryption plus five-minute Owner re-verification. Never commit, log or show those passwords outside that authorized account-management view. Historical hashes are not recoverable; do not reset existing passwords without authorization.
- Only Owner can change passwords: USERs have no self-service password button, and the API rejects USER password changes even with the correct current password. Owner resets USER passwords in USER ID management and may change their own password with current-password verification. Password resets revoke all of that account's sessions; never reset production passwords as a test.
- Owner accounts are grouped by assigned USER ID, with unassigned accounts in their own Owner section. Assignment identities must never be exposed to other USERs.
- Owner manages one bilingual notice displayed above every USER page, with an on/off switch. Disabled notice drafts are Owner-only; render notice text safely and preserve unsaved edits while refreshing.
- Hide Online FPX from USER pages whenever live top-ups are unavailable; Owner can always see the maintenance switch and Off status. Existing paid orders must still settle exactly once.
- USER create/edit forms contain ID, password, active status and Owner-private remark; do not reintroduce the WhatsApp assignment picker. Omit grants in these form submissions so editing preserves existing assignments and new USERs can create their own accounts within the default ten-slot limit. The dedicated remark edit must not change active status, credentials, grants or sessions.
- Only tasks paused with pause_reason=credit may automatically resume when the wallet covers the current rate. Manual stops clear that marker; review/unknown, inactive, cancelled, deleted or unassigned tasks must not resume. Never reset recipient statuses or sending intervals. Trigger recovery after committed manual/verified online credits and retry in the worker's five-second cycle. Reserve wallets before locking campaigns to keep lock order consistent with USER deactivation.
- Page loads use cancellable parallel requests, skip unchanged background rendering and preserve ongoing form edits/scroll. Keep history and activity pages bounded at 100 rows and never cache private credentials across sessions.
- USER billing shows their available balance, their own credit ledger and the existing enabled FPX flow. Return only display fields for their ledger; omit Owner notes/actor identifiers, message price and holds from USER responses. Owner keeps all billing details and controls. Never delete historical ledger entries to change visibility.
- USER ID management uses a separate top-level ACTIVE / LOCKED / INACTIVE filter, defaulting to ACTIVE, with selection preserved across refresh in the same login session. Filtering is read-only; never use an inline row selector to change account status. State edits remain in the Owner's account dialog.
- Locked is a real app-access state, separate from Inactive and from WhatsApp connection status. Existing USERs migrate with locked=false. Only Owner can lock/unlock USERs; locked/inactive USERs cannot log in, use existing sessions, start new sends or auto-resume after credit. Lock/deactivate revokes sessions and pauses tasks; unlock/reactivation requires a new login and never automatically restarts stopped tasks. Owner is protected, and status changes must never reset passwords, grants, credit or recipient outcomes.
