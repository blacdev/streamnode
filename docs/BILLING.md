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
    "usage": { "listeners_now": 212, "percent_of_limit": 42.4,
               "peak_listeners_today": 431, "peak_listeners_last_7_days": 500, "peak_listeners_this_month": 500,
               "peak_percent_today": 86.2, "peak_percent_last_7_days": 100, "peak_percent_this_month": 100,
               "at_limit": { "now": false, "minutes_today": 0, "minutes_last_7_days": 17, "minutes_this_month": 17,
                             "last_reached_at": "2026-10-02T19:41:00.000Z" },
               "listener_hours_this_month": 18250.5, "gigabytes_this_month": 1051.2 },
    "status": "ok",
    "monthly_price": 7.38
  }],
  "storage": { "used_bytes": 734003200, "quota_bytes": 2147483648, "free_bytes": 1413480448, "percent_used": 34.2, "monthly_price": 1.0 },
  "discount_percent": 0,
  "monthly_total": 8.38
}
```

`status` is `ok`, `near_limit`, `pay_as_you_go` (beyond its subscription and being
charged), `at_limit`, `out_of_bandwidth`, `expiring` (7 days or fewer left) or
`expired`. For a bandwidth plan, `near_limit` means three quarters of the month's data
is used.

**`near_limit` and `at_limit` describe this moment**: the listeners connected now are
at 75% of the limit or more, or at the limit. A station that was full half an hour ago
and is half empty now is `ok`. Being full is a passing state: the limit turns
listeners away only while it is reached, and frees up as soon as others leave.

What the station has reached before is kept beside the status, in `usage`:

| Field | Meaning |
|---|---|
| `listeners_now`, `percent_of_limit` | Connected at this moment, and as a share of the limit |
| `peak_listeners_today`, `_last_7_days`, `_this_month` | The most at once in each span (UTC days), with `peak_percent_...` as a share of the limit |
| `at_limit.now` | Whether it is full right now |
| `at_limit.minutes_today`, `_last_7_days`, `_this_month` | How long it has actually been full: the minutes in which it reached its limit |
| `at_limit.last_reached_at` | When it was last full |

A station that is full for a few minutes a week has room; one that is full for hours a
day needs a higher limit. That is what the minutes are for.

The amounts are a statement of what the plan costs per month. The gateway does not
take payment or issue invoices: a billing system reads these figures, and the usage
figures already kept per station (`/usage`, listening hours and gigabytes), and does
that part.

Station owners see the same in the dashboard's **Billing** tab: each of their
stations with its limit, how close it has come this month, its subscription date and
price, their storage, and the account's total. They see nothing about servers or
costs, and nothing of other accounts.

## Two kinds of plan

Each station is on one of two kinds of plan, chosen by the administrator
(`plan_type`):

| | By listeners | By bandwidth |
|---|---|---|
| What is paid for | A number of listeners at once (`max_listeners`) | An amount of data each month (`bandwidth_gb`) |
| Limit on listeners | That number | None (an optional `listener_ceiling` for safety) |
| What uses it up | Nothing: it is a level, reached or not at any moment | Every listener, for as long as they listen. It runs out faster the more listen |
| When it is reached | Capped, or pay as you go per extra listener | Capped (off the air until the new month), or pay as you go per extra GB |
| Suits | A steady audience of a known size | An audience that comes and goes, or peaks you do not want to turn away |

A bandwidth plan's allowance **starts again on the first of each month** (UTC). Earlier
months are not lost: `GET /billing/history` returns every month on record for each
station (data sent, most listeners at once, listening hours).

**The amount is shown before it is set.** In the station's form, the plan's price
appears as its numbers are entered, at the station's detected bitrate; for a bandwidth
plan it also says what that much data means in listening. `GET /billing/quote` does the
same in the API:

```bash
curl "$API/billing/quote?listeners=200&bitrate_kbps=128" -H "X-API-Key: $KEY"
curl "$API/billing/quote?bandwidth_gb=500&bitrate_kbps=128" -H "X-API-Key: $KEY"
```

At 128 kbps a gigabyte is about 17 hours of listening, and one listener who never
leaves receives about 42 GB in a month. A plan for 500 GB is therefore about 8,700
hours of listening, or 12 listeners around the clock.

**The price of a gigabyte** is under Settings > Prices: `bandwidth_price_per_gb` for
data inside the plan and `payg_bandwidth_price_per_gb` for data beyond it. Left at 0,
the first is worked out from the same costs as a listener's price, so that a listener
who never leaves costs the same on either kind of plan, and the second equals the first.

### One stream, several stations

Stations are separate even when they relay the same stream. The same stream address can
be set up as several stations, each with its own address for listeners and its own
plan: one by listeners for the website, one by bandwidth for a mobile app, and so on.
Each is counted, limited and charged on its own.

That is also why uploaded audio belongs to the account and not to a station: one ident
or fallback file serves every station of the account, and the storage quota is shared
between them.

### When a bandwidth plan runs out

- **Capped:** the station goes off the air (listeners get the same answer as for a
  suspended station) and comes back by itself when the new month begins, or within a
  minute of the plan being enlarged. Its status is `out_of_bandwidth`.
- **Pay as you go:** it stays on the air and each further gigabyte is charged.

A bandwidth station's bill:

```json
{
  "station": "jazz-web", "status": "pay_as_you_go",
  "plan": { "type": "bandwidth", "bandwidth_gb": 500, "price_per_gb": 0.02, "pay_as_you_go_price_per_gb": 0.05,
            "overage_mode": "pay_as_you_go", "listener_ceiling": 1000 },
  "usage": { "listeners_now": 84,
             "bandwidth": { "allowance_gb": 500, "used_gb": 560, "remaining_gb": 0, "over_gb": 60, "percent_used": 112,
                            "projected_gb": 1680, "remaining_listener_hours": 0 } },
  "monthly_price": 10.0,
  "pay_as_you_go_charge": 3.0
}
```

`projected_gb` is what the month would come to at its pace so far, and
`remaining_listener_hours` what is left of the plan in listening at the station's
bitrate. Usage is counted from the daily statistics, so it trails the present by up to
a minute.

## Subscription first, then pay as you go

What a station pays for a month is its **subscription**: a fixed price for the
listeners it is allowed. What happens when it needs more than that is set per station
by the administrator:

| `overage_mode` | Beyond the subscription's listeners |
|---|---|
| `capped` (the default) | Further listeners are turned away until others leave. The bill never changes |
| `pay_as_you_go` | Further listeners are let in, and charged for as long as they are there |

The pay-as-you-go rate is set once, under Settings > Prices (`PUT /billing/rates`):

```
for every  payg_block_listeners  listeners over the subscription   (10)
for every  payg_block_minutes    minutes                           (1)
charge     payg_price_per_block                                    (0.05)
```

A part of a lot counts as a whole lot: with lots of 10, 11 extra listeners are two
lots. So a station with a subscription for 100 listeners that has 300 for five
minutes is 200 over: 20 lots, for 5 minutes, at 0.05, is **5.00**. The Prices page
shows this example worked out with your own figures.

Each minute is charged on the most listeners the station had in it, taken from the
minute-by-minute statistics, so the charge can be traced line by line.

`listener_ceiling` is the most listeners a station on pay as you go may ever have at
once. It keeps a bill from running away and a server from being swamped; above it,
listeners are turned away as with a capped station. Empty means no ceiling.

**Storage** works the same way, per account (`PATCH /users/{id}`): with
`storage_overage` on, uploads beyond the quota are accepted, up to
`storage_ceiling_mb` if set, and what is stored beyond the quota is charged at
`payg_storage_price_per_gb` per month. Off, as by default, uploads beyond the quota
are refused.

A bill then has both parts:

```json
"stations": [{
  "station": "powerbeats", "status": "pay_as_you_go",
  "plan": { "max_listeners": 100, "overage_mode": "pay_as_you_go", "listener_ceiling": 300 },
  "usage": { "listeners_now": 140,
             "pay_as_you_go": { "active_now": true, "extra_listeners_now": 40, "minutes_this_month": 8,
                                "most_extra_listeners": 200, "block_minutes": 103, "last_at": "2026-10-04T14:26:00.000Z" } },
  "monthly_price": 1.64,
  "pay_as_you_go_charge": 5.15
}],
"monthly_total": 3.28,
"pay_as_you_go_total": 5.15,
"total_so_far": 8.43
```

`monthly_total` is the subscriptions; `pay_as_you_go_total` is what has been used
beyond them so far this month; `total_so_far` is both. The Billing tab shows the same,
with the running extra beside each station.

Things to know:

- **The charge is worked out from the station's present subscription.** If its number
  of listeners is changed in mid-month, the month so far is recalculated against the
  new number.
- **Changing a station from capped to pay as you go** takes effect within seconds.
- **Minute records are kept for 90 days** (`STATS_MINUTE_RETENTION_DAYS`); read a
  month's charges before they are that old.

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
| A station's listeners, against its limit | The most at once this month reached 50% | once a month |
| | The most at once in the last 7 days reached 75% | once a week |
| | The most at once today reached 90%, or the limit | once a day |
| A bandwidth plan's data, against the month's allowance | Each level reached, and when it is used up | once a month each |
| The account's audio storage, against its quota | 50%, 75%, 90%, full | as for listeners |
| A station's subscription | 30, 14, 7, 3, 2 and 1 days before it ends, on the last day, and the day after | once each |

Each notice is about its own span, so reaching the limit once does not go on producing
a notice every day: the daily one is sent only on a day the station got that far again.
The message says how many listeners there were, how long the station was full that
day, and how many are connected at the time of writing.

A station on **pay as you go** is not told it has "reached its limit". On a day it goes
beyond its subscription, its owner is told that once, with what the extra has come to
so far. An account whose storage is beyond its quota on pay as you go is told weekly.

### How much mail

The administrator decides, under Settings > Notices (`PUT /settings` with a `notices`
object):

| Setting | Meaning | Default |
|---|---|---|
| `automatic` | Whether notices go out by themselves. Off, nothing is sent unless asked for | on |
| `levels` | The percentages of the limit at which a notice is sent | 50, 75, 90, 100 |
| `min_days_between` | The fewest days between two notices about the same thing (a station's listeners, its pay as you go, the account's storage). Reminders that a subscription is ending are not held back | 1 |

With `min_days_between` at 7, an account hears about a station's listeners at most once
a week, however close to the limit it runs.

### Sending on request

```bash
# A summary of where an account's stations stand now, to its owner.
curl -X POST $API/notifications/send -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"station": "powerbeats"}'        # or {"user_id": 4}

# The notices that are due, now. With automatic notices off, this is how they are sent.
curl -X POST $API/notifications/run -H "X-API-Key: $KEY"
```

The summary lists each station with its listeners now and its highest this month, any
pay as you go so far, its subscription date and price, the account's storage, and the
month's total. It is sent whatever the automatic notices are set to; the Billing tab
has a button for it.

`GET /notifications` lists what has been sent.

## Limits of all this

- **The costs are averages measured on your servers**, not an exact account of any one
  listener. They are good for sizing and pricing, and they move as your servers and
  traffic do.
- **A listener over HTTPS costs the master more** than one over HTTP. What is measured
  is the mix your listeners actually use.
- **Port speed is what you enter**, not what is detected.
- **Capacity assumes one bitrate at a time.** With stations at different bitrates,
  work with the one most of your listeners use, or the highest to be safe.
- **A listener limit is enforced** on a capped station: listeners beyond it are turned
  away. On pay as you go it is the ceiling that is enforced. A subscription date is not: it produces notices, and what follows is your decision
  (suspend the station from the dashboard or the API).
