# Releasing Tedix

This page says what gets a version number, how the number is chosen, and how
a release is announced. [Release status](docs/public/release-status.md) says
what is available today.

## What is versioned

Only artifacts you install carry a version:

| Artifact           | Tag             | Version source                      |
| ------------------ | --------------- | ----------------------------------- |
| Tedix CLI          | `cli-vX.Y.Z`    | `packages/cli/package.json`         |
| Tedix plugin       | `plugin-vX.Y.Z` | `plugins/tedix/plugin.json`         |
| Source prereleases | `vX.Y.Z-beta.N` | A snapshot of `main` for evaluation |

The CLI and the plugin are versioned independently.

## What is not versioned

Tedix Cloud services deploy continuously from `main`. A deployment is
identified by its commit SHA, which the API reports on `/health`.

## Version numbers

While a version starts with `0.`:

- a **minor** release (`0.3.0`) adds a feature or makes a breaking change;
- a **patch** release (`0.2.1`) only fixes bugs.

## Cadence

Release the CLI at most once a day. Fixes and features wait in `.changeset/`
and ship together. Release sooner only for a broken install or update, a
security fix, or data loss.

A commit that changes the CLI never edits its version, its `CHANGELOG.md`, or
tags a release. It records the change instead:

```sh
bun changeset   # pick @tedix/cli, patch or minor, one plain-language line
```

Commit the generated `.changeset/*.md` file with the change. Internal changes
(tests, refactors) need none.

## Cutting a CLI release

A maintainer, deliberately, not as part of a fix:

1. `bun changeset status` lists what is pending.
2. `bun changeset version` bumps `packages/cli/package.json` and moves every
   pending note into `packages/cli/CHANGELOG.md`. Edit the new entry into
   plain user language and add the date to its heading.
3. Commit as `chore(cli): release X.Y.Z`, push, tag `cli-vX.Y.Z` on that
   commit, and push the tag.

## Channels

The CLI publishes to `downloads.tedix.dev`. `latest.json` is the stable
channel and `beta.json` the beta channel. Prereleases go to the beta channel
only.

## Release notes

Each CLI release gets notes in
[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md), in plain user
language, collected from its changesets. A GitHub Release is created only for a real release, with the same
notes, never for an intermediate build.

## Publishing the plugin

[tedix-hq/tedix-plugins](https://github.com/tedix-hq/tedix-plugins) is the
public plugin repository for every host (Claude Code, Codex, and later ones):
one plugin at the root, one manifest per host, shared skills and MCP
connection, no hooks. It is generated, never edited by hand. After tagging
`plugin-vX.Y.Z` here, rebuild it into a clone of that repository with
`bun run --cwd packages/cli plugin:repo <clone>`, commit, tag `vX.Y.Z` there,
and push.

## Plugin compatibility

The plugin's local hooks run in the installed Tedix CLI.
[plugins/tedix/README.md](plugins/tedix/README.md) states the minimum CLI
version they need; raise it when a hook depends on a newer CLI.
