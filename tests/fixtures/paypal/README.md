# PayPal fixtures

No PayPal account exists yet (12 October 2026), so these are PayPal's own
documented samples, read on **12 October 2026**, standing in for captures
from the sandbox. U0 swaps real sandbox captures in (see the U1 handover,
"Acceptance rows owed to U0's day"). Prettier leaves this directory alone:
the webhook bodies are byte-exact inputs to a CRC32.

## Webhook event bodies (`webhooks/`)

Each is the `value` of a documented example in the Payments v2 OpenAPI
document, `components.callbacks.<name>...examples.<name>.value`, written
compact (no whitespace) as a delivery body.

Source: https://developer.paypal.com/api/payments/v2/schema.json (read 12 Oct 2026)

| File | Callback example | Event id in the sample |
| --- | --- | --- |
| `payment-authorization-created.json` | `authorization_created` | `WH-5VE77420C3914002P-5G649181HP975980P` |
| `payment-authorization-voided.json` | `authorization_voided` | `WH-30Y09481LL7353048-6K675100AV972020E` |
| `payment-capture-completed.json` | `capture_completed` | `WH-152442318H6474839-1HN0997948621344U` |
| `payment-capture-declined.json` | `capture_declined` | `WH-30Y09481LL7353048-6K675100AV972021E` |
| `payment-capture-pending.json` | `capture_pending_kyc_incomplete` | `WH-36845715LW9646800-7FJ097926K9003132` |
| `payment-capture-refunded.json` | `capture_refunded` | `WH-3UE850097C805102A-18305212AB1299210` |

`guide-postback-request.json` is the request body of the postback example
in "Integrate webhooks", verbatim.
Source: https://developer.paypal.com/api/rest/webhooks/rest.md (read 12 Oct 2026)

The signatures over these bodies in the tests are made with a key and a
self-signed certificate the tests generate; PayPal's own certificate is not
used and no PayPal host is called.

## API responses (`api/`)

| File | Source (read 12 Oct 2026) |
| --- | --- |
| `oauth-token.json` | "Sample response", https://developer.paypal.com/api/rest/authentication.md; `access_token` replaced with an obviously fake value |
| `oauth-401-invalid-client.json` | The example response for a bad client id, https://developer.paypal.com/api/rest/responses.md |
| `api-401-invalid-token.json` | **Derived, not a documented body**: the Responses page's table row "401 Unauthorized, INVALID_TOKEN. Token signature verification failed." written in that page's identity-error shape (`error`, `error_description`). U0 records the body PayPal returns for an expired token |
| `void-422-previously-captured.json` | Payments v2 schema, example `authorizations_void_422_already_captured` |
| `reauthorize-422-too-soon.json` | Payments v2 schema, example `authorizations_reauthorize_422_inside_honor_period` (its `name` is spelt `UNPROCCESSABLE_ENTITY` in PayPal's own document) |
| `capture-409-previous-request-in-progress.json` | Payments v2 schema, example `authorizations_capture_409_conflict` |
| `reauthorize-201.json` | Payments v2 schema, example `authorizations_reauthorize` (read 12 Oct 2026 by U3): the new authorisation's id, `CREATED`, and links only; no amount or times |
| `refund-201.json` | Payments v2 schema, example `captures_refund_with_prefer_header` (read 12 Oct 2026 by U3) |
| `refund-422-amount-exceeded.json` | Payments v2 schema, example `captures_refund_422_amount_exceeded` (read 12 Oct 2026 by U3) |

The sandbox's own answers (authorise, capture, void, reauthorise refused,
negative testing) are U0's recordings under `probes/recorded/`, which U3's
unit tests read as their PayPal doubles.
