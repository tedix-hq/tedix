---
sidebar:
  order: 15
title: "Troubleshoot Tedix connections and worker runs"
topic: "Troubleshooting"
resource_type: troubleshooting
description: "Match a visible CLI, connection, or worker-run symptom to its cause, supported fix, verification step, and safe escalation path."
summary: "Symptom-led recovery for the Tedix CLI, first Cloud connection, worker results, approvals, and failed runs"
read_when:
  - A Tedix CLI command, Cloud connection, or worker run does not finish as expected
  - Finding a worker result or deciding whether a failed run can be retried
  - Collecting safe evidence for managed support or a public issue
visibility: public
---

# Troubleshoot Tedix connections and worker runs

Start with the exact symptom you can see. Each entry gives the likely cause,
the supported next step, and the result that verifies recovery. Do not submit a
duplicate worker task while its original Home run may still be active.

For the complete setup and task context, use [First connection to Tedix
Cloud](./learning-paths/first-connection.md) and [Run a digital worker and find
its result](./learning-paths/first-worker.md).

## Install and start the CLI

### `tedix: command not found`

**Cause:** The current shell has not loaded the installer's `PATH` change, or
the install directory is absent from `PATH`.

**Fix:** Open a new terminal. If the command is still missing, follow the
[CLI PATH recovery](./cli.md#troubleshooting).

**Verify:** Both commands print an installed path and version:

```bash
command -v tedix
tedix --version
```

### `install directory is not writable`

**Cause:** The selected install directory cannot be written by the current
user.

**Fix:** If the default directory was previously created with `sudo`, run the
ownership command printed by the installer. Otherwise, choose a writable
directory with `TEDIX_INSTALL_DIR`. The [CLI troubleshooting
section](./cli.md#troubleshooting) owns the full installer guidance.

**Verify:** Run `command -v tedix` and `tedix --version` after installation.

## Make the first Cloud connection

### The organization is missing in the browser

**Cause:** Cloud beta admission and organization membership are separate. The
signed-in person may not yet be a member of the intended organization.

**Fix:** Ask the inviter to confirm membership, or wait for beta admission,
then run `tedix login` again. Do not use a credential from another person.

**Verify:** The browser flow lists the intended organization and the terminal
reports a saved CLI profile after consent.

### `auth status` names the wrong profile or gateway

**Cause:** The CLI selected a different saved profile.

**Fix:** List the saved profiles and inspect the intended one:

```bash
tedix workspaces
tedix -w CLI_PROFILE auth status
```

If that profile has no correct stored login, run `tedix login ORG_SLUG` and
complete the browser flow yourself.

**Verify:** `auth status` names the intended CLI profile, organization, and MCP
gateway.

### `selected source` is `none`

**Cause:** The selected CLI profile has no usable stored login.

**Fix:** Run `tedix login ORG_SLUG`, complete browser sign-in and consent, then
check the profile again.

**Verify:** `tedix -w CLI_PROFILE auth status` reports `selected source:
stored-login` and does not print the credential.

### The live call returns an authorization or connection error

**Cause:** The selected profile, stored login, granted scopes, or gateway may
not match the intended organization.

**Fix:** Run `tedix -w CLI_PROFILE auth status`. If the login or scopes are
wrong, run `tedix login ORG_SLUG` and complete consent again.

**Verify:** Repeat the bounded, read-only namespace check in [First connection
to Tedix Cloud](./learning-paths/first-connection.md#4-make-one-read-only-live-call).
It should return a positive `count` and a short `sample`.

## Run a digital worker and find its result

### `Tedi not found`

**Cause:** The worker slug is wrong or belongs to another organization.

**Fix:** Check `tedix -w CLI_PROFILE auth status`, then copy the active tedi's
slug from Tedix OS. Do not substitute its display name.

**Verify:** Run the bounded task from [Run a digital worker and find its
result](./learning-paths/first-worker.md#give-the-worker-one-task). The CLI
should print a Home run ID.

### The CLI exits with code 3 or loses its connection

**Cause:** Exit code 3 means the server run remained active after the CLI
stopped waiting. A lost connection can also leave the run active.

**Fix:** Do not submit the task again. Read the existing run:

```bash
tedix -w CLI_PROFILE run HOME_RUN_ID
tedix -w CLI_PROFILE inspect HOME_RUN_ID --events --artifacts
tedix -w CLI_PROFILE tail HOME_RUN_ID --no-follow
```

**Verify:** Use the status printed by `run` or `inspect`. Keep the same Home run
ID until it reports completed, failed, or canceled. A successful `run` read
itself exits with code 0 even when the recorded run failed.

### The inspection does not name a tedi

**Cause:** A plain Home request may have been used instead of a direct worker
request, or a different Home run ID was inspected.

**Fix:** Confirm that the task used `tedix tedi WORKER_SLUG ask`, then inspect
the Home run ID printed by that command.

**Verify:** The inspection names the selected tedi and includes its child run.
A Home-only answer or run ID is not a worker result.

## Resolve approvals and failed runs

### The run is waiting for approval

**Cause:** The run proposed a delegation or action that requires an operator
decision.

**Fix:** Inspect before deciding:

```bash
tedix -w CLI_PROFILE status
tedix -w CLI_PROFILE inspect HOME_RUN_ID
```

Approve only when the target, task, and permitted actions exactly match what
you intend. Reject a broader or mismatched proposal. The first-worker tutorial
provides [scope-specific approval and rejection
examples](./learning-paths/first-worker.md#the-run-is-waiting-for-approval).

**Verify:** Inspect the same Home run again and confirm its status and recorded
decision.

### The failed-run output says `Recovery available`

**Cause:** The failed delegation has a blocked Work Item that the server offers
for bounded retry.

**Fix:** Inspect the evidence first. Use only the Work Item ID printed with the
recovery offer:

```bash
tedix -w CLI_PROFILE inspect HOME_RUN_ID --events --artifacts
tedix -w CLI_PROFILE retry WORK_ITEM_ID
```

The retry server response is authoritative. If it refuses the request, stop;
do not create a replacement task automatically.

**Verify:** After an accepted retry, inspect the same Home run ID. It should
show the new child run and its current status. Repeat the inspection until the
child is terminal.

### The run failed without offering `Recovery available`

**Cause:** No retryable Work Item ID is available from that run.

**Fix:** Do not use `retry` and do not automatically submit a replacement task.
Preserve the Home run inspection and event snapshot.

**Verify:** The evidence identifies the final status and visible error. Use the
safe escalation path below when the documented connection or worker checks do
not resolve it.

## Check worker permissions

Worker identity, tool grants, policies, budgets, and approvals are explained in
[Worker permissions, approvals, and governance](./workers-and-governance.md#permissions).
An approval records permission for the inspected scope; it does not prove that
the eventual answer or outside action is correct.

## Decide about self-hosting

Self-hosting is experimental and unsupported. Before treating a deployment
problem as a product incident, read [Self-hosting Tedix and the managed service
boundary](./self-hosted-boundary.md). It states the supported Cloud, public
source, local, and self-hosted boundaries and links the installation contracts.

## Escalate without exposing tenant data

Follow the [support terms for your Tedix surface](./self-hosted-boundary.md#support).

For managed Tedix Cloud beta, use the authorized private route in the
customer's agreement. Provide the CLI version, selected organization and
gateway, exact command, internal run and Work Item IDs when shown, final
status, event timestamp, and visible error. Redact credentials and unrelated
private organization content.

For a public `main` or local-mode issue, include the CLI version, command shape
with placeholders, final status, and sanitized error. Do not publish the CLI
profile, organization or tenant gateway, tedi identity, Home or child run IDs,
Work Item ID, event payloads, credentials, or private organization content.
