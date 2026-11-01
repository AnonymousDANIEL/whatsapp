# Auto reply and scheduled sending

## Using auto reply

Owner opens **Auto reply → Availability / note** to enable WhatsApp, Telegram Bot, Web Live Chat, WeChat Official Account or Facebook Messenger. **USER access** pauses an individual USER/channel and records a reason. New channel policies and connections are disabled by default.

A USER opens **Add connection**, chooses a channel and sets **Reply rules**. Choose all incoming text or case-insensitive keyword matching; enter a reply and a per-customer cooldown (30 seconds to 24 hours). The first matching message outside that cooldown is eligible. Reply history shows actual queue/provider results; submitted is not a delivery receipt. Turning access off stops new replies and disables queued WhatsApp auto-reply campaigns. Already submitted provider messages cannot be recalled.

- **WhatsApp:** choose an existing ordinary QR-linked account. No new login, QR Session reset or shared-pool account is created. The personal worker must have this release's inbound capability and the account must be ready. Replies use existing credit/rates, normal campaigns and normal delivery reconciliation. Only fresh private text is accepted; media/group/status/bot loops are not auto-replied to. LID senders must resolve to a real phone identity through the pinned client.
- **Telegram:** create a bot through BotFather and supply its token. Save credentials, reopen connection settings and choose Verify / connect. A bot already using another webhook is not taken over. Customers must first message the bot.
- **Facebook Messenger:** supply Page ID, Page access token, App Secret and your Webhook Verify Token. Configure the displayed callback URL and matching token in the Meta Page app, subscribe to messages, and complete required Page permissions/app review. Verify / connect subscribes this app to the Page. Signed Page-bound incoming messages are required. Replies use RESPONSE, within the app's five-minute freshness bound.
- **WeChat:** use an Official Account, not a personal WeChat login. Supply App ID, original account ID, Token and EncodingAESKey; configure the callback in the official console, verify it and select secure/encrypted mode. Incoming messages/signatures and recipient App ID are checked. Text replies are returned in the encrypted callback response; provider acceptance/delivery is not fabricated.
- **Web Live Chat:** creates a standalone visitor URL, which may also be used in an iframe. Visitors receive independent 24-hour tokens. A USER/Owner can view that connection's inbox and send a manual reply; visitor polling refreshes the conversation. Paused channels stop new sessions/messages but existing visitors retain their own history.

Credentials are server-encrypted, never returned by APIs, and never logged. No official provider is treated as connected merely because credentials were saved. Current implementation supports one text reply rule per connection, not AI generation or a full cross-provider manual inbox. WhatsApp and other platforms' original clients remain available; manual support in this module is Web Live Chat only.

## Shared maintenance

Owner opens shared service availability, unchecks availability, enters a reason and saves. USER sees **Maintenance** and that reason on Shared WhatsApp. Send/task controls remain blocked server-side. QR accounts and Sessions are preserved. Reopening preserves the existing shared queue/credit rules.

## Personal send time

**New send task** offers **Right now** or **Later at**, with date, hour and minute in Malaysia GMT+8. A later time must be in the future and within 120 hours; validation uses server time. Sending pace is retained in an optional expandable section. Later tasks cannot bypass their start time via send_now. Worker availability and credit are still required at dispatch.

## Verification and rollout limits

Native tests exercise synthetic callbacks, two tenants, visitor isolation, duplicate delivery, pause controls, encrypted WeChat payloads, unknown outcomes and additive migration using a disposable PostgreSQL database. Chromium checks both roles/languages/themes and mobile layout without real provider traffic. The worker image smoke suite continues to exercise browser startup/cleanup and profile isolation.

Production verification uses service metadata, logs, public assets and health checks only. No production test login, real customer message, new phone pairing, balance edit, password edit or Session reset is authorized by these tests. External provider credentials and real end-to-end channel acceptance require the Owner's own configuration. Record actual CI, deployed commits, mounts and connection observations in the PR handoff.
