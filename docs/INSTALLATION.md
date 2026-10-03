# Installation

The gateway is one codebase installed in one of three **roles**. The installer asks
which, or takes `--role`.

| Role | Runs | Choose it when |
|---|---|---|
| **both** | Everything on one server | One server is all you need. You can add slave nodes later |
| **master** | HAProxy, dashboard, API, PostgreSQL, Redis | You want a dedicated entry point and will relay audio on other servers |
| **slave** | The audio engine only | You are adding capacity to an existing master |

Listeners always connect to the master's domain. The master's HAProxy hands each
listener to an engine, on the same server (`both`) or on a slave node. Adding or
removing slave nodes never changes the address listeners use.

```
                 listeners  ->  stream.example.com
                                      |
                          +-----------------------+
                          |        MASTER         |
                          |  HAProxy              |
                          |  dashboard and API    |
                          |  PostgreSQL, Redis    |
                          +-----------------------+
                           /          |          \
                   +---------+   +---------+   +---------+
                   | SLAVE 1 |   | SLAVE 2 |   | SLAVE 3 |   audio engines
                   +---------+   +---------+   +---------+
```

## Requirements

| Item | Master / both | Slave |
|---|---|---|
| Operating system | 64-bit Linux that runs Docker | Same |
| Software | Docker Engine 23+ with the Compose plugin, `openssl` | Docker Engine 23+ with the Compose plugin |
| CPU and memory | 2 cores, 1 GB or more | 1 core, 512 MB or more |
| Disk | 10 GB plus statistics growth | 5 GB |
| Inbound ports | 80 and 443 from everyone; 6380 from slave nodes | 3000 from the master only |
| Outbound | To slave nodes (3000) and, for `both`, to station sources | To the master (443, 6380) and to station sources |
| DNS | Optional: a hostname pointing **directly** at this server. Without one the server's IP address is used | None |

Bandwidth: every listener's audio leaves through the master, so size the master's
network link for the whole audience (listeners multiplied by bitrate). Slave nodes
need the same throughput for their share.

### DNS: do not proxy the hostname

Point the hostname straight at the master's IP address. If the domain is on
Cloudflare, set the record to **DNS only** (grey cloud). Caching proxies buffer
responses and cut long-lived connections, which breaks continuous audio.

## Try it locally first

```bash
./scripts/try-local.sh
```

Starts a master with its own engine, a demo station and a slave node that joins it,
on `http://localhost:8080`, and prints what to try. See `./scripts/try-local.sh help`.

## One-line install

On a fresh server, this is all that is needed:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash
```

`get.sh` prepares the server and then hands over to the installer described in the
rest of this guide. It:

1. checks the operating system, processor, memory and whether ports 80, 443 and 3000
   are free;
2. installs `curl`, `tar` and `openssl` if missing, and offers to install Docker with
   Docker's official script if it is not there (it asks first);
3. makes sure Docker and the Compose plugin are running;
4. downloads the gateway's files to `/opt/streamnode`: the Compose file, the proxy
   configuration and the operational scripts, about 100 KB in all. The source code is
   not placed on the server; the services arrive as prebuilt Docker images;
5. starts `install.sh`, which asks for the role and everything else.

It needs root or `sudo`. Options go after `bash -s --`; anything it does not recognise
is passed to the installer, so the whole setup can be given on one line:

```bash
# a slave node, joining a master
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- \
  --role slave --master https://stream.example.com --token rgj_...

# a single server with a Let's Encrypt certificate, no questions asked
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- --yes \
  --role both --domain stream.example.com --tls letsencrypt --email you@example.com
```

| Option | Meaning |
|---|---|
| `--dir PATH` | Where to install. Default `/opt/streamnode` |
| `--branch NAME` | Branch to install and to follow for updates. Default: the repository's default branch |
| `--ref COMMIT` | Install exactly this commit |
| `--repo URL` | Install from another GitHub repository (a fork) |
| `--with-source` | Also keep the source code on the server, for building the images there |
| `--yes` | Do not ask before installing Docker or other missing tools |
| `--non-interactive` | Never ask anything; use what is already configured |

Running the same command again later updates the files and re-runs the installer,
keeping settings and data; `scripts/update.sh` does exactly that
([Updating](#updating)). An older installation that holds a full copy of the
repository is slimmed down the same way. The one-line install needs the repository
to be public.

Prefer to read a script before running it? Download it first:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh -o get.sh
less get.sh && bash get.sh
```

What is left on the server afterwards:

| File | Purpose |
|---|---|
| `docker-compose.yml` | The services and how they connect |
| `haproxy.cfg` | Proxy configuration |
| `.env` | This server's settings and secrets |
| `certs/` | The certificate, where one is used |
| `install.sh`, `scripts/` | Changing settings, adding servers, backups, updates, uninstalling |
| `.version` | Which version is installed and where it came from |

The sections below describe what the installer does in each role. `./install.sh` in
`/opt/streamnode` is that same installer.

## Access by IP address

The gateway answers on the server's IP address as well as on its domain, on every
network interface, with no extra setup:

| Reached as | Streams | Dashboard and API |
|---|---|---|
| `http://<server-ip>/...` | Yes | Yes, over plain HTTP |
| `http://<domain>/...` | Yes | Redirected to HTTPS |
| `https://<domain>/...` | Yes | Yes |

When the dashboard is opened by IP address, the stream URLs it shows use that same
address, so they work from wherever you are looking.

### Installing without a domain

A domain is optional. Leave it out (press Enter when asked, or omit `--domain`) and
the gateway is set up for the server's IP address:

```bash
./install.sh --role both
```

It is then served over plain HTTP at `http://<server-ip>/`, which suits a local
network, a lab, or a first look before DNS is arranged. Nothing is encrypted in this
mode, the dashboard password included, so do not use it across the open internet.

To add a domain and HTTPS later, run the installer again:

```bash
./install.sh --domain stream.example.com --tls letsencrypt --email you@example.com
```

Stations, accounts and statistics are kept. Slave nodes can join a master that has no
domain: `scripts/add-server.sh` prints the command with the master's address in it,
and each slave needs `--insecure`.

The gateway's ports are published on every network interface (`0.0.0.0`), and Docker
opens them in the host's firewall by itself, so no `ufw` or `firewalld` rule is needed
on the server. A firewall outside the server (your hosting provider's, or your
router's) still has to allow them.

## Install on one server (both)

```bash
git clone https://github.com/blacdev/streamnode.git streamnode
cd streamnode
./install.sh --role both --domain stream.example.com
```

Run it as root or as a user in the `docker` group. The script:

1. Creates `.env` with a random database password, Redis password, engine secret,
   dashboard password and administrator API key. An existing `.env` is kept.
2. Asks how HTTPS for the domain is provided ([Certificates](#certificates)) and sets
   the certificate up accordingly.
3. Downloads the prebuilt images and starts the services ([Images](#images)).
4. Waits for the API to report healthy and prints the dashboard address and, on a
   first install, the generated credentials.

## Install a master and slave nodes

### 1. The master

```bash
./install.sh --role master --domain stream.example.com --tls letsencrypt --email you@example.com
```

A master relays no audio by itself, so the installer finishes by printing the command
for your first slave node. Give the master a real certificate, or put it behind
something that has one ([Certificates](#certificates)), before adding slaves;
otherwise every slave must be installed with `--insecure`.

Open TCP **6380** on the master to your slave nodes. It carries Redis, encrypted with
the master's certificate and protected by the Redis password.

### 2. A slave node

A new server needs nothing on it beforehand. There are two ways to connect it; both
end with the server listed under **Servers** and receiving listeners within seconds.

**Option 1: one command (the slave joins by itself).** On the master, create the
command from the dashboard (**Servers > Add server > Create install command**) or
with:

```bash
./scripts/add-server.sh
```

It prints something like:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- \
  --role slave --master https://stream.example.com --token rgj_4be1a09c...
```

Run that on the new server. It installs Docker if missing, downloads the engine and
joins the master. The token works once and expires after an hour. If the master has
no trusted certificate yet, the command includes `--insecure`.

**Option 2: finish from the master.** Install the slave without a master:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- --role slave
```

It prints the server's address, engine port and a **setup key**. On the master's
dashboard open **Servers > Add server**, enter those three values and press
**Connect server**. The master contacts the slave, completes its setup and adds it.

Slave options:

| Option | Purpose |
|---|---|
| `--name NAME` | Name shown on the master. Defaults to the server's hostname. Must be unique |
| `--advertise ADDRESS` | Address the master uses to reach this slave. Defaults to the address the join request comes from. Set it to the slave's **private** address when both servers share a private network |
| `--engine-port PORT` | Port the engine listens on. Default 3000 |
| `--insecure` | Accept a master whose certificate cannot be verified (self-signed). For testing |

Open TCP **3000** on the slave to the master only. Listeners never connect to a slave
directly, and the engine refuses requests that do not carry the master's secret.

### Growing from one server

A `both` install can take slave nodes too. On it, set `CLUSTER_BIND=0.0.0.0` in
`.env`, run `docker compose up -d`, open port 6380 to the new servers, then add slaves
as above. See [Adding servers](SCALING.md).

## Certificates

The domain's certificate can come from four places. Choose with `--tls`; without it
the installer asks. Only the master (or single server) is involved: slave nodes need
no certificate.

| `--tls` | Meaning |
|---|---|
| `letsencrypt` | The gateway obtains a free certificate and renews it |
| `provided` | You supply certificate files from any authority |
| `external` | HTTPS is handled somewhere else, in front of this server |
| `selfsigned` | A temporary certificate, for testing |

The choice is stored as `TLS_MODE` in `.env`. To change it later, re-run the installer
with a different `--tls`.

### Let's Encrypt

```bash
./install.sh --role both --domain stream.example.com --tls letsencrypt --email you@example.com
```

The hostname must already resolve to the server and port 80 must be reachable.
HAProxy forwards the validation request to a short-lived certbot container; nothing
is stopped and listeners are not interrupted.

Renewal is a daily cron entry, which the script prints for you:

```
17 3 * * * /path/to/streamnode/scripts/letsencrypt.sh renew >> /path/to/streamnode/letsencrypt.log 2>&1
```

### Your own certificate

```bash
./install.sh --role both --domain stream.example.com --tls provided \
  --cert /path/fullchain.pem --key /path/privkey.pem
```

`--cert` is the full chain; `--key` may be left out if the key is in the same file.
The installer checks the files and writes `certs/stream.pem` (chain followed by key),
which is the one file HAProxy reads. To replace it later, re-run the same command
with the new files, or:

```bash
cat fullchain.pem privkey.pem > certs/stream.pem
chmod 600 certs/stream.pem
docker compose kill -s HUP haproxy_edge     # reload without dropping listeners
```

### HTTPS handled elsewhere

Use this when a load balancer, reverse proxy or your hosting provider terminates
HTTPS for the domain and passes plain HTTP to this server.

```bash
./install.sh --role both --domain stream.example.com --tls external
```

In this mode **no certificate is created on the server and there is no HTTPS
listener**: the gateway serves plain HTTP only. It accepts the dashboard and API
without redirecting, treats those requests as HTTPS (so stream URLs and links are
`https://`), and takes each client's address from the `X-Forwarded-For` header your
proxy adds. If the proxy is on the same machine and already uses ports 80 and 443,
add `--http-port 8080`.

What the thing in front must do:

- Forward to this server's port 80 over HTTP, and add `X-Forwarded-For`.
- **Not buffer** responses, and allow connections that last for hours. A proxy that
  buffers or cuts long connections breaks continuous audio.
- Ideally also pass plain HTTP on port 80 for listeners that cannot use HTTPS.

Because the gateway trusts `X-Forwarded-For` in this mode, allow port 80 only from
the proxy; otherwise anyone connecting directly could claim any address.

With slave nodes, the domain now points at the proxy rather than at the master, so
tell slaves how to reach the master directly:

```bash
./install.sh --role master --domain stream.example.com --tls external --cluster-host 203.0.113.10
```

Slaves still join through `https://stream.example.com` and then connect to
`203.0.113.10:6380` for Redis. For that link alone the installer creates an internal
certificate (`certs/cluster.pem`), which listeners never see. The connection is
encrypted, but the certificate cannot be checked against a name, since the real
certificate lives elsewhere; see
[Security](SECURITY.md#between-master-and-slave-nodes).

### Self-signed

The default when the installer cannot ask. Browsers and most players reject it, and
slave nodes join only with `--insecure`. Plain-HTTP stream URLs work regardless.

## Verify the installation

```bash
docker compose ps                                  # every service "running" / "healthy"
curl -s https://stream.example.com/api/v1/health   # {"status":"ok",...}
```

Sign in at `https://stream.example.com/admin/`, check that **Servers** lists at least
one healthy server, add a station and open its stream URL in a player.

## Sharing ports 80 and 443 with another web server

If another web server already uses ports 80 and 443 on this machine, publish the
gateway on other ports (`HTTP_PORT=8080`, `HTTPS_PORT=8443` in `.env`), let that web
server keep the certificate, and install with `--tls external`. With nginx in front,
for example:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Changing a server's role

| From | To | Steps |
|---|---|---|
| both | master | Add at least one slave first. Then in `.env` set `ROLE=master`, `COMPOSE_PROFILES=master`, `LOCAL_ENGINE=` (empty) and `CLUSTER_BIND=0.0.0.0`, and run `docker compose up -d --remove-orphans`. The local engine stops; its listeners reconnect to the slaves |
| master | both | In `.env` set `ROLE=both`, `COMPOSE_PROFILES=master,local-engine` and `LOCAL_ENGINE=audio_engine:3000`, then `./install.sh` |
| slave | anything else | Remove it on the master (Servers > Remove), run `docker compose down -v` on it, delete its `.env`, and install again in the new role |

## Images

The gateway runs in Docker. Its two own images, the audio engine and the management
API, are built by CI for x86-64 and ARM and published to the GitHub container
registry; the installer downloads them. Nothing is compiled on your servers, which is
why a small server is enough.

| | Prebuilt images (default) | Built from source |
|---|---|---|
| How | `docker compose pull`, done by the installer | `./install.sh --build-from-source` |
| Time | About a minute | Several minutes |
| Memory needed | No more than running needs | About 2 GB while compiling |
| Use it when | Always, unless you have a reason not to | You changed the code, or the registry is unreachable |

If the images cannot be downloaded (the registry is unreachable, or nothing has been
published for your processor type), the installer says so and builds from source
instead.

**Choosing a version.** By default servers run the `latest` images, which follow the
main branch. To stay on a release, install with `--image-tag v2.4.0`, or set
`IMAGE_TAG` in `.env`. Keep the master and its slave nodes on the same tag.

**Private repositories.** Images of a private repository are private too. Sign in on
each server first, with a token that may read packages:

```bash
docker login ghcr.io -u <github-user>
```

## Updating

The gateway watches its repository for new versions, and updates are controlled from
the dashboard.

**Dashboard > Updates** (administrators) shows the running and latest versions, and
lets you:

- switch **automatic updates** on or off and choose the **time of day** (the server's
  own clock, shown on the page);
- press **Install the update now** when a newer version exists;
- see what the updater last did, and anything in its way.

A notice also appears at the top of the dashboard whenever a newer version is out.

How it works: the installer sets up a small scheduler on the server (a cron entry)
that looks every five minutes for something to do: an update requested in the
dashboard, the daily automatic update, or, on a slave node, a master to keep up with.
The services themselves never touch Docker or the host; the dashboard and the
scheduler exchange two small files in the installation's `control/` directory.

An update backs up the database (on a master), downloads the new files and images,
and restarts only the services that changed. Settings and data are kept. Restarting
an engine or the proxy disconnects its listeners for a few seconds; their players
reconnect.

| | Detail |
|---|---|
| Default | Automatic updates are off. The notice still appears |
| What is followed | The branch the server was installed from (`main` by default) |
| Slave nodes | Follow the version their master runs, by themselves, within a few minutes of the master updating. Set `UPDATE_FOLLOW_MASTER=false` in a slave's `.env` to manage it by hand |
| Just-published versions | Images take a few minutes to build after a change lands. Until they exist the update waits and tries again |
| Pinned servers | A server with `IMAGE_TAG` set to a release (e.g. `v2.4.0`) is not moved automatically. Change it with `./install.sh --image-tag <version>` |
| Going back | `./scripts/update.sh apply --sha <commit>` installs a specific earlier version. Database changes made by a newer version are not undone; restore a backup if needed |

The same from the command line, in the installation directory:

```bash
./scripts/update.sh check                  # is there a newer version?
./scripts/update.sh                        # check, ask, and install it
./scripts/update.sh auto on --time 04:15   # same switch as in the dashboard
./scripts/update.sh auto status            # also says whether the scheduler is installed
```

and through the API: `GET /system/version`, `PUT /system/update-settings`,
`POST /system/update` ([API guide](API.md#version-and-updates)). Each run is logged to
`update.log` in the installation directory.

If the server has no cron, the installer says so; install cron and run
`./scripts/update.sh schedule install`.

## Upgrading from an older version

Nothing has to be done by hand. Whichever way an older installation is brought up to
date, the installer converts it:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash -s -- --dir /opt/streamnode
```

(or, in an installation that is a git clone, `git pull && ./install.sh`). It runs
`scripts/migrate.sh`, which:

| Finds | Does |
|---|---|
| A full copy (clone) of the repository | Records the installed version, then removes the source code and other files a running server does not need |
| Settings from before roles existed | Records the server as a single server (`both`) |
| No certificate mode recorded | Works it out from the certificate in place (Let's Encrypt, your own, or self-signed) |
| Settings naming files that no longer exist, or renamed settings | Corrects them |
| The earlier daily-update cron entry | Moves it into the new updater, keeping its time |
| Missing secrets and settings added since | Generates or fills them in |

Passwords, API keys, the certificate, stations, accounts and statistics are kept. It
prints each change it makes, makes none on a second run, and never deletes a git
working copy that looks like a development copy (full history or local changes).

One case cannot be converted: a streaming server set up with the old `node/` layout
has to join its master again. The installer says so and names the command.

## Uninstalling and starting again

```bash
./scripts/uninstall.sh
```

Run it in the installation directory (`/opt/streamnode` after a one-line install).
It works on any version and any role, asks for confirmation, and then removes the
gateway's containers, network and data volumes, and the old settings and certificate.

| Option | Effect |
|---|---|
| `--keep-data` | Remove the services but keep stations, accounts and statistics |
| `--remove-code` | Also delete the installation directory |
| `--remove-images` | Also delete the gateway's Docker images |
| `--yes` | Do not ask for confirmation |

For a completely clean reinstall:

```bash
cd /opt/streamnode && ./scripts/backup.sh          # only if anything is worth keeping
./scripts/uninstall.sh --remove-code --remove-images
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/get.sh | bash
```

If the installed copy is too old to contain the script, run it straight from the
repository:

```bash
curl -fsSL https://raw.githubusercontent.com/blacdev/streamnode/main/scripts/uninstall.sh | bash -s -- --remove-code --remove-images
```

Docker itself, and anything else running in it, is left alone. On a slave, also remove
it from the master's Servers list.
