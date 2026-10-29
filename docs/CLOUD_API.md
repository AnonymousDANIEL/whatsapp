# WhatsApp Business Cloud — first release, 2026-10-29 MY

This module uses Meta Graph API v26.0 and Embedded Signup v4 for **new Cloud API numbers**. It does not create SIMs/telephone numbers, run WhatsApp Business mobile, scan QR codes or use Linked Devices. The Owner supplies a number they control that can receive SMS/voice OTP. Meta hosts number entry and OTP verification in its official browser popup; the application exchanges the authorization code, verifies the returned assets, subscribes to webhooks and completes `/register` with a six-digit security PIN.

## Scope and honest limits

- Owner-only Business Cloud menu; ten local number records initially. Ordinary USERs cannot register, view or use these numbers in this release. Personal and shared QR accounts retain their existing permissions, balances and workers. No Cloud API sends debit the old prepaid wallet. Meta bills its own API usage.
- Ten local slots are **not** a Meta allowance. Meta documents two registered numbers for a new business portfolio; verification or the applicable messaging tier can raise that allowance. Meta remains authoritative on eligibility, number limits, display-name approval, policy and billing.
- This release provides independent text inboxes and approved BODY/FOOTER text templates with numeric body variables. Incoming other message types appear as an explicit type/caption marker; rich-media retrieval, calls, groups, catalogs and migration of prior app chat history are not implemented. New-number chat history starts with verified webhooks received by this app.
- Freeform text requires an incoming customer message in the preceding 24 hours. Outside that window use an approved supported template and customer consent. Submission does not mean delivery; Meta signed receipts control sent/delivered/read/failure. Unknown results never automatically resend.
- Category, description, address, email, websites and JPEG/PNG profile photo use the official profile/upload endpoints. A display-name change submits for Meta review, then the Owner explicitly applies an approved change with the current PIN. Business hours are **workspace-only** because the documented Cloud API profile interface does not expose a writable hours field. The UI labels this limitation.
- No Meta App or customer asset was configured during implementation. Real OAuth/OTP, Meta approval, live registration, photo processing and message delivery require the Owner's actual setup and are not certified by mock tests.

## Owner setup

1. In Meta for Developers, create/configure the business app and complete the applicable Tech Provider setup, verification, App Review and Advanced Access for `whatsapp_business_management` and `whatsapp_business_messaging`. App-role test users can test only within Meta's allowed development scope; do not treat that as general production approval.
2. Create a **new Embedded Signup v4** Facebook Login for Business configuration, selecting **Cloud API**. Keep Coexistence/mobile-app onboarding disabled. Legacy v2/v3 configuration has passed Meta's October 15, 2026 deprecation date.
3. Add `https://mywasap.com` to allowed domains and `https://mywasap.com/cloud-signup.html` to the valid OAuth/SDK configuration. Enable the required HTTPS, web OAuth, JavaScript SDK and strict redirect settings. Do not use the unresolved www alias.
4. Open Owner → Business Cloud → Meta setup. Enter App ID, Config ID, App Secret and a private webhook verify token of at least 24 characters. Enter the **same** verification token in Meta. Secrets are encrypted with the existing vault key, never returned to the browser after saving, and blank fields preserve stored secrets. Do not paste credentials into chat, PRs or logs. Do not replace an app already holding connected numbers.
5. In Meta App's WhatsApp webhook configuration, set callback `https://mywasap.com/api/cloud/webhook`, subscribe to `messages` and `account_update`, and complete verification. The Owner page displays the last successful callback verification and valid delivery time. Requests must pass the exact raw-body `X-Hub-Signature-256` check. Invalid signatures and unknown phone/WABA combinations cannot create chat records.
6. Enable Business Cloud; add a **new** international phone number and business name/category. Click Web signup. In the separate page, click Register with Meta, enter/confirm the number, choose SMS/voice, enter the OTP and finish authorization. If the Meta flow reports a different phone, the server refuses to attach it.
7. Return to number management → Complete registration. Choose a six-digit two-step security PIN (distinct from the OTP). Retain this PIN. Only an actual Meta `CONNECTED` status displays Active. Add the payment method required by Meta in WhatsApp Manager. If authorization expires, use Reauthorize for the same number.
8. Open Business profile and Inbox. A customer incoming message opens the 24-hour text reply window. Start a business-initiated conversation with a suitable approved template. The application never sends a live message merely to test setup.

## Isolation and recovery

Only `src/api.js`, new API-owned `cloud-*.js` modules and public assets change. Four additive `cloud_*` tables use the existing startup advisory lock, without altering QR account/schema tables or taking account/profile/financial locks. No new Railway services, volumes, database, phone Sessions or worker deployment is required. The module starts disabled and unconfigured.

The application serializes the ten-slot admission and per-number operations. Number/Meta ID uniqueness, session-bound expiring nonce, one-use code exchange, exact Meta origin checks, verified token app/scopes, WABA membership and phone identity checks prevent a client-supplied ID from granting access. Tokens and PINs are purpose-bound AES-GCM ciphertext. The SDK is loaded only on the authenticated Owner onboarding page; the main workspace CSP retains self-only scripts. Requests use the fixed Graph host, bounded responses, timeout and disabled redirects. Secrets and OTPs are not logged. Template/media/profile requests never enter the QR dispatch queue or financial ledger.

Keep the same send request ID after a network interruption. An already admitted ID returns its existing outcome without invoking Meta again; different content with that ID conflicts. Signed webhook replay is idempotent, binds phone + Messaging account + recipient, and cannot downgrade delivered/read due to a delayed sent/failed event. An in-flight API response cannot overwrite a more advanced webhook receipt.

Future capacity can be increased through a separate authorized configuration change after checking Meta's allowance. The database supports a bounded cap up to 100; this is not a promise of automatic eligibility. Do not change the cap just to disguise a Meta rejection.

## Official references inspected 2026-10-29

- [Embedded Signup v4 implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Default browser flow and SMS/voice OTP](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/default-flow)
- [Tech Provider server onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider)
- [Business phone numbers and limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers)
- [Business profile API](https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/whatsapp-business-profile-api)
- [Display-name changes and re-registration](https://developers.facebook.com/documentation/business-messaging/whatsapp/display-names)
- [Resumable profile photo uploads](https://developers.facebook.com/docs/graph-api/guides/upload)
- [Messages and customer-service windows](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages)

Developer pages were read directly with `Accept: text/markdown` when search extraction returned 429. They explicitly specify v4 and v26.0. No unofficial registration interface is used.
