---
sidebar:
  order: 30
title: "Core concepts"
topic: "Platform"
resource_type: guide
description: "The small set of Tedix terms a new operator or agent needs before using the platform."
summary: "Public glossary for organizations, tedis, runs, Work Items, epics, milestones, Documents, apps, skills, and approvals"
read_when:
  - Learning Tedix terminology
  - Translating a product request into Tedix objects
  - Distinguishing tedis, runs, tools, skills, and Work Items
visibility: public
---

# Core concepts

Tedix separates what an organization keeps (tedis, memory, permissions,
records) from the temporary compute and model calls used for one piece of
work. The compute is disposable; the identity, permissions, and record are not.

## Identity and ownership

| Term          | Meaning                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization  | Tenant boundary that owns tedis, applications, connections, memory, policy, and evidence.                                                                              |
| Tedi          | AI assistant with a stable identity, role, memory, skills, policies, and runtime.                                                                                      |
| Workspace     | Organization-owned place in Tedix OS for related work, conversations, and shared workpieces.                                                                           |
| CLI workspace | Local connection profile for an authenticated organization gateway. Selecting it chooses where CLI commands run; it does not create or select a Workspace in Tedix OS. |

## Work and execution

Open Work to review one decision at a time in your installed Decisions app.
Finish the batch to see when the next cards arrive, or open Activity to read
recent activity and receipts. Your organization chooses the apps and batch
settings; [workspace apps](./build-a-workspace-app.md#decisions)
explains how to set them up.

| Term        | Meaning                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home        | The conversation where you ask for work. Tedix answers there or hands the request to a tedi, and saves each turn as a run.                                                                                                             |
| Run         | The saved record of one piece of work: status, events, rationale, artifacts, and result.                                                                                                                                               |
| Work Item   | A bounded outcome with an owner, a risk level, a budget, a time-limited claim, discussion, and a recorded result.                                                                                                                      |
| Epic        | A bigger piece of work inside a project, like an incident, an investigation or a feature. It groups several tasks and has one owner; tools and the CLI call it a case. Stages: investigating, planning, executing, monitoring, closed. |
| Milestone   | A project's group of Work Items due together, with an optional target date. Statuses: proposed, planned, active, done, cancelled.                                                                                                      |
| Output      | A document, sheet, presentation or video in a Workspace. Every save is an append-only revision; the Output points at its current one.                                                                                                  |
| Task        | Handle for asynchronous work. Having a task id does not mean the work finished.                                                                                                                                                        |
| Interaction | A question or request a session or tedi raises on a Work Item. An answer given in Tedix OS reaches the session that asked; a tedi may answer in its own name, and a later human answer is recorded as a correction.                    |
| Delegation  | A lead session's hand-off of work to a subagent or another session, registered as an accepted Work Item and completed with a recorded outcome.                                                                                         |
| Workstation | Bounded Sandbox lease for jobs that need files, processes, a repository, or operating-system tools. It is additive compute, not the tedi's identity.                                                                                   |

## Capabilities

| Term         | Meaning                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP app      | Tenant-configured collection of tools, resources, prompts, or widgets exposed through the Model Context Protocol.                                                     |
| Connector    | The MCP connection a host such as Claude, Codex or ChatGPT uses to reach your organization's tools: `https://connect.mcp.tedix.dev/mcp`, with sign-in in the browser. |
| Tedix plugin | Packaged Tedix skills and the connector for Claude Code, Codex and the ChatGPT desktop app; Claude chat and Cowork add the connector directly.                        |
| Connection   | Organization- or user-scoped authorization linking an app to an external provider.                                                                                    |
| Tool         | Callable capability with a schema, scope requirements, and an execution handler.                                                                                      |
| Skill        | Reusable procedure a tedi can learn, run, evaluate, and improve; some skills run on a schedule as automations.                                                        |
| Code Mode    | Direct gateway lane where an agent discovers namespaced tools and composes bounded JavaScript calls without creating a Home run.                                      |

<a id="governance"></a>

## Who may do what

| Term               | Meaning                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Principal          | Anyone or anything that can act or approve: a person, a tedi, or an external agent.                                                          |
| Policy             | Rule that permits, denies, limits, or escalates an action.                                                                                   |
| Approval           | A decision by a person or another tedi, required before a protected action. Nobody approves their own request.                               |
| Rationale          | The recorded explanation for a decision or run. It explains; it does not show the result is right.                                           |
| Artifact           | Addressable output such as a report, file, or patch.                                                                                         |
| Settlement         | The result a tedi records when a run or Work Item finishes. It is the tedi's report, not a check.                                            |
| Attempt            | One agent session's try at a Work Item. A Work Item can have several Attempts over time.                                                     |
| Admission          | The check that a Work Item is ready and that this agent may start it, done before an Attempt begins.                                         |
| Lease              | The time-limited hold a running Attempt keeps by sending heartbeats. If the agent stops, the lease expires and the Attempt can be restarted. |
| Provider reference | The outside system's own id for an action it performed, such as a sent message id.                                                           |

The key distinction is continuity: a tedi and its organization's memory outlive
individual runs and runtime changes, while permissions stay limited per action.

Continue with [What an AI assistant may do and who says yes](./workers-and-governance.md) or the
[Getting started](./getting-started.md) guide.
