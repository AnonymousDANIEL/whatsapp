# Sidebar line icons (2026-10-17 late evening)

- Owner and USER sidebar entries use compact green outline SVG icons beside their text labels, matching the supplied reference. Use fixed local SVG markup, 18 px at root and 16 px for children, hidden from assistive text/focus. Keep labels, nested indentation, selection and separate expansion chevrons. Icon clicks must follow the same menu action; do not replace labels with an icon-only rail or use external fonts/CDNs.
- The user's latest request supersedes the earlier text-only menu preference. Preserve permissions, ordering, saved expansion, keyboard navigation and logout cleanup. This is a public-assets update: do not restart browser workers, change capacity or touch profiles, data or funds. Bump changed frontend asset versions and run existing zh/en Owner/USER desktop/mobile checks.

# Owner per-ID overview and disclosures (2026-10-17 evening)

- Owner WhatsApp accounts always list directly in the Owner/unassigned section. Other USER ID account groups start collapsed and keep independent click/keyboard expansion choices. Do not restore a saved closed state for the Owner's own section.
- Running capacity keeps total/used/available/unavailable counters visible; its group table starts collapsed on Overview and Service status. Preserve explicit choices across polling, navigation and reload, scoped to the current identity/role and cleared on logout.
- Owner Overview uses /api/overview?layout=2: the current Owner's messages are displayed separately, each other USER ID has an independently expandable overview with its own totals, seven Malaysia dates and outcome statuses. External/unattributed messages have a separate bucket. Never silently fall back to the legacy mixed Owner total when a grouped response fails.
- Attribute task recipients to campaigns.created_by and non-task manual history to message_history.actor_id, regardless of current account assignments; null actors remain external. Suppress task/history duplicates even for retained deleted tasks, exclude deleted accounts/campaigns/history and preserve the existing personal-account scope. Shared sending remains in its separate views. Include inactive/locked and zero-message users without changing their access. Return only identity/access fields needed for Owner headers, no password or remark fields. USER requests for grouped data must be rejected; their existing scoped legacy overview is preserved.
- Reads must not change records, outcomes, funds, grants, profiles or quotas. Test actual native PostgreSQL role denial, current grant changes/multiple grantees, Owner sends on USER-assigned accounts, manual/task attribution, deleted/shared exclusions, deduplication, midnight boundaries, empty buckets and exact legacy-total reconciliation with unchanged snapshots.
- Browser worker watchers use config/worker-watch-paths.json. It lists all current worker dependencies plus schema/bin/vendor/package/worker image files while excluding API-only src/api.js and src/overview.js. test/worker-watch.test.js must cover the transitive local dependency graph; add new worker dependencies to the manifest. Apply/read back this manifest on all existing workers before promoting an API-only release, and verify their active deployment IDs remain unchanged. Do not change resource limits, database configuration, profile mounts or linked sessions for this layout update.

# Owner dashboard and ten additional slots (2026-10-17)

- Owner personal WhatsApp accounts list directly in the Owner section; other USER ID groups are collapsed by default. Click/keyboard expands a group; preserve each choice across polling, navigation and refresh within the same Owner login. Clear it on logout and never reuse another identity's choices. Show the USER access state separately from WhatsApp connection badges: ACTIVE green, INACTIVE red, LOCKED grey. Read statuses only through the existing Owner-only USER endpoint, without requesting password reveal; do not change USER access or WhatsApp state when toggling a group.
- Overview no longer lists personal WhatsApp accounts or their controls for either role. Owner Overview contains current Running capacity and Hourly connection checks, moved from shared management; capacity group details are click-to-expand. Service status retains its capacity view. USER must never request or render infrastructure/other-user data. An optional infrastructure read failure must not blank message charts or invent zero capacity.
- USER Credit/top-up shows balance, bank/FPX and deposit history without a credit-ledger section. Owner retains the ledger and controls. Existing authenticated API ledger display fields remain compatible with already-open older clients; no ledger row, wallet, payment, hold or audit data is deleted to change visibility.
- The additional ten configured slots use the already independent, idle g–p groups: seven per group with 2 vCPU / 8 GB RAM, after the seven-desktop production-image smoke. Total configured capacity is 125. Preserve original a–f, q–t, all /data volumes, private UID isolation, the 120-process admission reserve and USER's ten-account limit. Read fresh live usage before changing any group; do not restart an occupied browser for a UI-only release.
- Keep browser worker source watches so public assets, docs and test changes do not restart linked workers. Validate Owner/USER zh/en desktop/mobile, collapsed groups/status colors and refresh, capacity/hourly placement, USER ledger absence and Owner ledger retention. Seven network-disabled local desktops are not proof of 125 linked phones or guaranteed external availability.

# Live QR capacity counters (2026-10-16)

- Owner Overview and Service status show Available QR slots next to Running capacity, plus occupied/total/temporarily unavailable and per-group remaining slots in Chinese and English. Keep these infrastructure details out of USER responses/pages.
- Use only each view's configured groups. Count enabled, nondeleted personal AND shared assignments, including browsers not started yet. Occupied is at least the running count. Stale/missing/future heartbeats and resource-blocked groups contribute no available slots; do not subtract running alone or advertise a stale worker as available. Capacity reads must not mutate profiles, account flags, wallets or quotas.
- Add capacity with distinct worker groups and separate /data volumes, one replica per group. The +80 topology added groups g–p at six browsers / 2 vCPU / 6 GB each and q–t at five browsers / 2 vCPU / 4 GB each; the 2026-10-17 increment raises g–p to seven browsers / 8 GB each. All fourteen use DB_POOL_SIZE=3. Preserve a–f, process admission guards and the per-USER ten-account quota. See docs/CAPACITY.md before further expansion: the platform rejected another volume at the project quota. Configured free slots are a current capacity snapshot, not verified linked phones or a 100+ live-load certification.

# Project instructions

## Pause-only USER tasks and independent connection capacity (2026-10-16)

- USER may create a fresh opt-in sending task and pause their own existing task; only Owner can resume/restart, cancel or delete existing tasks. Block both UI actions and direct APIs, preserve review pauses, and keep credit-only automatic recovery distinct from a manual USER pause.
- Send now on a new form must verify the actual linked browser, without human approval when eligible; never claim queued work was delivered. Keep old unknown recipients and holds. Recent ACK zero blocks the account briefly; after 90 seconds it becomes unknown and pauses only its original task. Owner may explicitly release remaining pending recipients; never reset or retry the unknown recipient.
- Owner permanent task deletion may explicitly preserve unresolved financial holds. Delete application task/results while keeping immutable charges and ledger; allow later Owner-only manual settlement even after the recipient row is gone. Never automatically refund or charge an unknown result merely because it was deleted.
- Show creation/last-operation timestamps on tasks and creation/send-start/update timestamps in results in Asia/Kuala_Lumpur. New server operations must record their real time.
- Use fresh worker capacity and assigned-record counts to select a configured personal group. Keep per-USER ten-slot limits, resource admission guards, dedicated shared groups, and profile volumes separate. Only a never-started account without profile/home/identity files, bound browser, linked phone or send history may move. Serialize placement, verify target capacity, and atomically mark browser ownership before filesystem setup so an old worker cannot start a handed-off account.
- Test policy/holds/old ACKs with disposable native PostgreSQL and fake clients, concurrent placement with real temporary profile sentinels, and zh/en Owner/USER Chrome including new form submission. Never send real customer messages or delete production profiles as a test.

## Owner-only edits to existing task pacing (2026-10-15)

- Show Edit interval / quantity on existing tasks only to Owner. USER may still choose the initial pacing when creating a task and view details or pause an existing task. Only Owner can resume, restart, cancel or delete existing tasks.
- Reject USER PATCH requests containing pacing or any schedule field, including interval_ms/batch_size and the legacy window/date route, before any mutation or billing check. Owner retains validated paced and legacy schedule edits. Never modify saved task settings, recipient results, credits or sending attempts as a migration or test.
- Verify USER denial with native PostgreSQL using both current and legacy payloads, no partial updates/audit side effects, and Owner access. Check Owner/USER in Chinese/English at desktop/mobile widths; update the frontend asset version so cached pages reload the new controls.

## Account-scoped navigation recovery (2026-10-15 night)

- A real post_logout navigation caused the pinned Client's async framenavigated callback to reject outside initialize and terminate the entire worker. Install the private Page event guard before the native callback is registered, contain both synchronous throws and rejected promises, and route safe fixed categories through the current account's existing lifecycle recovery. Do not suppress all process-wide unhandled rejections or patch global prototypes.
- Mark a client as closing before retiring its entry, remove its guarded listeners on close/shutdown, and ignore late failures from retired clients. Preserve Page on/off identity and duplicate-listener behavior. Initial startup injection failures must still reject normally. Planned worker shutdown must not be reported as a fresh browser failure.
- Keep the regression using the actual pinned upstream post-logout callback under strict unhandled-rejection mode, another unaffected account, listener cleanup, and real network-blocked Puppeteer navigation. A genuine WhatsApp LOGOUT can require the phone to scan again; do not manufacture an authenticated state, copy profiles or reset uncertain sends to hide it.

## Real media-ID regression and preallocated keys (2026-10-15 evening)

- Production reached preparation and failed on submission. The old fixture omitted enumerable MediaData.__x_id, masking the known September 2026 Msg initialization collision (wwebjs issue 201922). Keep a negative control that reproduces it with the pinned upstream sender and a model that actually applies the private ID. Never remove that field from the fixture to make tests green.
- The individual-chat adapter constructs its native MsgKey during non-sending preparation, prefers fromMe/remote with a validated legacy fallback, and normalizes _serialized / $1 / intact components. Remove media __x_id and public media id, then assert the real message identity after media fields. Do not return to the pinned WWebJS.sendMessage final lookup or globally patch its functions/prototypes. Channels/groups/status stories are outside this adapter.
- Persist the exact prepared ID and attempt before enqueue. Preserve it on uncertain results; early actual ACKs cannot be downgraded or cause an erroneous review pause. ACK zero stays held; no raw prepared object may fabricate success when a local model is missing.
- Startup readiness builds against an existing private chat and creates only unregistered models, without collection add, upload or enqueue. Confirm clean model initialization and whether an undefined private ID reproduces the live collision. Return only booleans, format/version tags and fixed error categories; never log the generated IDs, chats, bodies or raw errors. The probe must not reserve the live preparation slot.
- A task with only unknown recipients opens Review uncertain results instead of Send now. Keep unknowns and their holds intact; do not reset, resend or refund them on the assumption that this was their original failure. Old API callers receive a clear review-required error. Retain Owner/USER language and scope checks.

## Image-caption sending and reliable results (2026-10-15)

- Preserve one inline photo with its exact caption, including Unicode and line breaks. Do not split it into two sends or silently convert it to a document. LiveWebClient prepares media without enqueueing, then commits the single-use page token after worker permission/deadline checks. Use the pinned upstream preparation and enqueue APIs; never patch the official UI or globally replace its send functions.
- Return the minimal real message ID/ACK directly from the raw model; do not wait for the server-result promise or run unrelated full-model serialization/sendSeen before saving that ID. ACK 0 stays awaiting_ack with its credit held; only real server/delivery/read ACKs settle a charge. Keep recent sending/awaiting_ack dispatch serialized. After 90 seconds without a real ACK, retain the uncertain ID/hold, pause its original task and allow separate new tasks; never retry that recipient. No synthetic success or live test messages.
- Preparation cannot enqueue. Expired or cancelled work must never later submit, including late number lookups and uploads. Keep one outstanding preparation per page, bounded prepared tokens, single-use commit and safe stage-only diagnostics without contacts, captions, image data or secret-bearing errors.
- Store the processed upload fingerprint and attempt UUID before enqueue. Recover uncertain images read-only using matching image type, caption, fingerprint, recipient, time and unique message; never infer from caption alone. Legacy images can match only an identical original-byte fingerprint. Ambiguous/re-encoded images stay unknown with holds preserved. Late callbacks must match their attempt and cannot overwrite a newer attempt or a confirmed ACK.
- Keep image-caption tests against the actual pinned upstream prepare/enqueue implementations with synthetic upload/chat modules in Node and network-blocked Chrome, plus native disposable PostgreSQL deadline, permissions, receipt, charge/refund and reconciliation cases. A successful fixture is not a real WhatsApp delivery certification.

## Long-lived QR screens and honest capacity (2026-10-15)

- Worker ENTRYPOINT must use tini -s -- so it adopts/reaps orphaned browser descendants even beneath Railway's PID-1 wrapper. Do not add -g: retain Node's coordinated graceful shutdown. Keep the image smoke that reads the declared entrypoint and proves a private-UID orphan is adopted and reaped while Tini is not PID 1.

- Repeated QR viewing has no application scan-count cap, but USER account_limit stays 10, each worker accepts at most 10 desktops, and cgroup admission still limits actual simultaneous capacity. Owner account records are not unlimited live browsers. Scale with distinct groups and profile volumes; never clone a worker against the same group/profile or remove resource guards to claim unlimited connections.
- Monitor protocol pong responses on both screen bridge legs independently of database authorization checks. Retire a half-open screen connection after 60 seconds without a pong; quiet healthy QR screens must stay open. Clear all monitor listeners/timers on close. Prevent overlapping periodic permission queries and keep token, origin, USER scan-only and lease checks intact.
- Bound VNC greeting and browser RFB handshake waits. Scan viewers periodically recheck linking without interrupting a healthy screen, stop once linked/unauthorized, and keep generation guards, bounded reconnect backoff and pagehide cleanup. Screen recovery must never restart/logout the WhatsApp client, delete profiles or resend messages.
- Test actual WebSocket auto-pong versus silent peers, virtual-time quiet-screen longevity, both bridge legs, stale callbacks and real Chrome stalled-handshake/passive-link cases in both languages. A short soak is evidence for its observed duration, not a permanent-uptime certification. WhatsApp may revoke sessions and requires primary-phone activity under its own rules.

## QR browser resource recovery (2026-10-15)

- Production hit the cgroup limit of 1000 processes/threads despite spare memory. Launch Chromium through bin/browser with a generated allowed CPU list (one logical CPU per independent browser, distributed by slot), then drop to the existing private UID. The earlier two-core setting remained close to 1000 with eight desktops; verify the lower thread budget and actual screen responsiveness before release. Preserve custom CHROMIUM_PATH as the underlying executable without bypassing affinity or UID isolation. Never use single-process/no-zygote or weaken web security to reduce process counts.
- Apply the same generated CPU affinity to Xvfb and both x11vnc processes, and set LP_NUM_THREADS from CPUS_PER_BROWSER in the clean desktop/browser environment to bound Mesa software rendering too. Verify the actual desktop /proc CPU masks and thread counts in the network-disabled fleet smoke.
- Keep 120 process slots in reserve before starting a desktop, and recheck account/launch/capacity guards after asynchronous resource reads. Resource pressure waits without disabling accounts or deleting sessions. Record aggregate running/ready/scan/PID capacity once a minute, without phone numbers/chats.
- Observe browser and renderer events from AuthStrategy.afterBrowserInitialized before navigation/QR, as well as later progress events. A renderer crash is Page error; ordinary pageerror must not restart a healthy account. Bind all events to the current entry, preserve profiles, and never resend unknown messages or release their holds as crash recovery.
- QR viewer reconnects on an unexpected screen loss and stops when the API confirms ALREADY_LINKED. Keep USER scan-only permission checks on HTTP/WebSockets and bilingual resource/recovery messages. Run actual renderer-crash recovery and six concurrent private-UID/Xvfb/VNC/Chromium smoke tests under --pids-limit 1000 with networking disabled; these do not prove real phone linking or large fleets.

## Canonical domain and security (2026-10-15)

- Production origin is https://mywasap.com. Preserve exact Origin/CSRF checks and enforce the raw production Host on HTTP and WebSockets. Safe aliases redirect to the configured origin without allowing open redirects; only health checks and exact independently signed payment/bank endpoints bypass the host gate. Preserve raw signed request bodies and existing gateway settlement verification.
- Keep cloudflare/legacy-domain.mjs as the old workers.dev migration. Never forward browser cookies/Authorization or rewrite Origin. Preserve signed connector queue/receipt reads as well as existing payment callbacks; do not replace all legacy traffic with an unconditional redirect.
- Keep 4 KB credential-body limits, hashed account-failure plus IP login throttles, Owner verification limits and bounded proxy trust. Multi-replica APIs need a shared limiter store. Do not silently change production credentials, APP_VAULT_KEY, INTERNAL_SECRET or database settings as a security test.
- Preserve private UID browser isolation and profile data. At EAGAIN/ENOMEM cleanup must work without spawning pkill; never signal root/system identities, PID 1 or the running Node PID. Run the real network-disabled image smoke including this fallback.
- www DNS is prepared in docs/DOMAIN_SECURITY.md and needs the existing DNS account. Do not change nameservers or working MX records blindly, or claim WAF/security certification without verified configuration.

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
- USER keeps a visible Online FPX section showing Coming soon whenever live top-ups are unavailable. Expose no new-payment action while unavailable; preserve checks and verified settlement of existing orders. Owner retains the switch and actual Off/setup status.
- USER create/edit forms contain ID, password, active status and Owner-private remark; do not reintroduce the WhatsApp assignment picker. Omit grants in these form submissions so editing preserves existing assignments and new USERs can create their own accounts within the default ten-slot limit. The dedicated remark edit must not change active status, credentials, grants or sessions.
- Only tasks paused with pause_reason=credit may automatically resume when the wallet covers the current rate. Manual stops clear that marker; review/unknown, inactive, cancelled, deleted or unassigned tasks must not resume. Never reset recipient statuses or sending intervals. Trigger recovery after committed manual/verified online credits and retry in the worker's five-second cycle. Reserve wallets before locking campaigns to keep lock order consistent with USER deactivation.
- Page loads use cancellable parallel requests, skip unchanged background rendering and preserve ongoing form edits/scroll. Keep history and activity pages bounded at 100 rows and never cache private credentials across sessions.
- USER billing shows their available balance, bank deposits and the existing enabled FPX flow; the credit-ledger section is Owner-only. Return only display fields for their ledger; omit Owner notes/actor identifiers, message price and holds from USER responses. Owner keeps all billing details and controls. Never delete historical ledger entries to change visibility.
- USER ID management uses a separate top-level ACTIVE / LOCKED / INACTIVE filter, defaulting to ACTIVE, with selection preserved across refresh in the same login session. Filtering is read-only; never use an inline row selector to change account status. State edits remain in the Owner's account dialog.
- Locked is a real app-access state, separate from Inactive and from WhatsApp connection status. Existing USERs migrate with locked=false. Only Owner can lock/unlock USERs; locked/inactive USERs cannot log in, use existing sessions, start new sends or auto-resume after credit. Lock/deactivate revokes sessions and pauses tasks; unlock/reactivation requires a new login and never automatically restarts stopped tasks. Owner is protected, and status changes must never reset passwords, grants, credit or recipient outcomes.

- Use the supplied transparent-background mywasap logo for the login/loading screen, sidebar and browser icon. The SVG embeds the unchanged transparent PNG and uses the emblem by default with a separate full-logo view. Keep image styling transparent and update the asset version when replacing it; do not upload financial/account screenshots as branding assets. Keep sidebar navigation scrollable when the logo reduces vertical space.
- Display USER balances as plain integer stored credit units (10000000 for the former RM 1000.0000), without an RM prefix, decimals or separators. USER ledger deltas/balances use the same units, and Owner USER-management balances match. Owner accounting/price/hold/FPX amounts stay in MYR. This is a display change: never multiply stored balances, rewrite ledger records or alter debit/payment arithmetic.

## Bank transfer deposits (2026-10-14)

- Keep separate Owner bank-management, deposit-receipt and IN/OUT-ledger pages. USER can create deposits and upload/view only their own receipts; do not restore the removed transfer steps/reference/method/time/sender-name fields. Do not seed bank accounts, credentials or statements from the sample screenshots.
- Banks start disabled. Global off/per-bank disabled hides bank details and QR from USER APIs and refuses new deposits; maintenance is shown and also blocks new deposits. Existing transfers must still settle when banks are disabled. Keep FPX's existing independent switch and verified settlement.
- Never grant credit from a receipt image, OCR, equal amounts alone, sandbox entries or an unverified bank notification. Automatic credit requires the authorized connector's signature and a posted IN transaction bound to the bank, deposit ID and exact receipt hash; validate amount/window and atomically link each transaction/deposit/ledger entry once. Normalize and uniquely identify receiving accounts to prevent duplicate configurations.
- Keep unknown/delayed deposits pending. Automatic no-match rejection requires complete authoritative coverage of the closed 24-hour payment window (including its five-minute pre-order tolerance). An unavailable connection or missing partial feed is not proof of a fake slip. Reject duplicate receipts and show reasons; preserve Owner review and audit.
- Wallet locks precede deposit/transaction locks. Bank credits use the existing integer MYR scale and trigger the existing credit-only recovery after commit; never alter historical funds or ledger entries. Owner manual entry is visibly distinct and cannot auto-credit until independently verified by the connector or explicitly matched by Owner.
- Encrypt connector keys by bank ID, never return them, authenticate receipt/QR access, and avoid downloading large QR payloads during polling. The custom connector protocol is not an existing bank/AutoPay vendor adapter. Obtain the actual provider documentation before claiming automatic bank login, complete external statements or live maintenance detection works. Never test using production funds or bank credentials.

## Sidebar organization (2026-10-14)

- Use the exact Owner root order: Overview, Credit/top-up, WhatsApp accounts, Notices, USER IDs. Credit contains Online FPX and Banks; Banks contains Deposit receipts and Bank transactions. WhatsApp contains Send tasks and Message history. USER IDs contains Activity log and Service status.
- USER roots are Overview, Credit/top-up, WhatsApp accounts (plus the separate Shared WhatsApp root below). Credit/top-up is one sidebar entry: its page directly expands Bank top-up and Online FPX above deposit history; the Credit ledger is Owner-only; do not add USER sidebar children or in-page view-switch buttons. WhatsApp contains Send tasks and Message history. Use text labels, compact green line icons and nested indentation. Keep the right-hand expansion chevrons. Descendants appear only when their parent is expanded, including the nested Banks group. Primary group labels toggle their children and navigate to the group's own page; the separate arrow only toggles without reloading the page. Default to collapsed roots on Overview, and retain explicit expansion choices across refresh within the same USER/role session. Background polling must not reopen collapsed groups. Clear saved choices and navigation DOM on logout; maintain aria-expanded/controls, keyboard/current-page semantics, Escape-to-collapse and a scrollable sidebar.
- Owner Online FPX is its own child view using the existing settings/orders/verified payment flow. USER Online FPX is an expanded section inside Credit/top-up. Keep credit balances/ledgers and Owner manual billing in the parent view. Show USER FPX as Coming soon when unavailable and migrate old FPX/bank page bookmarks to the expanded Credit/top-up page; Owner retains the settings entry even when off. Optional USER navigation-availability failures must not block unrelated pages; do not display a false Off configuration after an Owner settings read fails.

## Shared WhatsApp pool (2026-10-14)

- Preserve personal WhatsApp accounts and the existing ten-slot USER limit. Add a separate Shared WhatsApp root with its own tasks/history. Only Owner may see number records, link, control or manage shared accounts. USERs may submit their own opt-in sends and read only their own results; reject shared access even if a grant is accidentally present.
- Phone records are not mobile registrations. Require a real linked phone identity matching the registered number; never use a linked opaque LID as a phone number or claim new phone registration is automated.
- Shared service starts off with unset pricing. Billing is per message, with independent daily Malaysia-hour rates. Reserve the current fee atomically at dispatch, preserve each reservation's fee/hour/service, settle/refund once through existing immutable accounting, and never retry unknown sends.
- Keep actual sender identity on each dispatched recipient. Move only unsent pending recipients to a healthy shared source. ACKs, late reconciliation, hold guards and purges must follow the actual sender across reassignment. Interrupted sends require review and preserve their holds.
- Hourly health reads client state without sending messages, checks linked number and worker freshness, bounds concurrent probes and labels uncertainty. Account records and live browser capacity are distinct: each worker still caps at ten and needs a separate persistent profile volume. Do not claim 100+ online load was tested from simulated records.
- Optional SHARED_WORKER_GROUPS_JSON isolates dedicated shared groups from personal-account creation. Default workers use a five-connection DB pool. Do not change production wallets, USER status, passwords or send live messages as tests.
- Run the disposable native PostgreSQL shared integration and real headless Chrome Owner / USER tests in both languages, including mobile layout, before deploying.

## Browser reconnect lifecycle (2026-10-15)

- Never restart a healthy QR waiting screen because the user has not scanned it. Keep bounded startup / authentication deadlines and reset them on progress.
- Bind every asynchronous connection-state callback and failure to the exact active entry. Late events from a cancelled attempt must not update or stop its replacement.
- Keep a slot occupied until desktop setup and cleanup finish. Abort launches whose browser handle has not yet been assigned; terminate only the account's verified private UID (>=20000), never root or another account. Preserve all login/profile data. Late message receipts remain valid and must still reconcile against the actual sender across reconnects.
- Run the network-disabled worker image smoke test as well as the native database and UI checks. A Railway SUCCESS / healthz response alone does not prove actual WhatsApp login health.

## Separate shared-number records and wallet placement (2026-10-15)

- USER shared pages contain connection state and their own send flows; show wallet balance and ledger only in Credit/top-up. Current shared status layout=2 omits wallet fields; retain the legacy response for already-open old pages so their balance never becomes a false zero. Do not change accounting.
- Shared numbers must be independent of active personal-account records. Reject cross-scope phone reuse on registration/connect and exclude it from shared eligibility, even if legacy records overlap.
- There is no overall shared-number record cap. Keep input batches <=200, pagination, batch-scoped duplicate reads and indexed phone separation. This is a data-storage allowance, not unlimited phone numbers, registrations or live browser capacity.
- Leave new inactive records disabled without spawning browsers. Skip idle disabled records during worker ticks and hourly probes, but include any running entry, purge request and status needing cleanup.
- Do not present the uploaded Android registration examples as an implemented emulator. Real cloud-phone/Android device integration is not configured; it requires actual platform capability and authorization. Never fabricate device IDs, generated phone numbers, successful verification or working mobile registration.

## USER page simplification (2026-10-15)

- Keep USER balance in Credit/top-up; directly expand bank deposits and FPX above deposit history under that same sidebar entry. The credit ledger is Owner-only. Preserve refresh, legacy saved FPX/bank routes and payment-return verification. Owner bank/FPX navigation remains unchanged.
- Hide only the requested explanatory blocks from USER account, task, message history, overview and shared-send pages in both languages. Owner retains those explanations and connection-sync detail. Remove the USER history-sync banner entirely; keep message records, distinct result badges, weekly data and all actual server checks.
- Do not display the empty-pool note on USER shared sending. Keep zero connected counts and the disabled Send button when no eligible source exists; never fabricate available accounts or bypass server eligibility.
- Hiding explanations must never change prepaid holds, verified payment settlement, failed-send refunds, unknown-result review, account permissions, schedules or ledger records.

## Disabled Web cache runtime fix (2026-10-15)

- Worker uses LiveWebClient to skip only initWebVersionCache when webVersionCache.type=none. The pinned library otherwise adds an unnecessary asynchronous response-body capture whose rejection can terminate Node. Do not globally swallow unhandled rejections, rewrite WhatsApp HTML, or change auth profiles to hide this error. Other explicitly configured cache types retain upstream behavior.
- Keep the isolated subprocess regression that reproduces the pinned upstream failure and confirms the worker client survives the same unavailable response. This fix does not prove all external WhatsApp/network faults are resolved; verify the new deployment's logs and restart behavior.

## Expanded USER recharge layout (2026-10-15)

- USER Credit/top-up has no tabs or section-switch buttons. Keep the balance, then Bank top-up and Online FPX and deposit history. The USER credit-ledger section is removed as of 2026-10-17; retain bounded queries and all stored ledger records. Owner retains their ledger title and controls.
- Closed bank top-up, unavailable live FPX and disabled shared sending show Coming soon to USER. Keep Owner real configuration status, bank-maintenance detail and server-side checks. Never enable a payment/send just to display its section; do not label failed configuration reads as Coming soon.
- Closed methods retain the USER's own historical deposits and FPX order checks/verified settlement. Global/per-bank-off still hides current receiving details and QR, prevents new deposits and does not create credit. Preserve unsent bank form amount, selected bank and retry request ID during combined-page refresh.




