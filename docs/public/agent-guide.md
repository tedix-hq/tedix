---
sidebar:
  order: 90
title: "Agent guide"
topic: "Getting started"
resource_type: guide
description: "A machine-readable entry point for agents researching or operating Tedix."
summary: "Public routing, source-priority, discovery, and evidence rules for agents"
read_when:
  - Giving an AI agent context about Tedix
  - Researching Tedix without repository access
  - Operating Tedix through the CLI or an MCP gateway
visibility: public
---

# Agent guide

Start here when an agent needs to research Tedix or operate a Tedix
organization. Choose the path that matches the task:

| Task                             | Start here                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Answer a public product question | Use the documentation endpoints below. No login is needed.                                                               |
| Evaluate Tedix on one computer   | Follow the [local path](./getting-started.md#run-tedix-locally). It does not connect to Tedix Cloud or run remote tedis. |
| Run a Cloud worker               | Sign in to an invited beta organization, then follow [Your first digital worker](./learning-paths/first-worker.md).      |
| Change the source repository     | Read the root and nearest scoped `AGENTS.md` files before editing.                                                       |

## Documentation endpoints

Start with the smallest sufficient source:

| Need                         | Endpoint                                        |
| ---------------------------- | ----------------------------------------------- |
| Page inventory and summaries | `https://docs.tedix.dev/llms.txt`               |
| Complete public corpus       | `https://docs.tedix.dev/llms-full.txt`          |
| Human navigation             | `https://docs.tedix.dev/`                       |
| Page Markdown                | Follow the Markdown URL advertised on each page |
| Public REST API catalog      | `https://api.tedix.dev/openapi.json`            |
| Human API reference          | `https://api.tedix.dev/docs`                    |

Prefer `llms.txt`, select the relevant page, and fetch only that page's
Markdown. Use `llms-full.txt` when the task genuinely requires cross-document
analysis. Do not infer private implementation details from absent public
material.

The OpenAPI document describes only the curated public `/v1/*` REST surface.
It does not enumerate private oRPC procedures or authenticated MCP tools.

## First Cloud connection

For an owner testing the Cloud beta, install the [CLI](./cli.md) and run
`tedix login`. The command opens Tedix OS in a browser. Pause while the owner
signs in, accepts any invitation or consent request, and creates or selects an
organization. After the owner selects an organization, the CLI saves a local
connection profile and receives its grant through OAuth; do not ask for a
password, browser cookie, or token. An approved new owner can create their own
organization without joining the inviter's organization. If beta approval is
pending, the owner may need to rerun `tedix login` after admission. If an
invited organization is missing, ask the inviter to confirm access.

Run `tedix auth status` to check the selected workspace and granted scopes.
That login authenticates the **owner**, not the agent. For continuing work under
an attributable agent identity, use `tedix agent start --help`, then start an
external-agent session from the owner's authorized workspace. The CLI reads the
harness session id (`CLAUDE_CODE_SESSION_ID` or the Codex chat id); set
`TEDIX_AGENT_SESSION` only when the harness supplies none. The first bootstrap
names the profile's principal for the machine and user
(`local-<user>-<machine>`) unless you pass `--agent-key`; every later Claude
Code or Codex session on that profile gets its own Agent-Session under the same
principal. On the first bootstrap, pass `--agent-scopes` with only the MCP
capabilities the task needs; omitting it requests the default broad capability
set. Set `TEDIX_EXTERNAL_AGENT` to the principal key for subsequent CLI calls
and check `tedix agent status` before acting.

A host that reaches Tedix only through the MCP plugin calls
`start_external_agent_session_for_host` once, then passes the returned session
id as `agentSessionId` on each `code` call that should run as that session. The
session is bound to the signed-in owner and counts as the same party as the
owner: it can start Work Attempts but never approves, corroborates or reviews
its owner's work. Start with a read-only tool discovery or a bounded task, then
inspect its result. The owner remains responsible for identity and any
human-required consent; an agent session does not become the organization
owner.

For a first worker run, do not bootstrap an external-agent identity. Use the
bounded [first-worker tutorial](./learning-paths/first-worker.md), which targets
one named tedi and shows how to verify that the worker actually ran.

## Source priority

For public product questions, use this order:

1. Versioned release manifests and live documented behavior.
2. Public contracts, schemas, and source on `main`.
3. The current public documentation corpus.
4. Marketing summaries.

State when a claim is an inference. `main` has no compatibility or support
promise; do not present it as a stable release.

## Authenticated operation

Use the installed `tedix` CLI when an operator has authorized access to an
organization:

```bash
tedix -w acme auth status
tedix -w acme ask "Summarize the active work and cite its evidence."
```

Here and below, replace `acme` with the authenticated CLI workspace.

Choose the lane deliberately:

| Lane                        | Use it for                                                       |
| --------------------------- | ---------------------------------------------------------------- |
| Home via `tedix ask`        | Durable work, rationale, approvals, delegation, and run evidence |
| Code Mode via `tedix code`  | Direct, bounded discovery and stateless calls                    |
| Work Items via `tedix work` | Atomic claim, coordination, proof, and settlement                |

For Code Mode, discover first:

```bash
tedix -w acme code \
  'async () => await discover.search({ query: "work items", limit: 5 })'
```

Request `includeParameters: true` only for the few callables you intend to use.
Never invent a callable, namespace, schema, or permission.

### Delegate from a lead session

When one lead session talks to the user and hands work to subagents or other
sessions, register each hand-off as a Work Item in one call:

```bash
tedix -w acme work delegate "Rewrite the CLI reference" \
  --done-when "docs:public:check passes on main" --via subagent --to docs-pass
```

The command reuses an open Work Item with the same title, or creates and
accepts one, then comments the brief. It is tagged with the lead session's
id, so with the Tedix plugin hooks on, each prompt in that session lists its
open delegations, at most eight. Other sessions do not see them. Settle one
with its outcome:

```bash
tedix -w acme work delegate --done <id> --note "Merged; docs check green"
```

## Authority and evidence rules

- Read-only discovery does not authorize a mutation.
- Treat write-capable calls as production changes to the selected organization.
- Human-required consent, MFA and user presence belong to the human. Other
  approvals go to the designated independent principal, which may be a tedi.
- A queued workflow, green test, commit, or health check proves only itself.
- For completion, read the settled run or task, relevant artifacts, mutation
  receipt, and live target state.
- Preserve `supportedClaims`, `unsupportedClaims`, and evidence references from
  tool results. Do not upgrade partial evidence into a stronger claim.
- Never request, print, or persist browser cookies, OAuth grants, API keys, or
  secret-provider values.

## Repository agents

The public [tedix-hq/tedix](https://github.com/tedix-hq/tedix) repository has a
root `AGENTS.md` with scoped repository rules, validation commands, and
architecture invariants. Read it and the nearest scoped `AGENTS.md` before
changing files. The [coding-agent operating manual](./AGENTS.md) is the same
guide on this site.

For a human first run, continue with [Getting started](./getting-started.md).
