# Working on Tedix

Tedix is a platform for agents, apps, and work. It gives teams and AI agents
a shared place to coordinate projects, use tools, and keep results. Company
information, working instructions, tasks, and approvals stay together so
people can see what happened and what needs attention.
Read `README.md` for the introduction, `docs/public/index.md` for guides,
and `docs/public/release-status.md` for what is available today.

## Before you edit

- Find the related Tedix Work Item and claim it with `tedix work start <id>`.
  Post progress, blockers, and results there. Never invent an item or agent
  identity. File follow-ups as Work Items, not GitHub issues or pull requests.
- Run `git worktree list`. Reuse your own worktree or create one under
  `.worktrees/` or a harness-managed location. Never use another session's
  checkout or create a sibling clone. Keep unrelated work intact.
- Read the nearest `AGENTS.md`, the code that calls what you are changing,
  and its tests. Current code and contracts take priority over prose; fix
  stale instructions when you find them.
- Before each patch, re-read the exact lines it replaces. Do not copy context
  from memory or an earlier edit: a formatter may have changed it. Keep
  Markdown line breaks as the file has them.

## Explain things plainly

Use familiar words and concrete examples in product text and public guides.
Explain what someone can do, how it works, and what they need to do next.
Use `README.md` as the starting point for Tedix's description and audience:
developers using AI, teams with recurring work, organizations sharing
guidelines, and developers building agents and apps.

Say “platform for agents, apps, and work” when introducing Tedix. Use “agent”
consistently; explain it as an AI assistant that can carry out tasks using
tools when readers need a definition. Describe how people and agents share
project information, tasks, and results under the organization's access rules.
Explain approvals and work history in terms of what people can review and
control. Do not promise that a completed task proves its result is correct.

Avoid labels such as “AI workers”, “long-lived”, and “cognitive system”.
Keep implementation details in developer references. Preserve exact commands
and API names where readers need them.

## Run it locally

Run `bun run-local` from the root. It needs no login and makes no model calls
by default. See `docs/public/getting-started.md` for options.
For screen-only changes, `bun run --cwd apps/os dev` uses sample data.
Local tests do not prove that Tedix Cloud works or that a change is deployed.

## Find the code

| You are changing         | Read first                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Screens and interactions | `apps/os/README.md`, `apps/os/AGENTS.md`, then `apps/os/src/routes/`                      |
| API                      | `apps/api/AGENTS.md`, `packages/api-contract/src/contracts/`, `apps/api/src/rpc/routers/` |
| Stored data              | `packages/db/AGENTS.md`, then the relevant `src/schema/` and `src/queries/` modules       |
| Tedi execution           | `apps/tedi-runtime/AGENTS.md`, `apps/tedi-runtime/src/do.ts`, and nearby modules          |
| MCP tools                | `apps/mcp/AGENTS.md`, `apps/mcp/src/mcp/handler.ts`, `packages/db/src/schema/tools.ts`    |
| Command-line tool        | `packages/cli/README.md` and the command's implementation                                 |
| Factories and schedules  | `docs/public/build-operate-tune-factory.md`, then the relevant API, runtime, or CLI code  |

## Keep these code rules

- Use `db.batch()`, not `db.transaction()`. Cloudflare D1 rejects `BEGIN`
  (error 7500).
- Give every selected column a unique output name. D1 batch results silently
  merge duplicate names before Drizzle maps them. Queries must work safely in
  a batch; the D1 test facade rejects both duplicate names and transactions.
- Keep oRPC contracts in `packages/api-contract/src/contracts/` and schemas in
  `packages/api-contract/src/schemas/`, never inline in routers. Import them
  through direct `@tedix/api-contract/...` paths.
- Use direct imports; do not add barrel files or re-export facades. Database
  access belongs in `@tedix/db/queries/<domain>`, never inline Drizzle queries
  in routers, jobs, services, or workflows. `scripts/lint-db-access.ts` checks this.
- Keep organization-specific tools, widgets, permissions, policies, and
  schedules in D1 rows and versioned assets. TypeScript supplies the shared
  code that runs and checks them; do not hardcode per-tenant behavior.
- Name MCP tools with a verb first in snake_case: `list_skills`, `get_skill`,
  `run_skill_workflow`. A product prefix such as `gmail_send` is allowed to
  distinguish products. Internal oRPC keys keep their `{noun}.{verb}` shape.
- Regenerate `worker-configuration.d.ts` with `bun run types:generate`; never
  edit it by hand. Worker config is `cloudflare.config.ts` or `wrangler.jsonc`,
  never `.toml`.

## Check your change

Run the checks that apply; follow the nearest guide for focused tests.

| Command                                | What it checks                                                   |
| -------------------------------------- | ---------------------------------------------------------------- |
| `bun run --cwd <workspace> type-check` | TypeScript source                                                |
| `bun run --cwd <workspace> test:run`   | That workspace's tests; never use bare `bun test` on Worker apps |
| `bun run types:check`                  | Generated Worker bindings; fix with `bun run types:generate`     |
| `bun run lint:repo`                    | Rules about where code belongs                                   |
| `bun run docs:public:check`            | Public docs and agent-guide references                           |
| `bun run scan:secrets`                 | Secrets in public source                                         |

The pre-push hook selects relevant checks. Do not weaken a failing check.
Report what ran and what remains unverified. Passing tests, completing a
Work Item, pushing a commit, and deploying a change are separate results.

## Commit and finish

Run `bun run format <changed files>` before committing. Maintainers commit
directly to `main` after validation; agents never create GitHub issues or pull
requests. GitHub issues are for outside contributors; see `CONTRIBUTING.md`.
Every commit must end with `Work-Item: <uuid>`.

Push with `bun run push`. It queues behind other sessions on this machine,
rebases onto `origin/main`, runs the pre-push checks, and retries if main moves.

A user-visible CLI change needs a changeset (`bun changeset`) in the same
commit. Do not bump the CLI version, edit its `CHANGELOG.md`, or tag a release.
Releases are batched, at most daily; see `CONTRIBUTING.md`.

After pushing or abandoning a change, remove your worktree and scratch files.
Never remove a worktree used by a live session. Follow
`.agents/skills/worktree-closeout/SKILL.md`. `bun run worktree:gc` lists
worktrees; `--apply` removes only merged, clean, idle ones.

## Use live services only when authorized

A checkout gives no access to a live organization. For authorized live work,
read `docs/public/agent-guide.md`, check `tedix auth status`, and discover the
exact tool and input schema before calling it. Sign-in, consent, MFA, and
required human presence belong to the person. Other approvals go to the
designated approver.

This repository contains product source and example configuration. Tedix
Cloud releases use the private ops repository, which owns live configuration,
credentials, and deployment. Do not deploy Tedix Cloud from this checkout.
A source checkout is not permission to operate it.

Keep live account, database, organization, and resource IDs, secret references,
and private runbooks out of this repository. Use placeholders in checked-in
Worker configs and fictional tenants in tests. Never commit credentials,
customer data, real `.env` files, or `.dev.vars`. `.env.example` lists key
names and placeholders only.

If you change a deployable `wrangler.jsonc` or `cloudflare.config.ts`, first
validate the matching private ops overlay against that exact product config
and land it in ops. Before pushing here, add one trailer per changed config:
`Ops-Overlay: <full ops commit SHA> <config path>`. The pre-push gate checks the
reference offline; Ship checks compatibility.

Deploying to your own Cloudflare account is experimental. Only do it when
deployment is the task, following `docs/public/installation-manifests.md` and
`docs/public/self-hosted-boundary.md`.
