# QR allocation and demand repair

Observed2026-10-20: the configured personal capacities10/5/7 total125; shared remains200. These are configured account slots, not a guarantee that all browsers can initialize simultaneously. WhatsApp1 had10 assigned profiles,8 running desktops,1 linked phone,7 unattended scan screens and971/1000 cgroup tasks. Other personal workers had only0-1 desktops. No startup failure matched the bounded post-repair log window, but two bound profiles could not launch because the PID reserve was exhausted.

## Behavior

New reservations are serialized with the existing placement lock. They require a fresh worker heartbeat (at most5 seconds in the future), real process headroom and room under both assigned and running counts. No eligible group returns409 before inserting an account. Existing bound profiles stay in place.

Authenticated start returns202 queued without waiting for Xvfb/VNC/Chromium. A PostgreSQL scan_demand row retains the original FIFO request time while renewals extend expiry by120 seconds. An expired request re-enters at the back of the queue. The QR viewer automatically starts with session+CSRF and polls/reconnects with bounded backoff. USER reconnect is idempotent start; Owner explicit restart remains available.

Linked phones recover first after service restart. Unlinked profiles initialize only on active scan demand. Expired unviewed QR screens retire through the existing private UID lifecycle only if awaiting a scan and neither ready, authenticated, launching, syncing nor sending. Any attached screen socket protects the browser. No profile, Unix identity, account grant or message is deleted. A QR can reopen from its retained profile. Strict X11 orphan cleanup runs before releasing the retired display slot.

Queued requests under real load remain queued; an initialization without QR/authentication progress is recovered after180 seconds. A ready WhatsApp connection is never inferred from accepted admission, VNC readiness or capacity counters.

## Startup schema contention

The first complete fleet log audit found three PostgreSQL deadlocks during worker restarts. A full startup schema transaction waited for an exclusive table lock while a live message-charge reader waited for another table already locked by that migration. The worker retried its next tick, but repeated DDL on every restart was unnecessary.

Production startup now verifies a SHA256 marker for the exact schema.sql under the existing migration advisory lock. An unchanged installed schema avoids all repeated ALTER TABLE locks. A missing or changed marker runs the complete migration atomically and records its successful completion; Owner bootstrap remains serialized. Explicit migrate() still applies the full migration for imports and repair workflows.

Only the schema transaction uses a local250ms lock timeout and bounded lock-conflict/deadlock retries. Every failed attempt rolls back and releases its client before retrying. Normal transactions, sends, settlement and wallet operations do not gain automatic retries. Real PostgreSQL regressions hold live-reader table locks, run concurrent cached startups and the actual worker entrypoint, then force a missing-marker migration to yield and retry while preserving users, grants, sessions, profiles and funds without increasing the database deadlock counter.

## Verification and rollout

Targeted tests cover TTL/renewal, FIFO, linked-priority order, resource rejection, no overbooking, USER isolation and reconnect semantics. An actual isolated PostgreSQL worker serves quick authenticated202 responses at a simulated exhausted process budget, preserves a bound profile marker and never reports it linked. Real Chrome tests exercise automatic start coalescing, continued polling, RFB recovery and terminal link detection in Chinese/English. The network-disabled real Xvfb/Chromium/VNC smoke retires an idle synthetic QR, reuses its display under another UID and keeps another synthetic ready desktop and every profile marker intact. Existing worker fleet, subreaper, media, UI and backup/restore checks remain.

Use an exact tested worker commit, an empty canary and small verified rollout batches. Keep every browser source pinned, including fixed-version upgrades of previously pinned shared workers; do not remove a protected pin or follow mutable main. Set a release branch whose head is the tested commit and verify the actual build commit, terminal SUCCESS and the QR demand version log. A source configuration alone is insufficient: an earlier staged deployment built the older branch head despite displaying the new pin. Isolate the browser sources before the final main fast-forward so that merge cannot trigger a fleet-wide restart. Preserve PostgreSQL, every mount, slot count, phone profile, secret and financial record. Compare the preexisting account readiness identity after WhatsApp1 recovers; it hashes the account record, not the phone number. Record final production observations separately; no live send/login or synthetic production account is used for verification.
