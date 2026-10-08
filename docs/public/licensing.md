---
sidebar:
  order: 170
title: "Licensing and operator FAQ"
topic: "Reference"
resource_type: reference
description: "Tedix AGPL product boundary, permissive ecosystem packages, and practical operator questions."
summary: "Operator-facing explanation of the Tedix open-source license boundary"
read_when:
  - Evaluating whether to self-host or modify Tedix
  - Building on a Tedix SDK, contract, template, or extension package
  - Comparing Tedix open source with Tedix Cloud
visibility: public
---

# Licensing and operator FAQ

Tedix uses a mixed open-source license boundary: deployable product and server
code under **AGPL-3.0-only**, with intentionally embeddable ecosystem packages
under **Apache-2.0** or **MIT**. Each workspace declares its license in the
`license` field of its `package.json`; the license texts live in the root
`LICENSE` and `LICENSES/`.

> This page explains the current repository model; it is not legal advice. The
> license text and package metadata for the version you use control.

## Practical answers

### Can I self-host Tedix?

Yes, under the AGPL. Self-hosting is experimental and unsupported (see
[Release status](./release-status.md)), and it does not include a Tedix Cloud support commitment, provider
credentials, production data, or the right to present a modified installation
as an official or certified Tedix service.

### Do I have to publish my data, prompts, credentials, or configuration?

The license applies to covered software, not to your private data just
because the software processes it. It does not turn customer records,
credentials, prompts, operational logs, or ordinary configuration into source
code. Ask counsel about any material that mixes code and private configuration.

### What if I modify the server and users interact with it over a network?

AGPL section 13 adds a network-source obligation for a modified covered
program: users interacting with it remotely must be offered the corresponding
source of that modified version. The complete license text in
`LICENSE` controls the scope and method.

### Can I offer an unmodified Tedix release as a service?

AGPL is not a non-compete license. The license does not prohibit an
unmodified hosted service. Tedix trademarks, certification marks, and claims of
official status remain separate; see `TRADEMARKS.md`.

### Can I keep unrelated software private?

The answer depends on whether it is a separate work or part of a covered
combined or modified program. Network calls alone do not produce a universal
answer. Keep boundaries explicit and obtain legal advice for a planned
proprietary integration.

### Which packages are permissive?

The [README](https://github.com/tedix-hq/tedix#licensing) lists them. Every
workspace has exactly one SPDX identifier. Permissive packages may not have
runtime dependencies on AGPL product workspaces; CI fails if one appears.

### Is there a commercial license?

Tedix GbR intends to offer a separate commercial grant for organizations that
need different terms. Terms, pricing, scope, and support require a signed
agreement from an authorized Tedix GbR representative.

### What happens if the license changes later?

Source you received under an open-source license stays available to you under
that license. A later business-model or license change applies only going
forward; it does not revoke an existing grant.

## Check the boundary

From a source checkout:

```bash
bun run oss:check
```
