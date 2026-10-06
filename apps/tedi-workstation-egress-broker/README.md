# @tedix/tedi-workstation-egress-broker

SSRF-guarded GitHub App egress broker for tedi workstations.

## Overview

This is a service-binding-only Cloudflare
Worker between the workstation runtime's GitHub App routes and GitHub. The
workstation container cannot access the App private key or installation tokens.
Ordinary allowed outbound traffic uses the workstation runtime's own handler.

`src/index.ts` handles a single `fetch()`:

- `GET /health` — liveness plus the exact deployed Git SHA.
- Every other request must carry an
  `x-tedix-workstation-egress-route-type` header of `proxy`.
  Missing and unsupported route types are rejected before forwarding.
- **GitHub App route** (`handleProxyRoute`):
  - Rejects `CONNECT`/`TRACE` and any `Upgrade` request.
  - Runs the target URL through `@tedix/ssrf-guard`'s `validateUrl()` and
    rejects blocked targets (`403 target_blocked`).
  - Requires an explicit host allow-list on the request
    (`x-tedix-workstation-egress-route-hosts`) and, if present, a port allow-list
    (`x-tedix-workstation-egress-route-ports`) — an unconfigured or
    non-matching host/port is a `403`.
  - Strips every internal `x-tedix-workstation-egress-*` header and standard
    hop-by-hop headers before forwarding, so none of the routing metadata
    leaks to the upstream origin.
  - Rejects any route without correlated GitHub App authority. It validates
    the live lease/Attempt fence and exact
    organization, tedi, workstation, Work Item, installation and repository
    authority through `TEDI_SERVICE` on every request. The API route is only the
    exact `GET /repos/{owner}/{repo}` probe; structured mutations remain MCP-only.
    The token request uses the immutable `repository_ids` value with
    `contents:write`, verifies returned id and name, and rejects TTL over 3,600
    seconds.
    Tokens are memory-only and never returned to the container, logs, audit
    metadata or durable storage. The broker replaces any container-supplied
    authorization only on the final GitHub request.
  - Requires immutable issuance-request and issuance-outcome events plus a
    final upstream outcome through `API_SERVICE`. Correlated denials and
    preflight/mint/upstream failures include the exact authority dimensions and
    reason. The issuance-request event precedes minting; audit failure is an
    authentication failure, not best-effort telemetry.
  - Forwards with `redirect: "manual"` and returns the raw upstream response,
    or `502 proxy_fetch_failed` on a network error.

This is the control-plane egress-attach boundary for workstation leases: the
broker enforces the per-lease host/port allow-list and App credential injection at
request time. The public
[worker model](../../docs/public/workers-and-governance.md) describes why
operating-system access is bounded per job.

## Running it

```sh
bun run dev              # Cloudflare Vite plugin
bun run test:run          # vitest run
```

`workers_dev` is disabled in every environment — this Worker is only reached
via a service binding from `apps/tedi-workstation-runtime`, never a public route.
Managed deployment runs through the guarded workflow in `tedix-hq/tedix-cloud-ops`.

## GitHub App activation and containment

The App must be installed on explicit repositories with repository Contents
read/write permission. Store its App id and an RSA private key converted to
PKCS#8 PEM as `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PKCS8`. GitHub's
downloaded PKCS#1 key can be converted offline with:

```sh
openssl pkcs8 -topk8 -nocrypt -in github-app-private-key.pem -out github-app-private-key.pkcs8.pem
```

Do not write either key into the repository or a workstation. Provision the
secrets through the installation's private secret provider; `.env.example`
lists the required keys, not credentials. `GITHUB_APP_ENABLED` defaults to `false` and
must remain false until installation, secrets and immutable audit writes are
verified. There is no PAT rollback.

On an incident, disable the switch first. The broker then rejects new issuance
and injection and attempts to revoke any tokens still cached in the reached
isolate. That does not invalidate an exfiltrated token or tokens held by other
isolates. Use App-JWT authority to suspend the installation (or uninstall it),
then rotate the private key and audit both systems. Private-key rotation alone
does not revoke installation tokens already issued; those otherwise retain
their GitHub-enforced lifetime of at most one hour.

Organization/install/repository kills are durable organization metadata, and
repo enablement is explicit tedi repo configuration. Operators mutate and read
them back through the existing privileged `organizations.update` and
`tedis.update` RPCs via `tedix code`. The incident script exposes only
App-JWT-authenticated `suspend` and `uninstall`; it reads credentials from the
environment and never accepts or prints installation tokens.
