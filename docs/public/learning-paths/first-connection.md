---
sidebar:
  order: 5
title: "First connection to Tedix Cloud"
topic: "Learning paths"
resource_type: tutorial
description: "Make a first Tedix Cloud connection: install the CLI, connect an invited organization, and verify a read-only live gateway call."
summary: "A first Cloud connection with expected output and symptom-led recovery"
read_when:
  - Connecting this computer to Tedix Cloud for the first time
  - Checking that the CLI targets the intended organization
  - Recovering a first login or gateway connection
visibility: public
---

# First connection to Tedix Cloud

This tutorial connects the Tedix CLI on one computer to an invited Tedix Cloud
organization. You finish with a saved CLI profile and a successful read-only
call to that organization's live MCP gateway. It does not run a worker, call a
model, or change organization data.

[Release status](../release-status.md) says who can use Tedix Cloud today. To
evaluate the local product without a Cloud account, follow [Getting started
locally](../getting-started.md).

## Before you start

You need:

- Tedix Cloud beta access: membership in an organization, or approval to
  create your own. Tedix Cloud is an invited beta; to request access, use the
  [contact page](https://tedix.dev/contact/);
- a browser in which you can sign in and approve the requested access; and
- a computer supported by the [Tedix CLI](../cli.md#supported-platforms).

Ask an organization administrator for its slug if you want to target it
directly. Never ask another person to send you a password, browser cookie, OAuth
grant, or API key.

## 1. Install the CLI

On macOS or Linux, run:

```bash
curl -fsSL https://downloads.tedix.dev/install.sh | sh
```

Open a new terminal after the installer updates your shell profile, then check
the command and version:

```bash
command -v tedix
tedix --version
```

**Expected result:** the first command prints the installed `tedix` path and the
second prints its version. Windows installation is currently experimental; use
the instructions and limits in the [CLI reference](../cli.md#supported-platforms).

## 2. Sign in and choose the organization

Run:

```bash
tedix login
```

The CLI opens Tedix Connect in your browser so you can choose permissions and
one or more organizations. Complete the browser sign-in and consent yourself.
If you already know the intended organization slug, target it directly:

```bash
tedix login ORG_SLUG
```

Replace `ORG_SLUG` with the real slug. The targeted command opens Tedix OS to
authorize that organization. After authorization, the terminal prints the
granted scopes and the saved CLI workspace name and gateway URL. The CLI stores
the OAuth grant under `~/.tedix`; it does not print the token.

## 3. Verify the saved CLI profile

Check the profile before sending any work:

```bash
tedix auth status
```

**Expected result:** the output shows the intended CLI `workspace`, `MCP URL`,
and `selected source: stored-login`. It also reports the granted scopes without
printing the credential. Here, **CLI workspace** means the saved connection
profile on this computer; it is separate from a Workspace inside Tedix OS.

If you authorized more than one organization, list the saved profiles and
inspect the one you intend to use:

```bash
tedix workspaces
tedix -w CLI_PROFILE auth status
```

Replace `CLI_PROFILE` with the saved name printed by login or `tedix workspaces`.

## 4. Make one read-only live call

List the capability namespaces exposed by the selected organization's gateway:

```bash
tedix -w CLI_PROFILE code \
  'async () => { const namespaces = await discover.list_namespaces(); const names = Object.keys(namespaces); return { count: names.length, sample: names.slice(0, 5) }; }'
```

**Expected result:** the command returns a positive `count` and a `sample` of up
to five namespace names. The bounded projection proves that the saved grant can
reach the live gateway without returning the complete capability inventory. It
creates no Home run and does not call an application tool.

You are connected when all three conditions hold:

1. `tedix --version` succeeds;
2. `tedix -w CLI_PROFILE auth status` names the intended profile and gateway and
   reports `selected source: stored-login`; and
3. the live namespace check returns a positive `count` and a short `sample`.

## If it does not work

Start with the symptom you see.

### `tedix: command not found`

Open a new terminal so the installer's shell-profile change takes effect. If it
still fails, follow the [CLI PATH recovery](../cli.md#troubleshooting).

### The organization is missing in the browser

Cloud admission and membership are separate. Ask the inviter to confirm your
membership. If you have no Cloud access yet, request it through the [contact
page](https://tedix.dev/contact/) and wait for beta admission, then run
`tedix login` again. You cannot
repair missing organization access with a token from another person.

### `auth status` names the wrong profile or gateway

Stop before sending work. Run `tedix workspaces`, then inspect the intended
profile with `tedix -w CLI_PROFILE auth status`. If it has no correct stored
login, run `tedix login ORG_SLUG` and check again.

### `selected source` is `none`

The selected profile has no usable saved login. Run `tedix login ORG_SLUG`,
complete the browser flow, and repeat the status check.

### The live call returns an authorization or connection error

Confirm the profile with `tedix -w CLI_PROFILE auth status`, then sign in to the
intended organization again if the login or granted scopes are wrong. In a
managed Cloud beta support channel, keep the CLI version, CLI profile name,
gateway host, and visible error. Do not include OAuth grants, browser cookies,
API keys, or private organization content.

For a public GitHub issue, include only the CLI version and a sanitized error.
Redact CLI profile, organization, and tenant names, the gateway host, credentials,
and private organization content.

## Next

- Get a useful result from [your first digital worker](./first-worker.md).
- Read the [CLI reference](../cli.md) for update, rollback, and command help.
- Before a coding or research agent operates the organization, follow the
  [agent guide](../agent-guide.md).
