# S2A, channels and MCP

This guide describes the S2A and messaging additions to the published platform. They use the existing setup,
vault, PostgreSQL settings and durable worker. No user-edited environment file is required.

## Install or update

Use the existing `install.ps1` / `install.sh` installer, or run
`docker compose up --build --detach --wait` from the complete source directory.
The root `compose.yaml` includes `deploy/compose.yaml`; the build uses `deploy/Dockerfile`.
There is no separate integration service to install. Bootstrap generates infrastructure
credentials and the migration role applies the two new schema migrations before startup.
Keep the database, infrastructure keys and workspace volumes when updating.

Open `/setup` for a fresh instance. On an existing instance, unlock the vault in `/settings`,
create a project in `/chat`, and open `/channels`, `/mcp-connections` or `/s2a` from the workspace navigation.
Official channel webhooks require a public HTTPS address; set the public instance URL in Settings.
Local QR sessions and manual S2A runs do not require a public webhook URL.

## Channels

Create credentials in the Settings vault and select their references in Channels. APIs return
masked metadata and references, never credential values. Each connection has one project,
an explicit sender allowlist and an optional conversation allowlist. Empty sender lists accept
no inbound tasks. Save after changing configuration; concurrent stale saves are rejected.

| Channel             | Setup                                                                                 | Inbound and reply behavior                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram            | Existing pairing and bot controls at `/automations`                                   | Existing paired tasks, approvals and notifications are preserved.                                                                                                                               |
| Discord             | Bot token, application ID, Ed25519 public key; set the displayed interaction URL      | Register `/sazuz` with a required string option `task`. Allow the user and channel IDs. Replies disable mentions.                                                                               |
| Slack               | Bot token, app ID, signing secret; set the displayed Event Subscriptions URL          | Subscribe to `app_mention` and `message.im`; grant `app_mentions:read`, `im:history`, `chat:write`. Mention replies stay in the originating thread.                                             |
| WhatsApp Cloud API  | Access token, phone number ID, Graph API version, Meta app secret, verification token | Subscribe to message webhooks. Use digits-only international sender numbers. Text replies obey WhatsApp's messaging window; template messages are not implemented.                              |
| WhatsApp QR session | Enable and save, then choose **Connect / show QR**                                    | Scan from WhatsApp → Linked devices. This optional normal-account transport is unofficial. Allow sender JIDs such as `15551234567@s.whatsapp.net`; some accounts use a numeric `@lid` identity. |

Discord bots need permission to view the selected channels and send messages. Create the slash
command through Discord's official application-command API; Sazuz does not overwrite an app's
command list. Slack apps must be installed in the workspace and invited to selected channels.

Incoming events are authenticated, bounded and deduplicated before mission creation. Channel
tasks are untrusted input and taint the run. Results and approval-status links go back to the
configured project conversation using durable delivery receipts. Review consequential actions
in `/approvals` or the linked mission. New channels do not implement approval buttons inside chat.

QR codes are temporary and visible only through authenticated APIs. Device credentials and
signal keys live in the encrypted vault, with no session files. Restart restores a saved session
when the vault is unlocked. Strict vault mode requires unlocking after restart. **Unlink device**
removes the saved keys; logout from the phone also clears the connection's keys. Linking does
not import history. QR mode supports direct text, not groups, attachments or calls. Because the
client is unofficial, compatibility and account restrictions depend on WhatsApp.

The `channel.send` tool is included in the default Comms definition. Existing customized agents
can grant `channel.*` from `/agents`. Select Comms on an S2A Tool node to send through it. It requires
an enabled connection, the same project, an allowed recipient and the usual send policy.
For Slack or Discord proactive sends, set conversation IDs explicitly. A failed or uncertain
delivery is not blindly retried; inspect the mission or delivery record before resolving it.

## MCP connections

1. Add a remote server at `/mcp-connections` with its **HTTPS Streamable HTTP** endpoint.
2. If needed, select a bearer token from the vault. Credential-bearing URLs are rejected.
3. Discover tools. Review every tool's arguments, effect and agent access.
4. Enable the intended tools, enable the connection and save.
5. In `/agents`, grant the selected agents `mcp_connection.*` or the specific tool name shown
   in the S2A tool catalogue. Current and pinned agent permissions both apply.

Discovery clears earlier permissions: every discovered tool starts disabled with an unknown
effect. Unknown effects require approval. Select the agents that may use each connection.
S2A tool and agent nodes execute under their selected identity, with that agent's tool grants,
connector account permissions, model role and budget. Agent access alone never overrides a deny.

The client negotiates protocol versions, initializes sessions, handles JSON or SSE responses and
bounded paginated discovery. Every execution checks the current configuration and the live input
schema against the reviewed schema. Remote results are untrusted and use existing policy,
budget, checkpoint and credential-broker controls. Session-cleanup status is recorded separately
from a completed tool result, so a failed DELETE cannot turn a completed action into a failed action.

Only public HTTPS targets are accepted. DNS is checked and pinned; private addresses and redirects
are rejected. Queries, fragments and embedded credentials are not allowed in endpoint URLs.
Input schemas must be supported by the validator; references, regex patterns, unevaluated-property
rules and excessive nesting are rejected. Discovery is capped at 100 tools. Unsupported servers
fail explicitly rather than silently weakening argument validation.

The existing `/connectors` screen continues to manage project MCP installations, including
sandboxed stdio and its reviewed catalogues. The existing `/mcp` endpoint remains the Sazuz MCP
server for authorized clients. The additional settings-based client uses the bounded HTTPS
transport described here; it does not replace those facilities or support arbitrary host commands.

## S2A Studio

Create a workflow at `/s2a`, choose its project and add nodes. Connect nodes by dragging handles
or by using **Selected node**, **Next node**, **If yes** and **If no**. Set the entry with
**Set as start**. Every node must be reachable and the graph must be acyclic (maximum 50 nodes).

| Node      | Purpose                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| Data      | Create or map JSON data without calling a model.                                   |
| Tool      | Execute a registered tool with validated JSON arguments and normal policy checks.  |
| Agent     | Ask a selected specialist to complete a bounded task using its permitted tools.   |
| Condition | Compare values using equals, not-equals, contains or exists and choose one branch. |
| Approval  | Pause for explicit human approval before continuing. A deny policy still wins.     |

Field mapping applies to Data values, Tool arguments, Condition values and Approval messages.
An exact reference such as `{{input.customer}}` or `{{nodes.prepare}}` preserves the JSON value's
type. References inside strings interpolate text. Paths can traverse JSON objects and array
indices; prototype paths and unavailable values fail explicitly. Node output and total output
sizes are bounded. Keep credentials in the vault rather than putting them into workflow inputs.

**Save revision** creates an immutable version. **Publish revision** selects the version used
for new runs. **Run workflow** accepts a JSON object and creates a durable mission. Existing runs
keep their original graph and input when you edit or publish. If the browser reports an unresolved
run request, retry with unchanged input in the same editor; it reuses the request ID. After closing
the editor or reloading, inspect run history before starting another run.

The worker checkpoints each step, suspends for approvals, enforces step/cost/time budgets and
stops on a failed or denied node. Resume uses the existing intent/execute/done protocol. A remote
tool without conclusive verification can require human reconciliation after an interrupted action;
no general exactly-once guarantee is claimed for third-party APIs.

Tool nodes expose an **Executing agent** selector. Imported tool nodes without an agent default
to Chief of Staff; grant that identity the required tools or select a suitable specialist.
Data, condition and approval nodes use the workflow's internal controls. Their presence does
not give agents access to other tools. Workflows with no Agent nodes skip model context retrieval;
if the project requires an AI Auditor, configure a workflow that permits model use or change
the project's review setting before running a deterministic workflow.

Open **Run on a schedule** to save a cron expression, IANA timezone and JSON input. Scheduled runs
use the published revision. After downtime, one missed occurrence is recovered and earlier missed
occurrences are skipped. The occurrence request ID prevents a crash between mission creation and
timer advancement from submitting that occurrence twice. Global pause also pauses scheduling.

Import and export use S2A JSON documents containing `name`, `description` and `graph`. Imports
are validated and limited to 100 KB. Run history links to the ordinary mission timeline.

## Add your own module

Developer-defined tools can become S2A Tool nodes. Define the tool with `defineTool` in a package,
give it zod input/output schemas, declare its effect and register it in both the API tool catalogue
and worker. Add credential-broker authorization if it uses a secret. Give side-effecting tools a
verification hook where the upstream API can conclusively identify the operation, and test the
interrupted/resumed path. Keep provider-specific model code in `packages/llm`.

Alternatively, implement a remote MCP server and add it through `/mcp-connections`; that requires no Sazuz
code change within the supported transport/schema subset. There is no arbitrary uploaded-code
module runner in S2A. S2A's graph format is acyclic and sequential. The existing `/workflows`
engine retains its separate reviewed workflows, maps, waits and advanced nodes. Channel-to-S2A
bindings and an S2A module marketplace are not implemented.

## Verification with real services

Automated channel and MCP tests use protocol fixtures. For each deployed connection, verify:

1. Configure real credentials and HTTPS ingress; complete Slack/Meta verification or Discord ping.
2. Send one allowed task and confirm one mission; replay its webhook and confirm no second mission.
3. Check a blocked sender, a bad signature, threaded replies and a result link to the correct project.
4. Pair QR mode with a consenting test account; test restart, strict-vault unlock, phone logout and unlink.
5. Discover a real MCP server, review a read tool, run it in S2A and verify approval for an unknown effect.
6. Interrupt a workflow at an approval, restart the worker, resume and check for a single external effect.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` before publishing changes.
Database regressions use `pnpm test:integration` with an empty, dedicated test database.
Use the credential-dependent steps above to verify each deployed connection.
