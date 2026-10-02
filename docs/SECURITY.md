# Security

## Model

| Actor | Trust | Can do |
|---|---|---|
| Operator (`admin` role) | Full | Everything: accounts, keys, all stations, suspension, deletion, servers and join tokens |
| Tenant (`tenant` role) | Limited | Create (within `max_stations`), edit and delete their own stations, read their own statistics, manage their own keys. Cannot suspend, change listener limits, or see servers and other accounts |
| Listener | None | Fetch streams, playlists and the public now-playing endpoint |

What is deliberately public: the audio streams, playlist files,
`/api/v1/public/stations/<slug>/now-playing`, `/api/v1/health`, and the API
documentation.

## Controls

### Authentication

- **API keys** are 192 random bits with an `rgw_` prefix. Only their SHA-256 hash is
  stored; the key is shown once at creation. Keys can be revoked individually and take
  effect immediately.
- **Passwords** are stored as salted scrypt hashes.
- **Dashboard sessions** are random tokens held in Redis (hashed), expiring after 12
  hours. The dashboard keeps its token in `sessionStorage`, so it is not sent
  automatically by the browser and the API is not exposed to cross-site request
  forgery.
- **Sign-in attempts** are limited to ten per address per 15 minutes.

### Authorisation

Every station request is scoped to the caller. A tenant asking for another tenant's
station receives `404`, the same answer as for a station that does not exist, so slugs
cannot be probed. Fields that affect billing or isolation (`max_listeners`,
`is_active`, `user_id`, `external_id`, and renaming a slug) are administrator-only.

### Station URLs cannot reach the internal network

Station URLs are tenant-supplied, and the engine fetches them. Without protection a
tenant could point a "stream" at an internal service or a cloud metadata endpoint and
read the response as audio. Two layers prevent this:

1. The API rejects URLs with private, loopback or link-local addresses, internal
   hostnames, embedded credentials, or schemes other than HTTP and HTTPS.
2. The engine enforces it at connection time, which is the authoritative check:
   hostnames are resolved through a filter that discards non-public addresses, and
   every redirect hop is checked again. This also defeats DNS that changes after
   validation.

`ALLOW_PRIVATE_SOURCES=true` turns both layers off. Use it only on a gateway where
every account is trusted.

### Network exposure

- Docker opens published ports in the host firewall directly, bypassing `ufw` and
  `firewalld` rules. Restrict access with your provider's firewall, or by setting the
  `*_BIND` variables to a specific address.
- Only HAProxy publishes ports. PostgreSQL, Redis, the engine and the admin service
  are reachable only on the private Docker network.
- TLS 1.2 or newer. The dashboard and API redirect HTTP to HTTPS when requested by
  the domain name. They are also reachable over plain HTTP by the server's IP
  address, which is what makes local-network access work; over that path the
  password, session and API keys travel unencrypted. On an internet-facing server,
  use the domain, or block direct-IP access to ports 80 and 443 at the firewall for
  everything except your own networks.
- Streams are also served over plain HTTP on purpose, for devices that cannot use
  TLS. Audio streams are public content, so this exposes nothing private.
- The management API is rate-limited per client address at the edge.
- Redis requires a password and is never exposed directly. Slave nodes reach it
  through HAProxy on port 6380, encrypted with the master's certificate; on a
  single-server install that port is bound to the loopback address.
- HAProxy's runtime API (port 9999) is reachable only on the private Docker network,
  never from the host or the internet. Anything on that network can reconfigure
  HAProxy, so do not attach untrusted containers to it.

### Between master and slave nodes

| Link | Protection |
|---|---|
| Slave joins the master | HTTPS, plus a **join token**: random, stored only as a hash, valid once, expiring after an hour by default. A token issued by the master-initiated setup is also bound to the slave's address |
| Slave to Redis on the master | TLS and the Redis password. The certificate is verified when the master holds the domain's real certificate and slaves connect by that name; with `TLS_MODE=external`, `selfsigned` or a `CLUSTER_HOST` address it is encrypted but not verified |
| Master's HAProxy to a slave's engine | Plain HTTP carrying the **engine secret** in a header. The engine refuses every request without it, including health checks, so listeners cannot bypass the master. HAProxy overwrites any such header sent by a client |
| Master completing a waiting slave's setup | Plain HTTP carrying the slave's **setup key**. Only a short-lived, address-bound join token is delivered this way; the slave then joins over HTTPS |

What follows from this:

- **Audio between the master and a slave is not encrypted,** and neither is the
  engine secret that travels with it. The audio is public anyway. Someone able to
  read that traffic could learn the engine secret and then fetch streams from a slave
  directly; they could not read or change anything else. Where the servers share a
  private network, use it (`--advertise` with the slave's private address); between
  data centres, run the link over WireGuard or a similar tunnel.
- **A slave holds the Redis password and engine secret.** Treat slave nodes as
  trusted servers. Removing one from the list stops listeners being sent to it but
  does not take those credentials back: rotate them
  ([Operations](OPERATIONS.md#rotating-credentials)).
- **Unverified Redis TLS** (the cases in the table above) protects against
  eavesdropping but not against someone able to intercept and impersonate the master
  on that path, who could then capture the Redis password. Use a private network or a
  tunnel for that link if the master's certificate lives elsewhere.
- **`TLS_MODE=external`** makes the master trust the `X-Forwarded-For` header and
  treat plain-HTTP requests as HTTPS. Allow its HTTP port only from the proxy in front.
- **`--insecure`** makes a slave accept any certificate from the master, for both the
  join and Redis. Use it only while testing with the self-signed certificate.
- The join response contains credentials and is returned only in exchange for a
  valid token. The endpoint is rate-limited with the rest of the API.

### Optional edge servers

- The relay port (8444), used by edge servers to forward dashboard and API requests,
  trusts the client address it is told and treats requests as having arrived over
  HTTPS, so anything that can reach it can pose as any client. Publish it only on a
  private address (`RELAY_BIND`) reachable from your edge servers. API keys and
  passwords are still required for everything behind it.
- Edge servers hold a copy of the domain's certificate and private key.

### Updates

- The services cannot touch Docker or the host. Updates are installed by a script
  the host's scheduler runs; the dashboard only leaves a request in the installation's
  `control/` directory. The most that request can do is turn automatic updates on or
  off, set their time, and ask for the latest version of the watched repository to be
  installed.
- `control/` is writable by any local user on the server, because the services run as
  unprivileged users. A local user could therefore trigger an update to the latest
  version, nothing else. On a server with untrusted local users, restrict the
  directory to root and the service users.
- Updates install whatever is on the watched branch. Automatic updates are off by
  default; switch them on only if that branch is always fit for production, or pin
  servers to releases with `IMAGE_TAG`.

### Application

- All SQL uses bound parameters.
- The dashboard builds the page with DOM methods, never by inserting HTML, so station
  names and song titles from untrusted sources cannot inject markup. A
  Content-Security-Policy restricts scripts to the gateway's own origin.
- Request bodies are limited to 64 KB.
- The engine and admin containers run as non-root users. HAProxy starts as root to
  read the certificate and bind ports, then drops to an unprivileged user.
- Changes to stations, accounts and keys are recorded in the audit log with the
  caller and address.

## Hardening checklist

- [ ] `.env` is readable only by its owner (`chmod 600 .env`) and is not committed.
- [ ] The domain has a real certificate: `TLS_MODE` is `letsencrypt`, `provided` or
      `external`, not `selfsigned`.
- [ ] With `TLS_MODE=external`: the master's HTTP port is reachable only from the
      proxy in front.
- [ ] `ALLOW_PRIVATE_SOURCES=false`.
- [ ] The server has a domain and `FORCE_HTTPS` is `true` (an install without a domain
      serves everything over plain HTTP).
- [ ] Administrators sign in through `https://<domain>`, not through the IP address.
- [ ] The master has a real certificate, so no slave needs `--insecure`.
- [ ] Firewall: on the master, 6380 open only to slave nodes; on each slave, 3000 open
      only to the master.
- [ ] `CLUSTER_BIND` is `127.0.0.1` if there are no slave nodes.
- [ ] Credentials were rotated after any slave node was decommissioned.
- [ ] `CORS_ORIGINS` is empty or lists specific origins, not `*`.
- [ ] Integrations use their own API keys rather than the bootstrap key, so each can
      be revoked separately.
- [ ] Tenant-facing integrations use tenant keys, not an administrator key.
- [ ] The server firewall allows inbound 80 and 443 (and SSH) only.
- [ ] Backups run on a schedule and are copied off the server.
- [ ] The host and Docker are kept patched; images are rebuilt periodically
      (`docker compose build --pull`).

## Known limits

- **No per-listener access control.** Any stream URL is playable by anyone who knows
  it. Token-protected or geo-restricted streams are not supported.
- **Listener addresses are not stored.** Statistics are aggregate counts only, so
  there is no per-listener personal data at rest. HAProxy's request log does contain
  client addresses; apply your retention policy to Docker's logs.
- **Volumetric attacks.** The API is rate-limited; streams are not, because many
  legitimate listeners share addresses. Use `max_listeners` per station and network-level
  protection from your hosting provider.
- **The bootstrap key in `.env` is a full administrator credential.** Anyone who can
  read that file controls the gateway.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the operator of this deployment rather
than in a public issue, with steps to reproduce.
