# Changelog

Release notes for the Tedix source repository. Each tagged release also
carries notes generated from its commits. The standalone CLI has its own
`cli-v*` releases.

## v0.1.0-beta.1 (6 October 2026)

The first public source release of Tedix, a system for running AI workers you
can hold accountable. A **tedi** is a durable worker. It has its own identity
in your organization, scoped tools, budgets, policies and memory, and it keeps
a record of what it did and why. Tedix runs on Cloudflare Workers, Durable
Objects, Workflows, D1 and R2.

This is a beta, not a stable release; see
[Release status](docs/public/release-status.md).

### Try it

- `bun run-local` runs the product on your machine with local workerd and D1
  and prints `Tedix OS: http://localhost:3030`. It needs no account or cloud
  credentials.
- `bun run-local --smoke` goes through onboarding and checks that the result
  persists.
- `--demo` loads sample state. `--inference --workers-ai-account=<id>` turns
  on model calls through Workers AI on your own paid Cloudflare account.

### Workers and conversations

- tedis keep their identity, role, memory, skills and policies from one run to
  the next and across runtime swaps. They all run on one Cloudflare Agents
  runtime. A tedi can also lease an optional Sandbox workstation when a job
  needs files, processes or a repository.
- **Home** is the conversation where you ask for work. Tedix either answers
  there or hands the request to a tedi. Every turn is saved as a run you can
  inspect, with its status, events, rationale and artifacts.
- Skills, automations and flows are reusable procedures. Tedix stores them and
  can run them as durable workflows.

### Governance

- **Work Items** are bounded outcomes. Each one has an owner, a risk level, a
  lease and a recorded result. Before work starts, admission checks the
  specification and reserves capacity and budget.
- Protected actions need approval from a designated approver, which can be
  another tedi. Nobody can approve their own request.
- A settled result is what the worker reported, not a check. Others can
  confirm or contradict it later. An outside action counts as done only when
  the provider returns its own reference for it.

### Tools and apps

- The MCP app platform serves tools, widgets and scopes from configuration
  stored as D1 rows. It doesn't need a handler file for each tool.
- In Code Mode, an agent finds namespaced tools and composes calls to them
  directly.
- The source also includes Tedix OS (the web UI), a CMS and docs sites, and an
  embeddable widget.

### CLI

- The `tedix` CLI is in public beta at `downloads.tedix.dev`. It covers Home,
  Code Mode, Work Items, skills, flows and tedi operations, and it can start
  the local product with `tedix setup` and `tedix dev`.

### Source and licensing

- The public repository starts from a fresh history; files were chosen by an
  allow-list.
- Product code is AGPL-3.0-only. The SDK, contract and extension packages are
  Apache-2.0 or MIT. There is no reduced community edition. See the Licensing
  section of `README.md`.

### Known limits

- Local mode without `--inference` makes no model calls. It also doesn't set
  up external connectors or a deployment.
- The own-account Cloudflare deployment path hasn't been re-validated for
  this release. No self-hosted support, upgrade or backup path is offered.
- Conversation continuity doesn't mean the worker learns permanently, and a
  completed run doesn't mean its reply is correct.
- Tedix welcomes issues and ideas but doesn't merge outside pull requests.
  Maintainers rewrite accepted ideas themselves and credit whoever reported
  them. See `CONTRIBUTING.md`.
