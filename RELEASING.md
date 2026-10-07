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

Release when a user-visible change is ready, not on every commit. Batch small
fixes into one patch release.

## Channels

The CLI publishes to `downloads.tedix.dev`. `latest.json` is the stable
channel and `beta.json` the beta channel. Prereleases go to the beta channel
only.

## Release notes

Each CLI release gets hand-written notes in
[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md), in plain user
language. A GitHub Release is created only for a real release, with the same
notes, never for an intermediate build.

## Plugin compatibility

The plugin's local hooks run in the installed Tedix CLI.
[plugins/tedix/README.md](plugins/tedix/README.md) states the minimum CLI
version they need; raise it when a hook depends on a newer CLI.
