# Sazuz operator and developer reference

[← Back to the project](../README.md)

Use this reference for infrastructure, integration boundaries, recovery, and test
setup. Everyday configuration lives in the setup wizard and Settings Center.

- [Infrastructure variables](#infrastructure-variables)
- [Deployment and data](#deployment-and-data)
- [Connections](#connections)
- [Security and recovery](#security-and-recovery)
- [API reference](#api-reference)
- [Test environments](#test-environments)

## Infrastructure variables

No environment variables are required for a fresh installation. The authoritative
allowlist and validation rules are in [infra.ts](../packages/config/src/infra.ts).
Unknown `SAZUZ_*` variables fail startup. These variables configure infrastructure;
they do not replace the vault or application settings.

| Variable                     | Host default                        | Purpose                                                                                    |
| :--------------------------- | :---------------------------------- | :----------------------------------------------------------------------------------------- |
| `SAZUZ_DATA_DIR`             | `data/` under the working directory | Private generated infrastructure files; resolved to an absolute path                       |
| `SAZUZ_DATABASE_HOST`        | `127.0.0.1`                         | PostgreSQL host                                                                            |
| `SAZUZ_DATABASE_PORT`        | `54329`                             | PostgreSQL port                                                                            |
| `SAZUZ_DATABASE_NAME`        | `sazuz`                             | Database name                                                                              |
| `SAZUZ_DATABASE_USER`        | `sazuz`                             | Database user                                                                              |
| `SAZUZ_DATABASE_URL`         | Unset                               | External PostgreSQL URL; overrides separate connection fields and the generated credential |
| `SAZUZ_SERVER_HOST`          | `127.0.0.1`                         | API listen address                                                                         |
| `SAZUZ_SERVER_PORT`          | `7778`                              | API listen port                                                                            |
| `SAZUZ_WEB_PORT`             | `7777`                              | Host web port                                                                              |
| `SAZUZ_SERVER_URL`           | Derived from API host and port      | Web proxy and worker broker upstream; wildcard listen hosts resolve to loopback            |
| `SAZUZ_DOCKER_PROXY_URL`     | `http://docker-socket-proxy:2375`   | Validating container-control proxy                                                         |
| `SAZUZ_EGRESS_PROXY_URL`     | `http://egress-proxy:8080`          | Execution egress proxy                                                                     |
| `SAZUZ_BROWSER_URL`          | `http://browser:7779`               | Browser service                                                                            |
| `SAZUZ_WORKSPACE_VOLUME`     | `sazuz_sazuz_workspace`             | Docker workspace volume name                                                               |
| `SAZUZ_EGRESS_SOCKET_VOLUME` | `sazuz_sazuz_egress`                | Docker egress socket volume name                                                           |

Provider keys belong in the vault. Keep external database URLs out of committed
files, screenshots, and logs. Changing database names/users/passwords does not
reconfigure an already initialized PostgreSQL cluster.

The production Compose file supplies its own container addresses and ports.
Host-shell values are not automatically forwarded into every container. Use an
explicit Compose override for advanced production changes, including matching
port publication and health probes.

In host development, `pnpm dev` forwards the validated data directory and local
database host/port/name/user to its Compose database. It provisions only a
loopback database. An unavailable external database is reported as an error.

## Deployment and data

### Installation paths

The [shell installer](../install.sh) and [PowerShell installer](../install.ps1)
require Docker Engine 26+ and Compose 2.24.4+. A source checkout builds locally.
A prepared release bundle uses immutable images from its release override.
The installers choose a free loopback port starting at 7777, retain it in
`data/compose.install.yaml`, and install the operator CLI wrapper.

For an unmodified source checkout, direct Compose also works at the default port:

```sh
docker compose up --build --detach --wait
docker compose exec server node /app/dist/cli.js setup-token
```

This path does not provide installer port selection or CLI PATH setup. Keep using
the same Compose project/files for subsequent operations. Open the printed or
configured local `/setup` address and enter the token privately.

### Preserve the selected release

For installer-managed deployments, preserve this file order whenever those files
exist:

1. `deploy/compose.yaml` — base service definition.
2. `deploy/compose.release.yaml` — present in a prepared release bundle.
3. `data/compose.install.yaml` — saved installation port.
4. `data/compose.release.yaml` — selected update, when activated.

Include each using `-f` in that order. Rerunning the installer and using the
installed `sazuz` wrappers preserves these release overrides. Omitting them from
a manual restart can select the wrong images. The base Compose project name is
`sazuz`; specify `-p sazuz` when using the installer-generated override directly.

`--profile browser` enables the browser service. `--profile voice` enables local
Whisper and Piper services. Retain the profiles when bringing optional services
back up, and configure their endpoints/models in Settings. The current Compose
file does not bundle an Ollama or SearXNG profile; host those separately if needed.

### Retained state

| Storage                          | Contents                                                                                        |
| :------------------------------- | :---------------------------------------------------------------------------------------------- |
| `sazuz_data` volume              | Generated session, machine, operator, and notification keys; other private application data     |
| `postgres_data` volume           | Settings and history, identities, encrypted vault records, durable jobs, and execution evidence |
| `sazuz_workspace` volume         | Project files shared by the server and worker                                                   |
| Host `data/compose.install.yaml` | Chosen installation port                                                                        |

Compose prefixes volume names with its project name. Preserve the volumes and
deployment files together. `docker compose down` retains named volumes;
`docker compose down --volumes` deletes them. Prefer a verified encrypted backup
before moving or recreating a deployment.

## Connections

Configure an account in Settings/Connectors, store its credential in the vault,
scope it to a specific resource, and grant the corresponding tools/account
permissions to an agent. Adding an account does not automatically authorize agents.

| Integration           | Important boundary                                                                                                          |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| Google                | Gmail/Calendar and Drive/Sheets/Docs use official APIs; OAuth uses the configured client, exact callback, and narrow scopes |
| Microsoft             | Delegated Graph access for mail, calendars, and OneDrive; tenant consent can be required                                    |
| Slack / Discord       | Official bot tokens and scoped channels; no personal-token or self-bot automation                                           |
| WhatsApp              | Official Cloud API or separately enabled, unofficial QR linked-device sessions; credentials stay in the vault               |
| GitHub                | Repository-scoped credentials; draft PR creation uses existing branches                                                     |
| Stripe                | Balance and invoice reads only; no payment or money movement tools                                                          |
| DAV / Jira / webhooks | Configured public HTTPS endpoints, credential isolation, and bounded operations                                             |
| MCP HTTP              | Inspect tools, review effects and agent grants, and save a pinned installation revision                                     |
| MCP stdio             | Reviewed immutable image, no networking or credential injection in the initial stdio profile                                |
| Local Bridge          | Outbound WSS companion, permitted folders and fixed command vectors; no inbound laptop port                                 |

For OAuth, register the exact callback shown by the instance, normally
`/oauth/google/callback` or `/oauth/microsoft/callback` at its configured origin.
Store client secrets in the vault. Real account consent, provider policy, and
credentials must be verified against your own service; protocol tests do not
provision an account.

Unmapped MCP tools default to an unknown write and ask for approval. A changed
catalogue requires review. Remote OAuth for arbitrary MCP products is not
implemented; use a supported official bearer credential. Incoming MCP clients
receive explicit project-scoped grants at `/mcp` and cannot approve their own
consequential actions.

For the local companion, the verified package commands are:

```sh
pnpm --filter @sazuz/bridge-cli start pair
pnpm --filter @sazuz/bridge-cli start run
```

Pair a device through Connectors first. The companion prompts for its server,
device/project identifiers, credential, local vault passphrase, and folder/command
scopes. Keep its state directory outside agent-accessible folders.

Source references: [connectors](../packages/connectors/src/index.ts),
[MCP](../packages/mcp/src/index.ts), [Bridge](../apps/bridge/package.json).

## Security and recovery

### Execution and hosting boundaries

Run budgets, policy decisions, account scopes, taint, and durable effect receipts
are enforced by the runtime. Secrets are resolved for execution and redacted;
APIs do not return stored plaintext credentials. Browser logins, 2FA, and CAPTCHA
challenges require human takeover.

Code sandboxes use non-root Docker containers with a read-only root filesystem,
dropped capabilities, resource limits, and network off by default. The validating
socket proxy mediates container operations; the application and worker do not
receive the raw Docker socket. Configured outbound access uses controlled egress.
Linux container isolation must be tested on a Docker host.

For remote use, configure the final HTTPS origin in General settings. Keep the
database, internal API, browser service, and Docker control plane private. Forward
WebSocket upgrades for live browser access and `/bridge` through your reverse
proxy. A host administrator controlling the running process remains trusted and
can inspect process memory.

### Vault and account recovery

- **Auto:** the host machine key unlocks the vault after restart. Access to both
  disk state and that key can expose stored credentials.
- **Strict:** the owner unlocks the vault after each server restart with the
  passphrase or recovery key. Login and TOTP still work while it is locked.
- **Passkeys:** use `localhost` or the final HTTPS hostname; literal IP RP IDs are
  unsupported. Credentials remain bound to their enrolled hostname.
- **Audit exports:** retain a trusted export/head outside the instance to detect
  tampering by someone who can rewrite the database.

The installed CLI supports:

```sh
sazuz doctor
sazuz pause
sazuz resume
sazuz unlock
sazuz reset-admin
```

`unlock` and `reset-admin` prompt privately. Resetting the admin password revokes
sessions, passkeys, pending authentication challenges, TOTP enrollment, and push
devices. It does not change the vault passphrase; enroll those credentials again
after signing in.

### Backups, restores, and updates

Create or schedule encrypted backups in Settings. Download the `.sazuz` archive
and retain its original recovery kit/passphrase outside the host. Existing
backups retain their original encryption envelopes when recovery credentials
change. The supported plaintext archive limit is **128 MiB**; recovery needs
additional free memory. Off-site replication is an operator responsibility.

Restore to the matching release through **Welcome → Restore from backup** before
creating an owner, or use the operator restore command. Migration identity is
checked. Restores revoke sessions, disable triggers/channels, cancel nonterminal
historical work, and leave execution paused. Inspect the restored state and
external effects before re-enabling work.

The host update command takes a backup before activation and supports recovery
from a failed update. Use a reviewed release manifest and keep the matching
deployment bundle, especially when optional-service protocols change. Native
Docker update/rollback and fresh-host restore still need release acceptance.
See [operator command implementation](../apps/cli/src/commands.ts) and
[operations implementation](../packages/ops/src/index.ts).

## API reference

The direct API server's OpenAPI document is available at `/api/openapi.json`. Route
schemas are generated from the registered Fastify definitions. Some legacy routes
perform zod validation inside their handlers, so consult the route implementation
when the generated schema does not include the full request contract.

```sh
curl --fail http://127.0.0.1:7777/api/health
# Direct API in host development:
curl --fail http://127.0.0.1:7778/api/openapi.json
```

`GET /api/health` returns 200 for healthy core services and 503 for degraded
health. Host development exposes the API directly at port 7778. The web proxy
returns 404 for the OpenAPI document; access it through the trusted direct API.
Production keeps that server internal. Workspace clients use the configured
web origin and its same-origin proxy for approved application endpoints.

| Route family                                       | Purpose                                                                 |
| :------------------------------------------------- | :---------------------------------------------------------------------- |
| `/api/setup/*`, `/api/auth/*`                      | Setup token gate, owner authentication, and session lifecycle           |
| `/api/settings`, `/api/settings/:namespace`        | Validated configuration, versioned writes, and history                  |
| `/api/projects`, `/api/threads`                    | Projects and conversations                                              |
| `/api/threads/:id/chat`                            | Submit a chat turn; streamed events include text, tools, and run status |
| `/api/missions`, `/api/missions/:id/graph`         | Durable missions and task graphs                                        |
| `/api/approvals`                                   | Owner review inbox                                                      |
| `/api/agents`, `/api/agents/:id/versions`          | Agent definitions and revisions                                         |
| `/api/workflows`, `/api/workflows/:id/runs`        | Workflow definitions and executions                                     |
| `/api/kb/sources`, `/api/memory`, `/api/skills`    | Knowledge sources, memories, and reusable skills                        |
| `/api/costs/dashboard`, `/api/evals`, `/api/audit` | Accounting, evaluations, and audit evidence                             |
| `/api/backups`                                     | Owner backup operations                                                 |
| `/mcp`                                             | Project-scoped external agent access via Streamable HTTP                |
| `/hooks/:id`                                       | Signed incoming webhook delivery                                        |

Workspace requests require an authenticated owner session. Mutating requests
must satisfy same-origin and JSON content-type checks. Settings writes carry
`expectedVersion` for conflict detection. Durable submission routes use request
IDs where their schemas require them; reuse the same ID after an ambiguous
submission rather than creating another side effect.

The operator API uses its separate local operator credential and is restricted
to loopback. Use the CLI instead of exposing that credential to clients.
Incoming MCP uses a separately granted vault-backed bearer token; it is not a
general-purpose API token. Never place credentials in URLs.

Source entry points: [API factory](../apps/server/src/app.ts),
[route registration](../apps/server/src/index.ts),
[shared contracts](../packages/core/src/index.ts),
[settings contracts](../packages/config/src/settings.ts).

## Test environments

Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` from the repository root using
the pinned runtime. These are required before a commit. Integration/coverage
tests use real PostgreSQL and default to isolated Testcontainers databases.

Install Playwright's Chromium before browser tests:

```sh
pnpm exec playwright install chromium
```

On Linux, add `--with-deps` if browser system libraries are needed. Browser tests
target an already running application unless using `pnpm test:dev`.

| Test-only control               | Meaning                                                                                                                                  |
| :------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------- |
| `SAZUZ_TEST_DATABASE_URL`       | Existing dedicated PostgreSQL/pgvector test database; name must end in `_test`, with no existing installation/settings/worker heartbeats |
| `PLAYWRIGHT_BASE_URL`           | Disposable target origin; default `http://127.0.0.1:7777`                                                                                |
| `PLAYWRIGHT_CHANNEL`            | `chromium`, `chrome`, or `msedge`; default `chromium`                                                                                    |
| `PLAYWRIGHT_MODE`               | `production` or `development`; default `production`                                                                                      |
| `PLAYWRIGHT_SETUP_DATA_DIR`     | Disposable instance's private setup-token directory for full onboarding and authenticated acceptance                                     |
| `PLAYWRIGHT_RESTORE_BASE_URL`   | Separate fresh restore target for wizard restore tests                                                                                   |
| `PLAYWRIGHT_RESTORE_DATA_DIR`   | Restore target's private setup-token directory                                                                                           |
| `PLAYWRIGHT_MODEL_FIXTURE_HOST` | For Docker acceptance, `host.docker.internal` with `deploy/compose.e2e.yaml`                                                             |

These configure tests, not end-user settings. Do not pass `SAZUZ_TEST_DATABASE_URL`
into normal application startup. Browser acceptance changes settings and creates
synthetic identities; it must not target a personal installation. Tests requiring
the private setup/restore fixtures skip when those controls are absent.

`pnpm test:dev` manages its own host services; stop existing services on ports
7777/7778 first. `pnpm test:frontend` follows the existing browser suite on the
same disposable instance. Hosted CI and native container checks are separate
from local UI verification.

Source references: [Playwright configuration](../playwright.config.ts),
[integration configuration](../vitest.integration.config.ts),
[frontend configuration](../tests/frontend/playwright.config.ts).

---

[Back to Sazuz](../README.md) · [License and permissions](../LICENSE)
