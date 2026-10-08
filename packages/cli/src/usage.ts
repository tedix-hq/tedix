export function chatUsage(): string {
	return `Tedix Home

Open the interactive Home interface, or send one durable turn and exit.
Home preserves the conversation, rationale, delegation, approvals, and run evidence.

Usage:
  tedix
  tedix chat [message]
  tedix ask <message>
  tedix chat -p <message>

Options:
  -p, --prompt <text>          Send one message and exit
  -c, --conversation <id>     Reuse a Home conversation
  --thread <name>             Use or create a named local thread
  --delegate-to-tedi <id>     Force delegation to one tedi
  --work-item <uuid>          Bind --delegate-to-tedi to an existing Work Item
  --verify <cmd>              With --delegate-to-tedi: the tedi must run this
                              exact command and quote its output under
                              "Verification output:" before reporting; a
                              success report without it is treated as partial
  --require-code-proof        With --delegate-to-tedi: demand a repo_commit sha
                              or PR ref and add coding tool guidance
  --no-poll                   Return after dispatch
  --json                      Print machine-readable output
  -w, --workspace <name>      Use a saved workspace
  -h, --help                  Show this help

Exit 3 means the server run is still active, not failed. Run
\`tedix help exit-codes\` for the complete contract.
`;
}

export function loginUsage(): string {
	return `Tedix Login

Sign in through Tedix OS and save the workspace locally. Tokens are never
printed by this command.

Usage:
  tedix login
  tedix login <org>
  tedix login --workspace <name> --url <gateway-mcp-url> --org <tenant-id>

Options:
  -w, --workspace <name>      Name the saved workspace
  --url <mcp-url>             Use an explicit OAuth resource
  --org <tenant-id>           Required with an explicit Tedix gateway URL
  --scope-profile <profile>   Restrict choices: read, member, admin, or platform-admin
  -h, --help                  Show this help

Use \`tedix auth status\` after login to verify the selected workspace and target.
`;
}

export function authUsage(): string {
	return `Tedix Auth

Inspect the selected credential source, workspace, tenant hints, and target URLs.
Secrets are never printed.

Usage:
  tedix auth status
  tedix auth status --json
  tedix -w <workspace> auth status

Options:
  -w, --workspace <name>      Inspect a saved workspace
  --json                      Print machine-readable output
  -h, --help                  Show this help
`;
}

export function agentUsage(): string {
	return `Tedix External Agent Sessions

Create and close a gateway-verified coding-harness identity. An active session
is required to start governed attempts or record their lifecycle evidence.

Usage:
  tedix agent start --agent-harness-version <version> --model-provider <provider> --model-id <id> --model-version <version> [--agent-key <key>] [--display-name <name>]
  tedix agent status
  tedix agent rename [--display-name <name>]
  tedix agent checkpoint <work-item-id> --note <summary> --idempotency-key <key>
  tedix agent finish [work-item-id] [--no-handoff-reason <reason>]
  tedix agent finish --zero-work-reason <reason> --idempotency-key <key>
  tedix agent reconcile [--stale-before <iso>]

Options:
  --agent-key <key>           Principal key at first setup (default: local-<user>-<machine>)
  --agent-harness <name>      Harness name (auto-detected when possible)
  --agent-scopes <csv>        Requested gateway scopes
  --artifact-ref <ref>        Evidence reference for a checkpoint
  --json                      Print machine-readable output
  -w, --workspace <name>      Use a saved workspace
  -h, --help                  Show this help

Agent session writes are governed production mutations. Subagents do not own
the parent session or its Work Item attempt.

Rename changes only the principal's display name (default: the machine and
user); its key stays fixed because commit provenance refers to it.

Use --zero-work-reason only when this session never started a Work Item attempt;
it records an explicit audited zero-work disposition and closes the session.
Use --no-handoff-reason only for a named Work Item after its Attempt is settled.
`;
}

export function codeUsage(): string {
	return `Tedix Code Mode

Directly execute JavaScript against the selected workspace's MCP gateway.
This path is stateless: it does not create a Home run, rationale, or
audit trail. Normal gateway authorization and telemetry still apply.

Usage:
  tedix code "<js>" [options]
  tedix [options] code "<js>"
  cat snippet.js | tedix code [options]

Write a JavaScript expression, normally an async arrow function. Do not use a
bare top-level return statement.

Gateway-native steps:
  1. Discover: discover.search({ query, limit })
  2. Inspect exact inputs only when needed: includeParameters: true
  3. Call the returned namespaced tool directly

Examples:
  tedix code 'async () => await codemode.__runtime()'
  tedix code 'async () => await discover.search({ query: "gmail", limit: 3 })'
  tedix code 'async () => await discover.search({ query: "gmail search threads", limit: 1, includeParameters: true })'
  tedix code 'async () => await google_gmail_tedix.search_threads({ query: "newer_than:1d", pageSize: 1 })' --json
  tedix -w tedix code 'async () => (await codemode.__runtime()).appSlug'

Options:
  -w, --workspace <name>       Use a saved workspace's gateway and login
  --url <mcp-url>              Override the MCP gateway URL
  --local                      Use the local development MCP edge
  --json                       Print compact machine-readable JSON
  --meta                       Include executionId, result identity, and logs
  --approve-destructive <why>  Approve this call's destructive prompt with an audit reason
  -h, --help                   Show this help

Global options may appear before or after the command. Keep discovery limits
and returned values narrow; once the namespace and schema are known, call the
target directly. Destructive approval is call-local and never persists for a
later command.
`;
}

export function updateUsage(): string {
	return `Tedix CLI Update

Install checksum-verified public releases only when the user asks. The active
standalone binary remains present throughout activation, and one verified
previous binary is retained for rollback.

Usage:
  tedix update                  Install the latest release
  tedix update <version>        Install an exact release
  tedix update --check          Check the latest release without installing it
  tedix update --check <version> Verify and compare an exact release
  tedix rollback                Restore the previous standalone binary

Options:
  --force                       Reinstall or explicitly downgrade the target version
  --json                        Print machine-readable output
  -h, --help                    Show this help

Source checkouts may check releases but cannot mutate a standalone installation.
`;
}
