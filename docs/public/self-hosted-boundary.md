---
sidebar:
  order: 120
title: "Self-hosting Tedix and the managed service boundary"
topic: "Reference"
resource_type: reference
description: "What the public Tedix product includes, what Tedix Cloud operates for you, what self-hosting costs, and what support each path gets."
summary: "Support levels, costs, and the managed-only capability list for self-hosted Tedix"
read_when:
  - Deciding between self-hosting Tedix and Tedix Cloud
  - Checking whether a capability is part of the public product or the managed service
  - Estimating what a self-hosted installation needs and costs
visibility: public
---

# Self-hosting Tedix and the managed service boundary

Self-hosting is experimental; [Release status](./release-status.md) has the
current state.

## The same product either way

The public source is the **complete tenant product**: identity, runtime,
memory, skills, Work Items, policy, approvals, audit records, export, the MCP
platform, the CLI, contracts, schemas, and the deployment path. There is no
reduced community edition; governance and audit are in every tier.

What Tedix Cloud charges for is **operation**: tested releases, upgrades,
credential custody, backups, fleet management, compliance reports, incident
response, and support. The paid boundary is a service, not a feature switch.

## Support

| Surface                   | Support                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| Tedix Cloud               | Invited beta; managed support follows the customer's agreement.            |
| Public `main`             | Fast-moving source; no compatibility promise. Issues are welcome, no SLA.  |
| Local mode                | The way to run from source for evaluation and development; issues welcome. |
| Self-hosted installations | Experimental and unsupported: no upgrade, backup, or restore guarantees.   |
| Stable releases           | None yet; support terms will be published with the first stable release.   |

Community support has no response-time guarantee. Security reports follow
[SECURITY.md](https://github.com/tedix-hq/tedix/blob/main/SECURITY.md).

## Cloudflare only

Self-hosted means the Tedix product and its tenant data run in **your
Cloudflare account** with your own vendor accounts. Tedix is built on Workers,
Durable Objects, Workflows, D1, and R2. There is no supported deployment on
AWS, GCP, Azure, Kubernetes, or Docker Compose and no plan to add one. Identity
uses Descope only (`packages/auth`), and model calls go through
`packages/workers-ai` (Workers AI by default); neither has a provider-neutral
adapter. If you need to run on arbitrary infrastructure, Tedix is the wrong
choice.

## What it needs and costs

| Dependency                   | Why                                                      | Cost                                                                                         |
| ---------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Cloudflare Workers Paid plan | Workers, Durable Objects, Workflows, D1, R2              | [US$5/month minimum plus usage](https://developers.cloudflare.com/workers/platform/pricing/) |
| Descope project              | The identity provider (`packages/auth`)                  | [Descope pricing](https://www.descope.com/pricing); a free tier exists                       |
| Workers AI                   | The default model provider (`packages/workers-ai`)       | [Metered per use](https://developers.cloudflare.com/workers-ai/platform/pricing/)            |
| Optional Cloudflare products | Workstation containers, browser rendering, email routing | Extra usage; containers bill for memory while awake                                          |

A rough estimate, not a measured bill: a small, lightly used installation
without workstation containers costs low tens of US dollars a month. Model
calls and containers dominate as use grows. A graph database is optional.

Use your own Descope project with the exact deployed hostnames as Approved Web
Domains, and a separate non-production project while evaluating. The installer
checks the account's capabilities and the Descope project before it changes
anything; see [Installation manifests](./installation-manifests.md#identity-provider-readiness).

Running Tedix yourself makes you the operator: upgrades, migrations, backups
and restore drills, provider accounts and credentials, monitoring, cost
control, and incident response are yours.

## What the public product includes

- tedi identity, the agent runtime, memory, skills, and Work Items;
- policy, approvals, budgets, rationale, and audit records;
- the MCP edge and app platform, CLI, API contracts, schemas, and SDKs;
- plan limits that work without any payment provider (`billingSettlement`
  defaults to `disabled`; no Stripe secrets needed);
- export and import of customer-owned data;
- the Cloudflare deployment path: installation manifest, account preflight,
  resource provisioning, and Wrangler overlays.

Deployment profiles (`developer`, `smb`, `enterprise`) define what an
installation must declare. Identity integration and data export are required
in every profile; they are never managed-only.

The Work Item board, including claiming, settling, and commenting, is tenant
product and ships in full: it is how a tenant's own workers coordinate.

## What is managed-only

These are part of the paid Tedix Cloud service. The public source may contain
their code; only live configuration, credentials, and operations stay private.

- tested releases, managed upgrades, migrations, rollback, and incident
  response;
- managed provider credentials: OAuth apps, connector custody, key rotation,
  quota escalation;
- managed backups, restore drills, monitoring, retention, legal hold, regional
  controls, and private networking;
- curated, reviewed catalog content and marketplace promotion;
- running many installations: cross-installation administration, usage
  billing, provider-cost reconciliation, SLAs, and premium support.

A self-hosted installation runs with the fleet-commercial features off
(`TEDIX_FLEET_AUTHORITY_MODE=disabled`): commercial API procedures refuse
before touching storage, commercial schedules do not run, and payment webhooks
reject. Tests enforce this for every procedure.

## Choosing

Choose **Tedix Cloud** if you want the product without operating it. Choose
**local mode** to read, change, and try the source. Treat **self-hosting** as
experimental work with your own Cloudflare and provider accounts. Either way,
your organization's memory, skills, records, and history remain yours to
export.
