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

- Keep separate account, task, report and employee pages, with the simple dark
  blue visual style.
- Preserve Owner / Manager / Staff scopes and manager delegation restrictions.
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
