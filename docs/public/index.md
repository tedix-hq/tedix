---
sidebar:
  order: 10
title: "Tedix documentation"
description: "Hand off the work. Tedix brings back only the decisions that need you, and handles the rest."
summary: "Public introduction to Tedix and its documentation"
read_when:
  - Learning what Tedix provides
  - Choosing where to begin with Tedix
  - Giving a human or agent a safe public entry point to Tedix
visibility: public
---

# Tedix documentation

**Hand off the work. Tedix brings back only the decisions that need you, and
handles the rest.**

Tedix is for people who use AI assistants for real work and are tired of
explaining their company again in every chat, checking on approvals in many
open windows, and not knowing what an assistant actually did.

With Tedix:

- people and assistants work from one shared list, so nothing is done twice;
- your company's facts and your preferences reach whichever assistant you use;
- every piece of work keeps a record of what was used, what came out and who
  said yes;
- decisions that need you wait in one short stack, the Deck, and everything
  else goes to a timeline, the Feed.

Tedix's own assistants are called tedis. A tedi has one job, its own memory
and only the access you give it, and it asks before anything risky.

**Start in five minutes:** [add Tedix to Claude, ChatGPT or
Codex](./learning-paths/first-plugin.md). Claude chat and Cowork need no
install, only a connector URL. Then [give a tedi its first
task](./learning-paths/first-worker.md). Developers who want a terminal can
[connect the Tedix CLI](./learning-paths/first-connection.md). To try it from
source without a Cloud account, [run Tedix locally](./getting-started.md).
Tedix Cloud is an invited beta; [Release status](./release-status.md) lists
what is available today.

## Choose your path

**Start here**

| You want to…                                                           | Start with                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Use Tedix from the assistant you already have (Claude, ChatGPT, Codex) | [Use Tedix in ChatGPT, Codex and Claude](./learning-paths/first-plugin.md) |
| Give a tedi a task and find its result                                 | [Give an AI assistant a task](./learning-paths/first-worker.md)            |

**For developers and operators**

| You want to…                                     | Start with                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Install the Tedix CLI                            | [Install the Tedix CLI](./cli.md)                                       |
| Connect this computer to a Cloud organization    | [First connection to Tedix Cloud](./learning-paths/first-connection.md) |
| Run Tedix locally without a Cloud account        | [Getting started locally](./getting-started.md)                         |
| Start a new agent session with no context        | [Start here as an agent](./agent-start-here.md)                         |
| Give an agent reliable Tedix context             | [Agent guide](./agent-guide.md)                                         |
| Build or inspect a Workspace factory             | [Factory guide for agents](./factory-agent-guide.md)                    |
| Keep a factory producing useful work             | [Factory continuity](./factory-continuity.md)                           |
| Get help as a person or an agent                 | [Get support](./support.md)                                             |
| Receive findings from a personal agent           | [Personal-agent findings](./personal-agent-inbound.md)                  |
| Install or build a workspace app                 | [Build a workspace app](./build-a-workspace-app.md)                     |
| Connect applications and tools                   | [MCP app platform](./mcp-app-platform.md)                               |
| Publish public or organization-only product docs | [Documentation sites](./docs-sites.md)                                  |
| Edit and publish website content                 | [Websites and CMS](./cms.md)                                            |
| Deploy into your own Cloudflare account          | [Self-hosting and managed service boundary](./self-hosted-boundary.md)  |
| Review the Worker and database layout            | [Installation manifests](./installation-manifests.md)                   |
| Recover a CLI connection or worker run           | [Troubleshoot Tedix tasks](./troubleshooting.md)                        |

**Understand Tedix**

| You want to…                                        | Start with                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Learn the vocabulary                                | [Core concepts](./concepts.md)                                              |
| Organize initiatives into projects and factories    | [Factories, Workspaces and Projects](./factories-workspaces-projects.md)    |
| See which sessions work on which project            | [Track sessions per project](./sessions-per-project.md)                     |
| Let the supervisor resume sessions in Documents     | [Give the supervisor Full Disk Access](./supervisor-full-disk-access.md)    |
| Understand what a tedi may do and who approves      | [What an AI assistant may do and who says yes](./workers-and-governance.md) |
| Choose between skills, automations, flows, and runs | [Skills, automations, flows, and runs](./skills-flows-workflows.md)         |
| Check what is available today                       | [Release status](./release-status.md)                                       |
| Understand the license boundary                     | [Licensing and operator FAQ](./licensing.md)                                |

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

## What teams use it for

Recurring jobs with a clear result, for example:

- finding public threads where your product could help and drafting a reply
  for you to post, edit or skip;
- matching supplier invoices against what arrived and showing only the
  mismatches;
- summarizing a critical error report, finding its owner and asking before
  alerting anyone.

Each tedi gets only the tools and permissions its job needs. Its history,
memory, rules and results belong to the organization that runs it, even when
you change models or tools.
