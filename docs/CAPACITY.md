## Current shared max-account configuration — verified 2026-10-19

The existing six dedicated shared services now each admit at most **seven** accounts, for **42 configured shared slots**. Their memory ceiling is 8GB per service with 2 vCPU, one replica and a two-connection database pool. All six reached terminal SUCCESS; at 2026-10-19T08:40:25.697485696Z the live DB-backed Owner-capacity reader returned **42 total / 0 used / 42 available**, all six fresh. No new volumes were created. See config/shared-max-accounts-plan.json and config/shared-max-accounts-verification.json for exact IDs and protected-service proof.

Each shared worker was empty before its update. The first worker and fresh capacity were verified before the remaining five. All twenty personal worker deployment IDs and 125 personal slots, API, PostgreSQL, profile mounts, private networking, route references, browser UID/affinity, 120-task reserve and ownership guards were preserved. The aggregate configured database ceiling remains 89. No real linked phone or message was used for testing; seven isolated synthetic desktops cannot certify real-phone throughput or guaranteed uptime.

The earlier 30-to-100 shared target has twelve newly activated slots and **58 remaining**, requiring nine further independent workers (eight with seven slots, the last with two). That exact plan requires **36 attached project volumes including PostgreSQL**, or **37 total volume entries** while the retained unmounted disk stays separate. Any later supported reuse requires provider quota approval and a fresh review. The proposed database ceiling of 93 depends on fresh proof that g-t are still empty before any pool changes; no such changes or new services have been applied. The observed quota rejection remains 27. Request **100 volume-count quota** for phased future growth, or the highest quota approvable on the current plan. Railway's public docs give no uniform numeric maximum for custom Pro approvals and list Enterprise as Unlimited. This is not approval to provision all volumes or change plans. Draft: docs/RAILWAY_VOLUME_REQUEST.md.

Fresh inventory has 28 healthy deployed services and 28 volume entries. The earlier source-less shared-07 service is now absent; its retained volume is unmounted, unchanged, and adds no QR slots. No deletion, attachment, reuse, further create or quota workaround was attempted. Earlier sections below are historical snapshots, not the current capacity.

## Historical 30-slot baseline: requested additional 70 shared slots — quota blocked

The 2026-10-19 request adds 70 to the existing 30 shared-only QR slots, targeting 100 while preserving all 125 personal slots. A normal create-volume attempt was explicitly rejected with You can only have 27 volumes per project. The target requires **37 project volumes** including PostgreSQL. Railway must approve that allowance before this expansion can proceed; do not use staged creates or another indirect route to bypass the confirmed limit.

The refined plan is ten new seven-slot workers, shared-07 through shared-16, each with independent 10GB /data, 2 vCPU / 8GB, one replica and a two-connection pool. PostgreSQL was verified read-only at max_connections 100 and regular allowance 97. Current API pool five plus original personal72 and shared12 yields ceiling 89. After quota approval, reduce only freshly proven empty g-t personal pools from three to two; personal58 + API5 + existing shared12 + new shared20 yields ceiling95. The original a-f workers and every profile/mount remain unchanged. If any candidate empty group becomes occupied, stop and recompute before deployment. Seven synthetic desktops are not seven verified linked phones.

No new QR capacity is active. A staged blank shared-07 volume had been accepted before the normal-create rejection. It is now reserved on a new source-less, never-deployed shared-07 service and adds zero slots. Cleanup deletion was rejected by automatic approval review, so it is retained for the planned expansion without another delete attempt. There are 29 service entries and 28 volume entries; all original 28 services remain online and the prepared service is intentionally undeployed. Exact reserved IDs, DB observations and inactive target are in config/shared-capacity-expansion.json.

Runtime e8510071de6edb5bd50d852c343158a8d73c7226 / API deployment 1d5cce83-5d20-4a59-af3d-6e87a9d3942e is SUCCESS. All 26 original browser deployment IDs and mounts were preserved. At 2026-10-19T08:01:17.732495159Z, live shared capacity was **30 total / 0 used / 30 available**, all six fresh. Existing routing variables were not changed. The API now logs bounded aggregate shared/personal snapshots every minute and actual PostgreSQL connection limits at startup; no credentials, chats or customer numbers enter these diagnostics.

## Dedicated shared expansion after quota approval — 2026-10-18

Railway support confirmed the project volume quota increased to **27** in https://station.railway.com/support/request-to-increase-project-volume-quota-26c447ae. All six services whatsapp-shared-01 through whatsapp-shared-06 are deployed SUCCESS with independent 10GB /data volumes. Authenticated API checks verified each max-five endpoint. At 2026-10-18T14:04:51.639701421Z, the API used the same database-backed capacity reader as the Owner view and observed total 30, used 0, available 30, unavailable 0, all six heartbeats fresh. The twenty original active browser deployment IDs and mounts were unchanged. This is an observed snapshot, not a static counter or proof of a real phone login.

The deployed addition is **30 shared-only QR slots**, six distinct groups shared-01 through shared-06 at five browsers each, one replica, 2 vCPU / 4GB. Preserve all twenty original browser workers and their 125 personal slots. Use same-project whatsapp.DATABASE_URL and whatsapp.INTERNAL_SECRET references; never copy or read their values.

Each worker keeps one pool connection for its lifetime ownership lock. A one-connection pool cannot execute startup queries, so the corrected configuration is DB_POOL_SIZE=2 per new worker and API DB_POOL_SIZE=10. Existing personal-worker pools remain 72 in total, yielding an aggregate application ceiling of **94**, compared with 87 before expansion. This does not alter PostgreSQL settings and is not a measured database throughput claim.

Keep the existing WORKER_ROUTES_JSON exactly unchanged. Set SHARED_WORKER_ROUTES_JSON to the six new private-domain/PORT references and declare those six groups in SHARED_WORKER_GROUPS_JSON only after the independent workers are healthy. The API merges this additive map while rejecting collisions with any original key, undeclared added groups and unsafe endpoints. Legacy combined maps remain supported. An absent shared-group list still means zero dedicated shared capacity.

Do not enable shared sending or change prices automatically. Verify all twenty original active browser deployment IDs and mounts remain unchanged, six authenticated private routes report max=5, and real dedicated heartbeats/counters show the new capacity separately. Real WhatsApp linking still requires the Owner's phone; native database and synthetic Chrome tests do not certify an external login or guaranteed uptime.

# QR fleet capacity

## Production topology — 2026-10-17

| Groups | Services | Slots per group | CPU / RAM per service | DB pool per service |
|---|---:|---:|---|---:|
| group-a (diligent-eagerness) | 1 | 10 configured; resource admission still applies | Existing allocation retained | 5 (default) |
| group-b through group-f | 5 | 5 | 2 vCPU / 4 GB | 5 |
| group-g through group-p | 10 | 7 | 2 vCPU / 8 GB | 3 |
| group-q through group-t | 4 | 5 | 2 vCPU / 4 GB | 3 |

The 2026-10-16 increment added 10 × 6 + 4 × 5 = **80 slots**, taking configured capacity from 35 to 115. The 2026-10-17 increment adds one slot to each existing independent group g–p: **10 more**, taking the configured total to **125**, still across 20 worker groups. Check that every selected group has zero running browsers immediately before its configuration restart; preserve existing a–f and q–t deployments. Owner counters use current admitted capacity; configured free space on an offline or resource-blocked group is temporarily unavailable. Active personal and shared assignments occupy slots before browser launch. USERs still have ten personal-account records each.

Every worker has one replica, a distinct WORKER_GROUP, its own persistent volume at /data and private authenticated routing. New volumes are capped at 10,000 MB, with growth available when needed. No login profiles are copied or shared between workers. The API and PostgreSQL remain separate services.

Before shared expansion, the API default DB pool was 15, the six original worker pools totaled 30, and the fourteen newer personal pools totaled 42: a historical aggregate application pool ceiling of **87 connections**. The deployed shared addition above uses API pool 10 and six additional pools of two, for 94. This is a configured ceiling, not an assertion of measured database capacity. Recalculate it before adding more workers; do not increase PostgreSQL settings as a test.

## Platform quota and further expansion

The platform rejected another volume with `You can only have 20 volumes per project`. The inventory includes the separate PostgreSQL volume as well as mounted browser volumes; keep the accepted mounts and inspect the actual current quota before creating another. [Railway's volume reference](https://docs.railway.com/volumes/reference#volume-limits-per-project) documents a Pro allowance of 20 and an increase request through Help Station. The Owner subsequently submitted the linked private request and Railway raised the allowance to 27. No plan upgrade was purchased.

Never replace persistent profiles with ephemeral storage, clone a worker against an existing group/profile or remove the 120-process launch reserve to force capacity. A container still has its own process/thread ceiling. The release requires seven concurrent private desktops to pass the network-disabled production-image smoke; this does not certify 125 real linked WhatsApp phones or continuous external WhatsApp availability.

## Updating or checking the fleet

- Source: AnonymousDANIEL/whatsapp main, Dockerfile.worker, one replica in us-east4-eqdc4a. Keep healthcheck /healthz, timeout 180 seconds, overlap 0 and draining 90 seconds. Use config/worker-watch-paths.json for the worker dependency watch list. It includes current worker source dependencies, schema, /bin/**, /vendor/**, /package*.json, /Dockerfile.worker and /railway.worker.json, while excluding API-only src/api.js and src/overview.js. The transitive dependency test requires new worker imports to be included. Read back this list on each service before an API-only promotion so existing browser workers do not restart.
- Required worker configuration: SERVICE_ROLE=worker, DATA_DIR=/data, PORT=8080, unique WORKER_GROUP, MAX_ACCOUNTS_PER_WORKER from the table, DB_POOL_SIZE from the table, RAILWAY_RUN_UID=0 and RAILWAY_DEPLOYMENT_DRAINING_SECONDS=90. Use same-project references to whatsapp.DATABASE_URL and whatsapp.INTERNAL_SECRET; never copy, print or replace the secret values.
- Confirm the private volume, resource limits, group and branch before connecting source. Empty-service creation can return while an internal environment patch is still applying. Wait for that service instance; never retry create blindly. Connect the tested source once the volume and variables are configured.
- Preserve the API's WORKER_ROUTES_JSON and add healthy dedicated groups through SHARED_WORKER_ROUTES_JSON. Use private DNS/PORT references. Wait for terminal SUCCESS and `Worker route verified` for every group; the startup diagnostic safely includes the actual configured max and running count.
- Owner Service status shows personal live remaining slots; Shared WhatsApp has its own independent capacity panel; counters stay visible and group rows are click-to-expand. Hourly connection checks remain on Owner Service status; Overview contains message statistics only. New groups appear from current health responses without another login. USER responses must not expose worker inventory or infrastructure capacity.
- Inspect fresh heartbeat, process headroom, real QR state and failures after rollout. Only never-started accounts without bound profiles/identities/phone/send history may be handed off. Never send real messages, reset accounts or change funds to verify capacity.

See config/shared-capacity-plan.json and PR #29 for final deployment IDs and authenticated-route evidence. API runtime/image/assets watches exclude documentation and tests; all worker watches retain their existing dependency manifest. Browser health, QR waiting, linked state and message delivery are separate outcomes.
