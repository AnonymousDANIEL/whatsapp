## Dedicated shared expansion after quota approval — 2026-10-18

Railway support confirmed the project volume quota increased to **27** in https://station.railway.com/support/request-to-increase-project-volume-quota-26c447ae. Six fresh services whatsapp-shared-01 through whatsapp-shared-06 now have independent 10GB /data volumes. Source deployment and authenticated private capacity verification are still required; a created volume is not a working QR session.

The target is **30 additional shared-only QR slots**, six distinct groups shared-01 through shared-06 at five browsers each, one replica, 2 vCPU / 4GB. Preserve all twenty original browser workers and their 125 personal slots. Use same-project whatsapp.DATABASE_URL and whatsapp.INTERNAL_SECRET references; never copy or read their values.

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

Before shared expansion, the API default DB pool was 15, the six original worker pools totaled 30, and the fourteen newer personal pools totaled 42: a historical aggregate application pool ceiling of **87 connections**. The approved shared target above uses API pool 10 and six additional pools of two, for 94. This is a configured ceiling, not an assertion of measured database capacity. Recalculate it before adding more workers; do not increase PostgreSQL settings as a test.

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

See the expansion PR for final deployment IDs and authenticated-route evidence. Browser health, QR waiting, linked state and message delivery are separate outcomes.
