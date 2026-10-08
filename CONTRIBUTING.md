# Contributing to Tedix

Issues, bug reports, and ideas are welcome; questions and open-ended ideas can
also go to [GitHub Discussions](https://github.com/tedix-hq/tedix/discussions).

## Code of conduct

Tedix adopts the
[Contributor Covenant, version 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
for issues, discussions and every other project space. Be respectful and
constructive, welcome people of every background, and do not harass, insult or
publish anyone's private information.

Report concerns privately by email to **security@tedix.dev** with a subject
starting `Conduct:`. The maintainers review every report, keep the reporter's
identity confidential, and apply the Covenant's enforcement guidelines.

## Getting help

- **Bugs and regressions:** GitHub issues, using the bug template.
- **Questions and ideas:** [GitHub Discussions](https://github.com/tedix-hq/tedix/discussions).
- **Security reports:** never in public issues; see [SECURITY.md](SECURITY.md).
- **Tedix Cloud customers:** your contracted support channel.

What each surface gets (Cloud, `main`, local mode, self-hosting) is in the
[support table](docs/public/self-hosted-boundary.md#support). Community support
has no response-time guarantee.

## Who contributes code

Maintainers write all merged code, which keeps licensing simple without a
contributor agreement. Code from outside the maintainer team is not merged,
and pull requests are disabled. You are free to fork and modify Tedix under
its licenses.

The most useful contribution is a precise issue or Discussion: what you did,
what you expected, what happened, and the smallest reproduction. When an idea
is accepted, a maintainer re-authors it and credits you as described in
[What happens next](#what-happens-next).

## Report a bug or propose an idea

1. Search existing issues first.
2. Open an issue with the bug or feature template. Say whether you used Tedix
   Cloud or a local checkout, name the build or source revision, and retry on
   current `main` when you can. Include the smallest reproduction you can. A
   patch sketch or diff in the issue text is welcome as a description of the
   fix.
3. Never include secrets, tokens, tenant data or production dumps.

## What happens next

A maintainer labels the issue, deduplicates it, and asks for a reproduction,
then accepts it or closes it with a reason. Stale issues missing information
may be closed after a warning. Accepted ideas are re-authored by a maintainer,
who credits you on the issue, links the landed commit there, and names you in
a `Reported-by:` commit trailer.

Maintainer commits also carry `Work-Item:` and `Agent-Session:` trailers that
identify the task and the agent session behind the change. The ids do not
resolve publicly, and you never need them.

## Governance

- **Owner:** Tedix GbR decides product direction, licensing, releases,
  trademarks, and this document.
- **Maintainers** triage issues, write every merged change, and own release
  quality. They commit directly to `main` after the pre-push checks pass.

Changes touching authentication, tenant isolation, secrets, database
migrations, billing, or deployment get extra review before they land. Fixing
forward is not a substitute for preventing data disclosure or data loss.

Public `main` is the product source. Tedix Cloud is built from a public commit
plus private operational configuration; product code is never kept private.
`main` moves fast and is not a stable installation target; see
[Release status](docs/public/release-status.md).

## Releases

Only artifacts you install carry a version:

| Artifact           | Tag             | Version source                      |
| ------------------ | --------------- | ----------------------------------- |
| Tedix CLI          | `cli-vX.Y.Z`    | `packages/cli/package.json`         |
| Tedix plugin       | `plugin-vX.Y.Z` | `plugins/tedix/plugin.json`         |
| Source prereleases | `vX.Y.Z-beta.N` | A snapshot of `main` for evaluation |

The CLI and the plugin are versioned independently. Tedix Cloud services deploy
continuously from `main`; a deployment is identified by its commit SHA, which
the API reports on `/health`.

While a version starts with `0.`, a minor release (`0.3.0`) adds a feature or
makes a breaking change and a patch release (`0.2.1`) only fixes bugs.

Release the CLI at most once a day. Fixes and features wait in `.changeset/`
and ship together; release sooner only for a broken install or update, a
security fix, or data loss. A commit that changes the CLI never edits its
version or `CHANGELOG.md` and never tags a release. A user-visible change
records a note instead, committed with the change (internal changes such as
tests and refactors need none):

```sh
bun changeset   # pick @tedix/cli, patch or minor, one plain-language line
```

To cut a CLI release, a maintainer, deliberately and not as part of a fix:

1. `bun changeset status` lists what is pending.
2. `bun changeset version` bumps `packages/cli/package.json` and moves every
   pending note into `packages/cli/CHANGELOG.md`. Edit the new entry into
   plain user language and add the date to its heading.
3. Commit as `chore(cli): release X.Y.Z`, push, tag `cli-vX.Y.Z` on that
   commit, and push the tag.

The CLI publishes to `downloads.tedix.dev`: `latest.json` is the stable channel
and `beta.json` the beta channel, which alone receives prereleases. Each tagged
CLI build publishes a `SHA256SUMS` file and a GitHub build-provenance
attestation for every binary. A GitHub Release, with the
[changelog](packages/cli/CHANGELOG.md) notes, is created only for a real
release, never for an intermediate build.

[tedix-hq/tedix-plugins](https://github.com/tedix-hq/tedix-plugins) is the
generated public plugin repository for every host. After tagging
`plugin-vX.Y.Z` here, rebuild it into a clone of that repository with
`bun run --cwd packages/cli plugin:repo <clone>`, commit, tag `vX.Y.Z` there,
and push. The plugin's hooks run in the installed CLI;
[plugins/tedix/README.md](plugins/tedix/README.md) states the minimum CLI
version they need.

## Find your way around the code

| Work on                 | Start here                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| A screen                | [apps/os](apps/os)                                                                                 |
| An API or stored record | [packages/api-contract](packages/api-contract) → [apps/api](apps/api) → [packages/db](packages/db) |
| Worker execution        | [apps/tedi-runtime](apps/tedi-runtime)                                                             |
| A tool or integration   | [apps/mcp](apps/mcp) and the [MCP app platform](docs/public/mcp-app-platform.md)                   |
| The CLI                 | [packages/cli](packages/cli)                                                                       |
| Websites                | [apps/cms](apps/cms) and the [CMS guide](docs/public/cms.md)                                       |

[One request through Tedix](docs/public/cloudflare-architecture.md#one-request-through-tedix)
traces a request from the CLI through routing to the next turn. The
[engineering docs](docs/engineering/README.md) cover architecture, data, MCP, and the
worker runtime; [decision records](decisions/README.md) explain why.

## Working in your own fork

Read [AGENTS.md](AGENTS.md) and the nearest scoped `AGENTS.md` before editing,
then run `bun run verify` for the same checks as the pre-push hook.

`bun run test:ci` runs the full suite, including a Chromium browser test in
`apps/os` and code-search tests that run [ripgrep](https://github.com/BurntSushi/ripgrep)
(`rg` on your `PATH`). Install the browser once:

```sh
cd apps/os && bunx playwright install --with-deps chromium
```

`--with-deps` installs Linux system libraries through `sudo`. Without `sudo`,
run `bunx playwright install-deps chromium` from `apps/os` as root, then
`bunx playwright install chromium` as yourself.

## Licensing

Product code is AGPL-3.0-only; contracts, SDKs, clients and templates are
Apache-2.0 or MIT per package. [Licensing](docs/public/licensing.md#which-packages-are-permissive)
lists which is which.
