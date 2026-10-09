---
sidebar:
  order: 10
title: "Tedix documentation"
description: "Build, govern, and operate long-lived AI workers on Cloudflare."
summary: "Public introduction to Tedix and its documentation"
read_when:
  - Learning what Tedix provides
  - Choosing where to begin with Tedix
  - Giving a human or agent a safe public entry point to Tedix
visibility: public
---

# Tedix documentation

**AI coworkers that show their work.**

Tedix gives your team AI coworkers, called tedis, for recurring work. Ask a
tedi to work from a source you grant, then open the run to see what it used,
what it produced, and who approved any outside action.

To use the invited Cloud beta, [connect the Tedix CLI](./learning-paths/first-connection.md),
then get a useful result from [your first digital worker](./learning-paths/first-worker.md).
To use Tedix from an assistant you already have, [add the Tedix plugin to
ChatGPT, Codex or Claude](./learning-paths/first-plugin.md).
To evaluate the product from source without a Cloud account, [run Tedix
locally](./getting-started.md). [Release status](./release-status.md) lists what
is available today.

## Choose your path

| You want to…                                        | Start with                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| Run Tedix locally without a Cloud account           | [Getting started locally](./getting-started.md)                            |
| Use Tedix from ChatGPT, Codex or Claude             | [Use Tedix in ChatGPT, Codex and Claude](./learning-paths/first-plugin.md) |
| Connect this computer to a Cloud organization       | [First connection to Tedix Cloud](./learning-paths/first-connection.md)    |
| Run an existing worker and find its result          | [Run a digital worker](./learning-paths/first-worker.md)                   |
| Recover a CLI connection or worker run              | [Troubleshoot Tedix tasks](./troubleshooting.md)                           |
| Check what is available today                       | [Release status](./release-status.md)                                      |
| Learn the vocabulary                                | [Core concepts](./concepts.md)                                             |
| Understand worker permissions and approvals         | [Worker permissions and governance](./workers-and-governance.md)           |
| Choose between skills, automations, flows, and runs | [Skills, automations, flows, and runs](./skills-flows-workflows.md)        |
| Give an agent reliable Tedix context                | [Agent guide](./agent-guide.md)                                            |
| Connect applications and tools                      | [MCP app platform](./mcp-app-platform.md)                                  |
| Publish public or organization-only product docs    | [Documentation sites](./docs-sites.md)                                     |
| Edit and publish website content                    | [Websites and CMS](./cms.md)                                               |
| Deploy into your own Cloudflare account             | [Self-hosting and managed service boundary](./self-hosted-boundary.md)     |
| Understand the license boundary                     | [Licensing and operator FAQ](./licensing.md)                               |

## Read these docs as an agent

Each documentation site publishes a compact index and a complete Markdown
corpus:

```text
https://docs.tedix.dev/llms.txt
https://docs.tedix.dev/llms-full.txt
```

Use `llms.txt` to choose pages, then fetch the Markdown linked from it. The
[agent guide](./agent-guide.md) covers source priority, discovery, and when an
agent may change things.

## Reference

- [Install the Tedix CLI](./cli.md)
- [Cloudflare architecture](./cloudflare-architecture.md)
- [Installation manifests](./installation-manifests.md)
- [Dependency pins, overrides and patches](./dependency-pins.md)
- [Coding-agent guide for the source repository](./AGENTS.md)
- [Telemetry and network contact](./telemetry.md)

## What you can build

Internal operations workers, department specialists, customer-facing
assistants, and single-task workers. Each worker gets only the tools and
permissions it needs, and its identity, history, memory, policies, and
artifacts belong to the organization that runs it.
