# mywasap.com domain and security review · 2026-10-15

## Routing

- Canonical application origin: `https://mywasap.com`. The apex currently reaches the original Railway API and original PostgreSQL. HTTP redirects to HTTPS and the apex certificate is valid.
- HTTPS production traffic uses the raw Host header to enforce the configured origin. Safe page visits on Railway/www aliases redirect to the canonical origin while preserving the path/query. Other browser mutations and WebSocket upgrades on aliases are refused. Forwarded-Host cannot override this decision.
- The existing `whatsapp.mywa.workers.dev` Worker source is versioned in `cloudflare/legacy-domain.mjs` (the account API confirms its current subdomain is `mywa`). Pages redirect to the canonical origin. Only exact signed payment/bank callback endpoints, and signed bank-connector queue/receipt reads, are forwarded. Request bodies/signature headers are preserved; cookies, Authorization and Origin are never forwarded or rewritten. All existing server signature, amount, live-payment and one-time-settlement checks remain mandatory.
- Do not remove the raw Railway domain until all old signed payment/bank callback URLs have expired or been migrated. Do not redirect signed callbacks indiscriminately: a gateway may not follow them.

## Prepared www connection; DNS still required

Railway already has `www.mywasap.com` attached to the same API, port 8080. At the time of review www was NXDOMAIN; its certificate is waiting for ownership verification. Add these records in the existing Namecheap BasicDNS account:

| Type | Host | Value |
| --- | --- | --- |
| CNAME | `www` | `foknzi1f.up.railway.app` |
| TXT | `_railway-verify.www` | `railway-verify=8b82ec522ad6a4f93c5788ec1fe5f0e18541f6f2f7662c75b2901e06dc3c4c36` |

Keep the working apex and existing MX records. Current Namecheap MX records provide email forwarding; changing nameservers without migrating email configuration can interrupt it. The connected Cloudflare account does not currently contain a mywasap.com zone, so this review does not claim Cloudflare WAF is active for the new domain.

## Application hardening

- Existing authenticated API/USER isolation, exact Origin and CSRF checks, Secure/HttpOnly/SameSite=Strict session cookies, session revocation, Owner password re-verification, CSP, HSTS, frame restrictions and no-store private API responses are retained.
- Login/password JSON bodies are limited to 4 KB before the general media parser. Invalid types, oversized usernames/passwords and malformed JSON are rejected without echoing credential input. The general 8 MB photo limit and raw signed-bank-body verification are unchanged.
- Login retains the existing 20 attempts/IP/15-minute limit and adds 10 unsuccessful attempts/account/15-minute across IPs, using hashed bounded account keys. Successful logins do not consume the account-failure bucket. These are process-local counters for the current single API instance; additional replicas require a shared limiter store.
- Owner's own password-change verification is now rate-limited per authenticated account; the existing USER-password-view re-verification limiter is retained. No passwords, users, funds, sessions or account status are changed by this review.
- PUBLIC_URL requires a fixed HTTPS origin in production; credentials, paths, query strings and fragments are rejected. Plain HTTP is restricted to loopback development. TRUST_PROXY_HOPS accepts only 0–5; current Railway direct ingress uses 1. Unused browser camera/microphone/geolocation/payment/device APIs are disabled with Permissions-Policy.
- A production dependency audit found the basic-ftp directory-listing CPU-denial-of-service chain (GHSA-c475-qrg2-pj4r). A targeted 6.2.1 override replaces the vulnerable transitive dependency without downgrading whatsapp-web.js 1.34.7 or removing the disabled-cache fix. Audit after a clean locked install reported zero known vulnerabilities; this is not a penetration-test certification.

## Browser connection recovery

- Runtime logs before this change showed repeated browser launch failures, `spawn groupadd EAGAIN` and history ProtocolErrors. Railway reported only about 2.6 GB of its 24 GB memory ceiling at inspection; the exact process-pressure source was not exposed by platform metrics.
- Cleanup now has a fork-free `/proc`/Node-signal fallback when pkill itself fails with EAGAIN/ENOMEM. It checks the account's private real/effective UID, refuses root/system identities, PID 1 and the current Node PID, and preserves stored login profiles. Startup/failure logs record only aggregate cgroup process counts/limits to diagnose future pressure.
- Container smoke covers cancelled launch, real isolated headful Chromium, simulated fork failure, cleanup and reuse of the same profile with networking disabled. It does not prove real WhatsApp login, delivery or 100+ live-browser capacity. No live message or payment is used as a test.

## Verification and limits

Before promotion run `npm run check`, clean-install dependency audit and the complete GitHub Actions pipeline (disposable native PostgreSQL, Owner/USER × Chinese/English Chrome UI, both container builds and network-disabled worker smoke). After promotion verify exact Railway commit/status, apex/old-domain responses, unauthenticated API rejection and bounded worker runtime logs. Record actual outcomes in the PR and `docs/VALIDATION.md`.

This is a source/configuration and bounded live-service review. Existing sessions and private operations were checked through regression tests, without logging into production accounts or changing production records. Continuous traffic filtering, real bank/WhatsApp end-to-end acceptance, prolonged load testing and restore testing are separate checks; no application can promise that intrusion is impossible.
