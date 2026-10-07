# Security Policy

## Reporting a Vulnerability

Please do **not** report security vulnerabilities in public GitHub issues.

Report vulnerabilities privately through **GitHub private vulnerability
reporting** (the repository's Security tab → "Report a vulnerability") or by
email to [security@tedix.dev](mailto:security@tedix.dev).

For ordinary bugs and suggestions, use GitHub Issues. The Tedix maintainer
handles both feedback and private security reports.

When reporting a vulnerability, include:

- affected component or path
- impact and attack scenario
- reproduction steps
- proof-of-concept if safe to share
- any suggested mitigation

We aim to acknowledge private reports within three business days.

## Trust Model

Treat a way past any of these as a vulnerability:

- **Organization isolation**: one organization reading or changing another's
  data, runs, or Workspaces.
- **A tedi's grants**: a worker acting beyond its tool scopes, budget, or
  policy, or a protected action running without its approval, or approved by
  its own requester.
- **Credentials**: leaking OAuth tokens, CLI sign-ins, or stored provider
  secrets.
- **The MCP gateway**: calling a tool or connection without the scope it
  requires.
- **Worker-to-Worker trust**: reaching a Service Binding entrypoint from
  outside, or forging the session or organization it trusts.

These are not security boundaries:

- what a model does within the scopes and approvals someone granted;
- content a user deliberately shares with a worker or another person;
- the security of the Cloudflare account behind a self-hosted installation;
- local mode (`bun run-local`) on your own machine.

[Worker permissions](docs/public/workers-and-governance.md) describes the
grant and approval model.

## Embargo And Disclosure

Security fixes may be developed under a temporary embargo before public
disclosure:

- an embargo lasts at most **30 days**
- every embargo has a tracking issue, a named owner, and an explicit expiry
- every embargoed fix ends in a public backport or a public disclosure — a
  fix may not remain private past its expiry

Narrow abuse-detection or incident-response intelligence whose disclosure
would create an immediate verified bypass may remain private; the fix itself
does not.

## Supported Versions

- **Tedix Cloud** is patched by the operator.
- **`main`** receives fixes as ordinary commits. Source prereleases such as
  `v0.1.0-beta.1` are not patched; the CLI's versioned releases get fixes in a
  new CLI release.
- **Self-hosted installations** are experimental and unsupported; apply fixes
  by updating to current `main`.

## Sensitive Data Policy

Tedix must never publish:

- secrets or credentials
- database dumps from any real environment
- encrypted secret payloads from real environments
- tenant-specific personal data
- private internal runbooks that expose operational security details

If you discover any of the above in the repository history or working tree, treat it as a security issue and report it privately.
