# QR linking capacity and operation

| Scope | Actual limit |
| --- | --- |
| USER account records | Default and maximum 10 per USER, enforced in PostgreSQL/API |
| Owner records | No USER record cap; this does not allocate browser capacity |
| One browser worker | Configured MAX_ACCOUNTS_PER_WORKER, code accepts 1–10 |
| Current production process/thread budget | 1000 per container, verified from cgroup runtime logs |
| Repeated QR viewing/link attempts | No application scan-count cap; WhatsApp rules still apply |
| Ordinary WhatsApp linked devices for one phone | Up to four linked devices under current official rules; paid Business capabilities can differ |

Production origin is https://mywasap.com. Session profiles live on the existing
/data volume under distinct Unix identities. A valid session should reconnect
after updates without deleting its profile or creating a replacement phone.
Only a real phone association can establish a new WhatsApp session. WhatsApp can
revoke it, and the primary phone must be used within WhatsApp's 14-day window.
See the official [linked-device guide](https://faq.whatsapp.com/378279804439436)
and [linking guide](https://faq.whatsapp.com/1317564962315842).

Quiet QR pages are healthy while protocol pongs arrive. Screen links exchange
pings every 20 seconds and retire peers after 60 seconds without a pong.
The VNC first packet and browser RFB handshake have 15/30-second deadlines.
Scan mode rechecks association every 20 seconds, stops when linked, and retries
recoverable transport failures with a delay capped at 30 seconds. These paths
only reconnect screens; they never log out WhatsApp, clear profiles or resend
unknown messages. Browser crashes remain generation-bound and preserve profiles.
Each browser and its desktop now use one allowed logical CPU, spread across
worker slots, with software rendering threads capped accordingly. Verify real
screens and peak task use rather than treating that bound as guaranteed capacity.
For releases, configure a 90-second worker deployment drain so the existing
shutdown handler can flush profiles and finish in-flight work before termination.
The worker entrypoint must enable Tini subreaping (-s) even when Railway inserts
its own PID-1 wrapper. Otherwise exited orphan descendants may remain as zombies
and consume the task budget. The image regression tests the actual entrypoint
under another init and verifies a private-UID orphan is adopted and reaped.

Before increasing concurrency, check the minute-level Browser capacity logs,
worker freshness, crash/timeout categories and volume health. At 8 live browsers
the observed budget was already around 930/1000 tasks; 10 is a software ceiling,
not a validated safe capacity for the current workload. Keep launch admission.
To expand, prepare additional services with distinct worker groups and distinct
persistent volumes, add explicit API routes and verify each group under load.
Do not add replicas sharing the current group or mounted profiles. Moving linked
profiles needs a controlled stop/copy/permission check; do not silently move
accounts to empty profiles or claim extra capacity from unprovisioned services.

On release, require native PostgreSQL isolation/accounting tests, Owner/USER
Chinese/English Chrome cases, QR reconnect/stalled-handshake cases, production
image builds and network-disabled private-UID browser/crash/fleet smoke tests.
Record the exact commit, Railway terminal states and the actual observed soak
duration in the PR. A finite observation cannot promise fault-free months of
operation, unlimited accounts or exemption from WhatsApp session policies.
