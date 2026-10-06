---
sidebar:
  order: 30
title: "Core concepts"
topic: "Platform"
resource_type: guide
description: "The small set of Tedix terms a new operator or agent needs before using the platform."
summary: "Public glossary for organizations, tedis, runs, apps, skills, Work Items, and approvals"
read_when:
  - Learning Tedix terminology
  - Translating a product request into Tedix objects
  - Distinguishing workers, runs, tools, skills, and Work Items
visibility: public
---

# Core concepts

Tedix separates what an organization keeps (workers, memory, permissions,
records) from the temporary compute and model calls used for one piece of
work. The compute is disposable; the identity, permissions, and record are not.

## Identity and ownership

| Term          | Meaning                                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization  | Tenant boundary that owns workers, applications, connections, memory, policy, and evidence.                                                                            |
| Tedi          | Durable digital worker with a stable identity, role, memory, skills, policies, and runtime.                                                                            |
| Workspace     | Organization-owned place in Tedix OS for related work, conversations, and shared workpieces.                                                                           |
| CLI workspace | Local connection profile for an authenticated organization gateway. Selecting it chooses where CLI commands run; it does not create or select a Workspace in Tedix OS. |

## Work and execution

| Term        | Meaning                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home        | The conversation where you ask for work. Tedix answers there or hands the request to a tedi, and saves each turn as a run.                           |
| Run         | The saved record of one piece of work: status, events, rationale, artifacts, and result.                                                             |
| Work Item   | A bounded outcome with an owner, a risk level, a budget, a time-limited claim, discussion, and a recorded result.                                    |
| Task        | Handle for asynchronous work. Having a task id does not mean the work finished.                                                                      |
| Workstation | Bounded Sandbox lease for jobs that need files, processes, a repository, or operating-system tools. It is additive compute, not the tedi's identity. |

## Capabilities

| Term       | Meaning                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| MCP app    | Tenant-configured collection of tools, resources, prompts, or widgets exposed through the Model Context Protocol.                |
| Connection | Organization- or user-scoped authorization linking an app to an external provider.                                               |
| Tool       | Callable capability with a schema, scope requirements, and an execution handler.                                                 |
| Skill      | Reusable procedure a tedi can learn, run, evaluate, and improve; some skills run on a schedule as automations.                   |
| Code Mode  | Direct gateway lane where an agent discovers namespaced tools and composes bounded JavaScript calls without creating a Home run. |

## Governance

| Term               | Meaning                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Principal          | Anyone or anything that can act or approve: a person, a tedi, or an external agent.                              |
| Policy             | Rule that permits, denies, limits, or escalates an action.                                                       |
| Approval           | A decision by a person or another worker, required before a protected action. Nobody approves their own request. |
| Rationale          | The recorded explanation for a decision or run. It explains; it does not show the result is right.               |
| Artifact           | Addressable output such as a report, file, or patch.                                                             |
| Settlement         | The result a worker records when a run or Work Item finishes. It is the worker's report, not a check.            |
| Provider reference | The outside system's own id for an action it performed, such as a sent message id.                               |

The key distinction is continuity: a tedi and its organization's memory outlive
individual runs and runtime changes, while permissions stay limited per action.

Continue with [Workers and governance](./workers-and-governance.md) or the
[Getting started](./getting-started.md) guide.
