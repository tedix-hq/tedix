# Contributing to Tedix

Issues, bug reports, and ideas are welcome; questions and open-ended ideas can
also go to [GitHub Discussions](https://github.com/tedix-hq/tedix/discussions).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

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
   Cloud or a local checkout, name the build or source revision, and include
   the smallest reproduction you can. A patch sketch or diff in the issue text
   is welcome as a description of the fix.
3. Never include secrets, tokens, tenant data or production dumps.

Security problems never go in public issues; see [SECURITY.md](SECURITY.md).

## What happens next

A maintainer listed in [.github/CODEOWNERS](.github/CODEOWNERS) triages the
issue. Accepted ideas are re-authored by a maintainer, who credits you on the
issue, links the landed commit there, and names you in a `Reported-by:` commit
trailer.

Maintainer commits also carry `Work-Item:` and `Agent-Session:` trailers that
identify the task and the agent session behind the change. The ids do not
resolve publicly, and you never need them.

[RELEASING.md](RELEASING.md) explains when a landed change reaches a CLI or
plugin release.

## Working in your own fork

Read [AGENTS.md](AGENTS.md) and the nearest scoped `AGENTS.md`, then run
`bun run verify` for the same checks as the pre-push hook.

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
Apache-2.0 or MIT per package. The [README](README.md#licensing) lists which is
which.
