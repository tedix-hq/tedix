---
sidebar:
  order: 110
title: "Release status"
topic: "Reference"
resource_type: reference
description: "What is available today: public source, invited Cloud beta, public CLI beta, and experimental self-hosting."
summary: "The single place that states Tedix availability and release policy"
read_when:
  - Checking what Tedix offers today
  - Deciding between Tedix Cloud, local mode, and self-hosting
  - Checking how source, releases, and commits are published
visibility: public
---

# Release status

This is the only page that states what is available. Other pages link here
instead of repeating it.

## Available today

| Surface      | Status       | What it means                                                                                                                         |
| ------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Source       | Public       | [tedix-hq/tedix](https://github.com/tedix-hq/tedix) on GitHub. `main` is the source line; anyone can clone, read and run it.          |
| Local mode   | Preview      | From a checkout, `bun run-local` starts OS, onboarding, API/MCP and isolated persistence without model calls. No account is needed.   |
| Tedix CLI    | Public beta  | Anyone can download it from [`downloads.tedix.dev`](https://downloads.tedix.dev/latest.json); using it with Cloud needs Cloud access. |
| Tedix Cloud  | Invited beta | The managed service. Access is by invitation; an approved user can create their own organization.                                     |
| Self-hosting | Experimental | Deployment tooling exists; current `main` is not certified for a fresh account and has no upgrade or backup guarantee.                |

To request Cloud access, use the [contact page](https://tedix.dev/contact/).
Ask questions and share ideas in
[GitHub Discussions](https://github.com/tedix-hq/tedix/discussions). Report a
security issue privately to [security@tedix.dev](mailto:security@tedix.dev).

## Releases

The CLI ships versioned `cli-v*` releases. Product `main` is the source line
and fixes land as ordinary commits. There are no nightly, candidate, or
long-term-support channels.

Tedix Cloud builds from product `main` plus private operational configuration:
credentials, live account settings, and runbooks. Public source does not
change this deployment boundary. Product code and patches belong in the
product repository; operations remain private.

## Commits

Maintainers commit directly to `main`. Commit messages and author identities
are as public as the files: they name a real person or agent, never a customer,
and never carry a credential or infrastructure identifier. The pre-push secret
scan checks messages and authors as well as files.

Maintainer commits keep their `Work-Item:` and `Agent-Session:` trailers. They
identify the maintainer task and the agent session that made the change; the
ids do not resolve publicly. Pull requests are currently disabled; see
[CONTRIBUTING.md](https://github.com/tedix-hq/tedix/blob/main/CONTRIBUTING.md).

## Known limits

- Conversation continuity is not permanent learning. Facts and skills are
  stored separately and selected per run.
- A completed run records what the worker reported. It does not check that the
  reply is correct.
- An outside action (a sent message, a created record) is confirmed only by the
  provider's own reference, not by the run finishing.
- Delegation limits apply only where an organization policy turns them on.
- Local mode makes no model calls unless you add inference on your own
  Cloudflare account. It does not configure connectors or deploy anything.
- The own-account deployment path has not been re-validated against the
  current `main`.
