# Resolved: 1,000 volumes per project approved — 2026-10-19

The Owner supplied an official Railway support reply confirming a workspace allowance of 1,000 volumes per project, continued Pro membership and no plan/contract change. Nine normal independent volume creations succeeded after the earlier 27-volume rejection. This approval covers volume count; compute/database limits remain separately enforced. The shared rollout has been verified at 100 slots. See config/shared-capacity-100-plan.json and docs/VALIDATION.md.

## Historical initial request draft

Subject: Request to increase project volume-count quota from 27 to 100

Hello Railway team,

Please increase the volume-count quota for our existing project from 27 to 100, so we have headroom for phased growth without repeatedly requesting small increases.

Project name: whatsapp
Project ID: 1c47fb5b-4692-4e66-91a3-2efd7809dabb

The application is a QR-linked WhatsApp workspace. It currently has 20 personal browser-worker services, 6 dedicated shared browser-worker services, an API service and PostgreSQL. Each browser worker needs its own persistent volume for session profiles. We use one replica per worker, private networking, isolated browser users and process/resource admission checks. Shared-account linking is restricted to the Owner, and the application requires opt-in confirmation before sending.

We have increased the existing six shared workers to a limit of seven sessions each, giving 42 configured shared slots without adding volumes. Our next goal is at least 100 shared slots. At around seven sessions per new worker, that immediate target needs about nine more workers and 36 attached volumes including PostgreSQL, or 37 entries while a retained unmounted volume stays separate. The requested quota of 100 provides room for later staged growth; we will not provision 100 volumes at once, and will recheck database and compute capacity before each expansion.

This request is for the number of volumes per project, not the size of each volume in GB. If 100 cannot be approved on our current plan, please advise the highest quota you can approve and the requirements for a higher long-term allowance. Please confirm any required plan or contract changes before applying them.

Thank you.
