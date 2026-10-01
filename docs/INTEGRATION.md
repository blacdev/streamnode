# Integration guide

How to drive the gateway from an existing platform: a billing system such as WHMCS or
Blesta, a hosting control panel, or your own application. The platform keeps its own
customers, sign-in and interface; the gateway is the service behind it.

## The model

```
Your platform                          Gateway
-------------                          -------
customer            <-- external_id --> account (tenant)        optional
service / product   <-- external_id --> station
your UI             ----- API key ----> REST API
```

- Your server calls the API with an **administrator API key**. Customers never see
  it and never need a gateway password.
- `external_id` on stations (and on accounts) stores *your* identifier, so you can
  find a gateway object from your side without keeping a mapping table.
- The dashboard is optional. When the gateway is embedded in another platform, it is
  just an operator's diagnostic view.

### Do you need gateway accounts per customer?

| Approach | When to use |
|---|---|
| **Stations only.** All stations owned by the administrator account, each tagged with `external_id` | Your platform is the only thing that talks to the gateway. Simplest |
| **One tenant account per customer**, stations assigned with `user_id` | You want to hand a customer their own API key, let them use the gateway dashboard, or get usage grouped by customer. One account holds all of a customer's stations, and one key manages them all; set the account's `max_stations` to the number their plan allows |

## Lifecycle mapping

| Platform event | Gateway call |
|---|---|
| Create account / order activated | `PUT /stations/{slug}` |
| Suspend (unpaid, abuse) | `POST /stations/{slug}/suspend` |
| Unsuspend | `POST /stations/{slug}/unsuspend` |
| Terminate | read `GET /stations/{slug}/usage`, then `DELETE /stations/{slug}` |
| Change package (listener limit) | `PATCH /stations/{slug}` with `max_listeners` |
| Customer edits their stream URLs | `PATCH /stations/{slug}` with the changed fields |
| Billing run | `GET /usage?from=...&to=...` |
| Service status page | `GET /stations/{slug}/status` |
| Usage charts for the customer | `GET /stations/{slug}/stats` |

All of these are safe to retry. `PUT` creates or updates; suspend, unsuspend and
`PATCH` set a state rather than toggle it. `DELETE` returns `404` on a repeat, which a
module should treat as success.

## Worked example

Set up once:

```bash
API=https://stream.example.com/api/v1
ADMIN=rgw_...   # ADMIN_API_KEY from .env

# A dedicated key for the integration, so it can be revoked on its own
curl -X POST $API/api-keys -H "X-API-Key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"name": "billing module"}'
```

**Provision** service 1042 for a customer whose encoder is at `encoder.example.com`:

```bash
curl -X PUT $API/stations/powerbeats -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{
  "name": "Power Beats FM",
  "primary_url": "https://encoder.example.com/live",
  "max_listeners": 500,
  "external_id": "service-1042"
}'
```

Store the `slug` against the service, and show the customer `stream_url` and
`playlist_urls` from the response.

**Find the station later** from your identifier:

```bash
curl "$API/stations?external_id=service-1042" -H "X-API-Key: $KEY"
```

**Suspend and resume:**

```bash
curl -X POST $API/stations/powerbeats/suspend -H "X-API-Key: $KEY"
curl -X POST $API/stations/powerbeats/unsuspend -H "X-API-Key: $KEY"
```

**Upgrade the package:**

```bash
curl -X PATCH $API/stations/powerbeats -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"max_listeners": 2000}'
```

**Terminate**, keeping the final usage:

```bash
curl "$API/stations/powerbeats/usage?from=2026-03-01&to=2026-03-31" -H "X-API-Key: $KEY"
curl -X DELETE $API/stations/powerbeats -H "X-API-Key: $KEY"
```

## Billing on usage

Call once per billing cycle:

```bash
curl "$API/usage?from=2026-03-01&to=2026-03-31" -H "X-API-Key: $KEY"
```

Each row carries `external_id`, so it maps straight back to your services. Fields you
can bill on:

| Field | Typical use |
|---|---|
| `gigabytes` | Bandwidth overage |
| `peak_listeners` | Verifying or upselling listener-limit packages |
| `listener_hours` | Usage-based plans; royalty reporting (total listening hours) |
| `sessions` | Audience reporting |

Notes:

- Days are **UTC** and both ends are inclusive. Run the report after 00:05 UTC on the
  day following the period, so the last minute of the period has been persisted.
- Totals come from permanent daily rows; they do not change after the day ends.
- Usage is deleted with the station. Read it before terminating.

## Choosing slugs

The slug is the public path of the stream, so it is visible to listeners and should
be stable. Common choices are a customer-chosen name validated against the slug rules
(see the [API guide](API.md#create-or-update-idempotent)) or a generated value such as
`s1042`. A `409 slug_taken` means another station already has it.

Renaming a slug (`PATCH` with `slug`, administrators only) changes the stream URL and
breaks every existing listener link; avoid it.

## Calling the API from a browser

Prefer server-to-server calls, which keep the key secret. If a customer-facing web
page must call the gateway directly:

- Give each customer a tenant account and a **tenant** key; never ship an
  administrator key to a browser.
- Add the page's origin to `CORS_ORIGINS`.

The public now-playing endpoint and the streams need neither: they accept any origin.

## Error handling in a module

| Response | Module should |
|---|---|
| `2xx` | Report success |
| `401`, `403` | Report a configuration error (bad or under-privileged key) |
| `404` on suspend, unsuspend or delete | Treat as already gone |
| `409 slug_taken` on create | Ask for a different slug |
| `422` | Show `error.details` to the user; the fields are named |
| `429`, `5xx`, timeouts | Retry with backoff; every call above is safe to repeat |

## WHMCS notes

A WHMCS provisioning module maps onto the table above directly:

| WHMCS function | Gateway call |
|---|---|
| `_CreateAccount` | `PUT /stations/{slug}` with `external_id` set to the service id |
| `_SuspendAccount` | `POST /stations/{slug}/suspend` |
| `_UnsuspendAccount` | `POST /stations/{slug}/unsuspend` |
| `_TerminateAccount` | `DELETE /stations/{slug}` |
| `_ChangePackage` | `PATCH /stations/{slug}` with `max_listeners` |
| `_UsageUpdate` | `GET /usage`, writing `gigabytes` to the service's bandwidth usage |
| `_ClientArea` | `GET /stations/{slug}` for the stream URL and live listeners |
| `_TestConnection` | `GET /auth/me` |

Use the server's *Access Hash* field for the API key and the hostname field for the
gateway domain. Take the slug, primary URL and backup URL from product custom fields,
and the listener limit from a configurable option. A ready-made module is not shipped
with the gateway.
