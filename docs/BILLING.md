# Costs, capacity, billing and limits

What a listener costs, how much the servers can carry, what another server would
change, what each station is charged, and how station owners are told that they are
nearing a limit. For operators and for developers connecting a billing system.

Everything here is in the dashboard and in the API.

## What a listener costs

Every listener takes a little processor time and memory in two places:

- on the **engine** that sends them the audio, and
- on the **master**, whose HAProxy every listener's connection passes through. This is
  true even when the engine is on a slave node: the audio travels from the slave,
  through the master, to the listener. So the master carries the traffic and the
  proxying for all of them, while each slave carries only its own engine's work.

An **edge server** is the exception: it has its own DNS record and its own HAProxy, so
its listeners never touch the master.

The gateway measures both costs on your own servers. Each engine reports what its
process uses, and the master asks HAProxy what it uses; divided by the listeners being
served, that is the cost of one listener. The figures are kept as slowly moving
averages and are only updated while a server has at least 25 listeners, since fewer
give noise rather than a measurement. Until then, starting figures are used and are
marked "not yet measured here":

| | Starting figure | Basis |
|---|---|---|
| Engine | 10% of one core and 25 MB per 1,000 listeners | Measured in development on the engine alone |
| Master's proxying | The same again | An assumption, replaced by your master's own measurement |

**Servers tab** shows, per server, what its engine is using and what a listener costs
there; what the master's HAProxy is using; and how many listeners the servers as they
are could carry at common bitrates, with what stops them there. `GET /capacity`
returns the same.

Three things limit a server: its processor, its memory, and its network port. At high
bitrates the port usually runs out first; at low bitrates the processor does. A
quarter of every server is kept in reserve (`CAPACITY_WARNING_PERCENT`). The speed of
a server's port cannot be detected: set it per server with the **Port** button, and
for a master without an engine under Settings (`master_port_mbps`). It is 1 Gbit/s
unless changed.

## What would another server do?

The calculator on the Servers tab (`POST /capacity/estimate`) takes the size of a
server you are thinking of adding and says what it changes:

```bash
curl -X POST $API/capacity/estimate -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"vcpus": 4, "memory_gb": 8, "port_mbps": 1000, "mode": "proxied", "bitrate_kbps": 128}'
```

| Field | Meaning |
|---|---|
| `vcpus`, `memory_gb`, `port_mbps` | The server's size |
| `mode` | `proxied`: a slave behind the master. `direct`: an edge server with its own DNS record |
| `bitrate_kbps` | The stream bitrate to work with. Default 128 |
| `listeners` | The load to spread. Default: the listeners connected now |

The answer has `capacity` before and after (how many listeners the installation can
carry and what stops it there), `load_now` before and after (today's listeners on each
server, the master's processor use and its traffic), and `notes`: the same in
sentences. The two kinds of server differ in what they relieve:

- **A slave** takes over engine work. Listeners are shared out by weight, so each
  existing engine has fewer. **Traffic does not move:** every listener's audio still
  passes through the master. Once the master's port or processor is the limit, more
  slaves add nothing, and the calculator says so.
- **An edge server** takes its share of listeners away from the master entirely, with
  their traffic. It is what raises a ceiling set by the master's port.

The calculator works from the measured costs, so it is as good as they are: before
your servers have carried listeners it uses the starting figures above.

## What a station is charged

A station is sold **a number of listeners at its stream's bitrate**, and an account
**an amount of storage** for uploaded audio. That is all a bill consists of.

The price of one listener is worked out, not chosen:

```
listeners one server can carry at that bitrate  =  the smallest of what its processor,
                                                   memory and port allow (see above)
price per listener per month  =  what that server costs you  ÷  those listeners
                                 × (1 + your margin)
```

So a 320 kbps listener costs more than a 64 kbps one, because fewer of them fit on a
server, and the price follows your real cost per listener as it is measured.

Set the inputs under **Settings > Prices** (`PUT /billing/rates`):

| Setting | Meaning |
|---|---|
| `currency` | Three-letter code, for display |
| `server_monthly_cost` | What one server costs you per month. **0 leaves prices unset:** usage and limits are still shown, without amounts |
| `server_vcpus`, `server_memory_gb`, `server_port_mbps` | That server's size |
| `margin_percent` | Added on top of cost |
| `storage_price_per_gb` | Per gigabyte of an account's storage allowance, per month |

The same page shows the resulting price per listener at common bitrates.

Then, per station (administrators only, in the station's edit form or with
`PATCH /stations/{slug}`):

| Field | Meaning |
|---|---|
| `max_listeners` | The listeners the station is allowed, and is charged for. `0` means no limit: the station is then charged for the most listeners it had at once in the month |
| `billing_bitrate_kbps` | The bitrate to charge at. Empty uses the bitrate detected on the stream (128 until the station has played) |
| `discount_percent` | Taken off this station's price |
| `price_override` | A fixed monthly price that replaces the calculated one |
| `subscription_ends_on` | The last day paid for. Used for the notices below; the station is **not** suspended automatically when it passes |
| `user_id` | The account the station belongs to. Moving a station clears its ident and fallback audio, which belong to an account |

and per account (`PATCH /users/{id}`): `storage_quota_mb`, `discount_percent` (taken
off the account's total) and `email`.

None of these can be set by the station's owner: a tenant who sends them is refused.

### Reading a bill

```bash
curl $API/billing -H "X-API-Key: $KEY"                 # a tenant: their own account
curl "$API/billing?user_id=4" -H "X-API-Key: $KEY"     # an administrator: one account
curl $API/billing -H "X-API-Key: $KEY"                 # an administrator: every account, with a total
curl $API/stations/powerbeats/limits -H "X-API-Key: $KEY"   # one station against its limits
curl "$API/billing/quote?listeners=500&bitrate_kbps=128&storage_mb=2048" -H "X-API-Key: $KEY"
```

An account's bill:

```json
{
  "user_id": 4, "username": "client-311", "email": "owner@example.com",
  "currency": "USD", "prices_set": true, "month": "2026-10",
  "stations": [{
    "station": "powerbeats", "name": "Power Beats FM", "is_active": true,
    "plan": { "max_listeners": 500, "listeners_billed": 500, "bitrate_kbps": 128, "bitrate_source": "detected",
              "price_per_listener": 0.0164, "discount_percent": 10, "price_override": null,
              "subscription_ends_on": "2026-12-31", "days_left": 88 },
    "usage": { "listeners_now": 212, "peak_listeners_this_month": 431, "percent_of_limit": 86.2,
               "listener_hours_this_month": 18250.5, "gigabytes_this_month": 1051.2 },
    "status": "near_limit",
    "monthly_price": 7.38
  }],
  "storage": { "used_bytes": 734003200, "quota_bytes": 2147483648, "free_bytes": 1413480448, "percent_used": 34.2, "monthly_price": 1.0 },
  "discount_percent": 0,
  "monthly_total": 8.38
}
```

`status` is `ok`, `near_limit` (75% of the listener limit or more this month),
`at_limit`, `expiring` (7 days or fewer left) or `expired`.

The amounts are a statement of what the plan costs per month. The gateway does not
take payment or issue invoices: a billing system reads these figures, and the usage
figures already kept per station (`/usage`, listening hours and gigabytes), and does
that part.

Station owners see the same in the dashboard's **Billing** tab: each of their
stations with its limit, how close it has come this month, its subscription date and
price, their storage, and the account's total. They see nothing about servers or
costs, and nothing of other accounts.

## Notices by email

Optional, in two parts: a mail server, entered by the administrator, and an address
per account, entered by the administrator or by the account's owner. Without either,
nothing is sent and everything else works the same.

**The mail server** is under Settings > Email (`PUT /settings` with an `smtp` object:
`host`, `port`, `security` as `starttls`, `tls` or `none`, `user`, `password`, `from`,
and `copy_to` for a copy of every notice). The password is stored and never returned.
*Send a test message* (`POST /settings/email/test`) confirms it works.

**An account's address** is set under Accounts, or by its owner in the Billing tab
(`PATCH /auth/me` with `email`; empty stops the notices).

What is sent, checked every 10 minutes:

| About | When | Repeats at most |
|---|---|---|
| A station's listeners, against its limit (the most at once this month) | From 50% | once a month |
| | From 75% | once a week |
| | From 90%, and at the limit | once a day |
| The account's audio storage, against its quota | 50%, 75%, 90%, full | the same |
| A station's subscription | 30, 14, 7, 3, 2 and 1 days before it ends, on the last day, and the day after | once each |

`GET /notifications` lists what has been sent, and `POST /notifications/run` sends
what is due without waiting.

## Limits of all this

- **The costs are averages measured on your servers**, not an exact account of any one
  listener. They are good for sizing and pricing, and they move as your servers and
  traffic do.
- **A listener over HTTPS costs the master more** than one over HTTP. What is measured
  is the mix your listeners actually use.
- **Port speed is what you enter**, not what is detected.
- **Capacity assumes one bitrate at a time.** With stations at different bitrates,
  work with the one most of your listeners use, or the highest to be safe.
- **A listener limit is enforced**: listeners beyond it are turned away. A
  subscription date is not: it produces notices, and what follows is your decision
  (suspend the station from the dashboard or the API).
