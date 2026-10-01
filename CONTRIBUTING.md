# Contributing

## Layout

| Path | What it is |
|---|---|
| `rust_src/` | Audio engine (Rust) |
| `admin_src/` | Management API and dashboard (Node.js); `migrations/` holds the database schema |
| `haproxy.cfg`, `docker-compose.yml` | Edge proxy and service definitions for every role |
| `install.sh`, `get.sh`, `scripts/` | Installers and operational scripts |
| `edge/`, `demo/` | Optional edge server; demo source for local testing |
| `docs/` | Documentation |

## Running the tests

```bash
cd rust_src && cargo test
cd admin_src && npm ci && npm test
```

The same checks, plus configuration validation and image builds, run in CI on every
push and pull request (`.github/workflows/ci.yml`).

## Trying a change end to end

```bash
./scripts/try-local.sh          # master, local engine, demo station and a slave node
./scripts/try-local.sh loadtest
./scripts/try-local.sh reset
```

## Conventions

- **Database changes** go in a new numbered file in `admin_src/migrations/`. Never edit
  a migration that has been released; add another.
- **API changes** are reflected in `admin_src/src/openapi.js` and `docs/API.md`.
- **New settings** are documented in `docs/CONFIGURATION.md` and, for master settings,
  `.env.example`.
- **User-visible changes** get an entry in `CHANGELOG.md`.
- Keep the documentation in step with the behaviour in the same change.

## Reporting security problems

Please report suspected vulnerabilities privately to the maintainers rather than in a
public issue. See [docs/SECURITY.md](docs/SECURITY.md).
