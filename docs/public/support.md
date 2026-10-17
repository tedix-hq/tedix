---
title: "Get support"
description: "File a consented support report as a person or an authenticated agent and follow its answer."
summary: "Shared support tickets, agent intake, human-reviewed answers and operator setup"
read_when:
  - Getting help with a Tedix workflow
  - Filing or following a support ticket from an agent
  - Configuring a Support factory
visibility: public
---

# Get support

In Tedix OS, choose **Get help**. Describe what you expected, what happened,
the impact and any reproduction steps. The form includes the current route,
selected organization and last known query error when one exists. Edit those
fields, preview the report, then approve sharing that exact report with your
organization and Tedix Support. Do not include credentials, private messages,
customer records, screenshots or full logs.

The receipt gives you a ticket ID, a Work link, mirror delivery state and the
next response target. Find your tickets on **Work → Attention**. A receipt
acknowledges storage; it is not a support answer. Your organization's ordinary
Work visibility applies to its source ticket. The status tool restricts reads
to the original reporter identity in the selected organization.

Support checks approved documentation, known issues and past answers. It drafts
an answer with evidence and a next step, or escalates diagnosis to engineering
Work. A designated human admin reviews and publishes replies. A draft and an
engineering fix do not prove that your workflow recovered: report your retest
to confirm recovery or reopen the request. Support does not promise prices or
delivery dates.

## From an agent

Any authenticated agent with the selected organization's Work read/write
capabilities can use the same intake: a tedi, local Codex or a supported
ChatGPT connector. Discover and describe `file_support_request` and
`get_support_status` through your gateway; use the returned namespace.

1. Prepare a bounded report: `title`, `expected`, `actual`, optional `steps`,
   `impact`, `page`, `lastError` and approved `diagnosticRefs`, plus
   `observedAt`, `origin: "agent"` and `language: "en" | "es"`.
2. Redact it before transmission. Remove tokens, cookies, personal/customer
   data and URL query strings, fragments and userinfo. Show the exact report
   and recipient to the user. A standing delegation may authorize its defined
   metadata; never invent human approval.
3. Send the approved report, a stable `idempotencyKey`, and `consent` containing
   `approved: true`, the approval `reference` and `payloadDigest`.
4. Save the returned ticket ID. Read status with `ticketId` and optional
   `afterVersion`; honor `nextPollMs`. The result contains public updates,
   evidence, waiting-on state and the next response target. It contains no
   private drafts or platform investigation notes.
5. For a follow-up, use `file_support_request` with the same `ticketId`, its
   current `expectedVersion`, a new idempotency key, a newly approved report
   and, when appropriate, `retest: "unblocked" | "still-blocked"`.

The digest is lowercase SHA-256 of UTF-8 JSON in this order, with all defaults
included: `title`, `expected`, `actual`, `steps`, `impact`, `page`, `lastError`,
`observedAt`, `origin`, `language`, `diagnosticRefs`. Source integrations can
use `redactSupportReport` and `supportPayloadDigest` from
`@tedix/api-contract/utils/support-report`. Intake scans again and rejects a
digest mismatch. Reusing a creation key with different content is a conflict.
A stale version requires a fresh read; retries preserve the original receipt.

If the bridge is temporarily unavailable, the source receipt remains durable
with `mirrorDelivery: "pending"`. Scheduled reconciliation retries the same
mirror. Filing grants no patch, deployment, administrator or cross-tenant
Work authority.

## Operate a Support factory

An installation operator creates a dedicated Support tedi using `create_tedi`,
then configures its persona, scoped tools and `configure_support_factory`.
Use `create_factory` with that owner, `projectKey: "SUPPORT"` and
`runsAt: { timeZone: "Europe/Berlin", times: ["09:00"] }` for the daily review.
Preview first, then build within the operator's authorization. This creates
the standing objective, revisioned skill, schedule and health Work item;
inspect them using the [factory guide](./factory-agent-guide.md).
Keep tenant IDs, owners and routing configuration in D1; do not embed them in
product code. Support projects are created lazily on first intake and mirrored
to the configured platform organization. Only the consented structured report
crosses that bridge.

Use the tedi's `toolPolicy.runtimeTools`, `mcpScopes` and `mcpEndpoints` as
exact ceilings. Missing ceilings preserve the existing surface; an empty
ceiling disables it. Keep only the MCP execution/read-skill runtime tools and
the specific ticket/document read, draft, escalation and review endpoints.
Exclude deployment, repository, credential and administrator tools. Scope
ceilings intersect the tedi's normal capability profile. The API still checks
the configured Support identity for every staff operation.

New mirrors emit an owned Work acceptance event. The existing commitment-wake
dispatcher batches these into idempotent Support turns. Follow-ups and failed
retests wake the same owner. A separate maintenance receipt tracks mirror
retries. The factory's existing skill scheduler runs the daily review at its
saved local time, including daylight-saving changes. The initial goals are a first response within one
hour and resolution or a clear next step within two days; these are operating
targets, not guaranteed fix dates.

The review checks stale tickets and repeated issues, proposes engineering
Work and records an internal admin digest using `record_support_review`.
`escalate_support_ticket` creates either a diagnosis Work item for the
configured engineering owner or one focused Needs-you question. Engineering
Work follows ordinary admission. Local Codex execution can take that Work
through an opted-in channel; channel delivery and acknowledgment must be
verified separately before calling it started.

The designated admin opens **Review support queue** on Attention, reads a
draft and its evidence, then chooses **Publish this answer to the reporter**.
Only that human can publish. This action updates the ticket; it sends no email
or other external message.

## Email fallback

An email ingress stub reuses the existing opt-in tedi mailbox. An operator
must provision the actual recipient address and set its routing policy's
`supportIntake: true`. Mail addressed to the configured Support tedi creates
a restricted **Verify support email** Work item, deduplicated by the durable
mailbox message ID. Original content and attachments remain in the mailbox.
The stub quarantines the message from model execution and automatic replies.

The admin verifies the sender, organization and approved report before filing
a tenant ticket. An email address or domain never establishes membership.
Public `support@` routing requires separately verified mailbox ownership and
provider configuration; installing this source does not activate that address.
When MCP sign-in fails, use your operator's published contact channel while
that independent email route is being configured.
