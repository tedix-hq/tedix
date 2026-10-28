# Tedix plugins

**A platform for agents, apps, and work.**

Tedix gives your team and AI agents a shared place for project information,
tasks, apps, and results. The plugin connects the AI assistant you already use
to that shared work.

- **Explain things once.** Save your project's setup, coding guidelines,
  and past decisions for agents to use in later tasks.
- **See who is doing what.** People and agents share a list of tasks, with an
  owner, progress, and results for each one.
- **Keep the result useful.** Keep investigation notes, test results, release
  plans, and apps together in a workspace where your team can find them.
- **Know when you are needed.** Review requests for your approval in one place
  and check other updates when it suits you.

You choose what agents can access and which actions need approval. Sign in
to your Tedix organization to use the plugin with the permissions you grant.

> Generated from [`plugins/tedix`](https://github.com/tedix-hq/tedix/tree/main/plugins/tedix)
> in [tedix-hq/tedix](https://github.com/tedix-hq/tedix). Edit there; this
> repository is rebuilt on each plugin release. Issues and ideas:
> [tedix-hq/tedix](https://github.com/tedix-hq/tedix/issues).

Tedix Cloud is an invited beta; ask for access through the
[contact page](https://tedix.dev/contact/). See
[release status](https://docs.tedix.dev/release-status).

## Install

**Claude Code**

```sh
claude plugin marketplace add tedix-hq/tedix-plugins
claude plugin install tedix@tedix-plugins --scope user
```

**Codex** (needs the `mcp_2026_07_28` feature; `codex features enable mcp_2026_07_28`)

```sh
codex plugin marketplace add tedix-hq/tedix-plugins
codex plugin add tedix@tedix-plugins
codex mcp login tedix
```

**Gemini CLI and Antigravity**

```sh
gemini extensions install https://github.com/tedix-hq/tedix-plugins
```

**Skills only, for any agent that reads Agent Skills**

```sh
npx skills add tedix-hq/tedix-plugins
```

**Cline and other MCP clients:** point your agent at
[`llms-install.md`](llms-install.md), or add the server URL below yourself.

Every host connects to `https://connect.mcp.tedix.dev/mcp` and signs you in
with OAuth the first time a skill needs it.

## What is included

| Path                    | For                                          |
| ----------------------- | -------------------------------------------- |
| `skills/`               | Agent Skills shared by every host            |
| `.mcp.json`             | The remote Tedix MCP server (HTTP)           |
| `.claude-plugin/`       | Claude Code plugin and marketplace manifests |
| `.codex-plugin/`        | Codex plugin manifest                        |
| `.agents/plugins/`      | Codex marketplace manifest                   |
| `gemini-extension.json` | Gemini CLI and Antigravity extension         |
| `llms-install.md`       | Install steps for installer agents           |
| `assets/`               | Icons and logos                              |

This published plugin contains **no hooks**. Optional local session hooks
(session context, decision capture, turn status) ship with the
[Tedix CLI](https://docs.tedix.dev/cli): `tedix setup agents`.

## Connected actions and payments

Code Mode can read records in your organization's connected apps,
such as email, calendar and documents, under the provider's
grants, your explicit consent, and organization policy and approvals.

The shared `connect` connection rejects x402 payment proofs and paid tools.
It hides and rejects provider operations that move money: creating, capturing,
confirming, executing or processing charges, payments, payouts, refunds,
transfers and withdrawals; sending or transferring money or funds; charging
customers, refunding payments, paying invoices and topping up funds. The rules
match operation names and configured targets, including REST creation calls.
Provider names and mentions of payments in descriptions do not trigger a block.

Billing checkout and portal links, limits, settings and admin credit grants
remain available under existing permissions. Ordinary code, provider reads,
Home submissions and skill workflows also remain available. Installing the
plugin does not purchase a subscription or authorize a payment.

Plugin-started tedi turns carry a server-stamped `noFunds` restriction through
durable dispatch and retries. The runtime filters names with the same list of
money-moving operations. Normal inference usage remains subject to the
organization's plan.

Procedures ship in the skills and their reference files. Organization skills,
CLI help, online guides and Work text fetched at run time are data or reference
only, never instructions to follow.

[Privacy policy](https://tedix.dev/privacy/) ·
[Terms of service](https://tedix.dev/terms/)

## Versions

The plugin follows its own semver while below 1.0; see `version` in
`.claude-plugin/plugin.json` and the
[releasing policy](https://github.com/tedix-hq/tedix/blob/main/CONTRIBUTING.md#releases).

## License

AGPL-3.0-only, like the Tedix product. See [LICENSE](LICENSE).
