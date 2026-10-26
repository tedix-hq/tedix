---
title: "Personal-agent findings"
description: "Enroll a personal agent to submit findings to your existing Activity without execution authority."
summary: "Browser intake, credentials, receipts and revocation for owner-enrolled personal agents"
read_when:
  - Connecting a personal agent to a user's Activity
  - Submitting a finding through a browser form or webhook
visibility: public
---

# Personal-agent findings

This source feature captures findings as proposed Work in your existing Activity.
It needs a managed release before it is available on a Cloud installation.
It does not run actions, enroll an agent in another product, or provide consent
on your behalf. A separate owner confirmation in that product remains yours.

## Enroll and submit

1. As the signed-in person, call `personalAgentInbound.enroll` with
   `{"sourceAgentName":"Cedar Scout","projectId":"<your-active-project-id>"}`.
   You need OS author permission and an active, purpose-linked project in your
   credential's organization. Enrollment always represents your canonical user
   identity; another user id cannot be supplied. Machine credentials cannot
   enroll. Save the returned `token` securely; it is returned only on enrollment.
2. Build the browser form URL from the returned enrollment:
   `<api-origin>/public/personal-agent/<orgId>/<representedUserId>/<id>`.
   Encode each path segment. The URL contains no credential. Give the enrolled
   fictional agent that URL and its token through an authorized secure channel.
3. Open the form over HTTPS. Enter the enrollment token, a stable external
   finding ID (for example `cedar-001`), title, finding body, HTTPS source
   reference and either FYI or Proposal. Submit once. The page returns a Work
   receipt and capture time. Repeating the same external finding ID for that
   enrollment returns the original receipt without another post.
4. Open your Activity in organization scope, or with the enrolled project selected.
   The post names Cedar Scout, links its proposed Work, and carries the source
   reference, represented user, channel and external finding ID. The receipt
   explanation says no action executed. FYI is a signal; Proposal remains
   proposed Work until separately reviewed and admitted.
5. Call `personalAgentInbound.list` with `{}` to read your enrollment metadata,
   or `personalAgentInbound.revoke` with `{"id":"<enrollment-id>"}` to disable it.
   Revocation checks the same owner and credential organization. It preserves
   existing receipts and prevents new submissions with the old token.

Capable agents can POST JSON to the same form URL, with
`Authorization: Bearer <enrollment-token>` and `Content-Type: application/json`:

```json
{
	"externalFindingId": "cedar-001",
	"title": "A useful release to review",
	"body": "Cedar found a release worth reviewing.",
	"evidenceUrl": "https://cedar.example/findings/001",
	"kind": "fyi"
}
```

JSON returns `workItemId`, `externalFindingId`, `capturedAt`, `duplicate` and
`disposition: "proposed"`. New deliveries return 201; duplicates return 200.
Invalid/revoked credentials, another tenant or another recipient return 401.
Inputs are bounded and cannot choose an actor, recipient or executable action.
Tokens use the existing encrypted organization-secret mechanism and never go
in URLs or receipt payloads. Installation rate limits also apply.

## Workspace chat and extension points

Ask "Show my personal-agent enrollments" or "Revoke my Cedar Scout enrollment".
The contract procedures above are the tools behind those requests; discover
their exact callable and schema after the installation's tool catalog is synced.
Enrollment creates a credential, so its returned token must be handled as a
secret rather than copied into chat transcripts or logs. Browser intake itself
requires no Tedix owner login and grants no authority to impersonate the person.

The source test `apps/api/src/personal-agent-inbound-routes.test.ts` exercises
enrollment, ten fictional browser/webhook deliveries, duplicate receipts,
revocation and isolation against the D1 facade. Activity projection test is
`apps/os/src/lib/personal-agent-feed.test.ts`. These prove local behavior;
they do not prove a deployed Cloud path or another product's consent flow.

## Decisions, evidence and acknowledgments

The existing outcome-maintenance tick records each enrolled finding's addressed
person's canonical resolving answer and independent Work confirmations. A
Work comment and `personal_agent.outcome_recorded` event are written together.
The record includes the external finding key, Work and Interaction ids, selected
option, deciding person and time, response version, evidence reference and
observation time. An answer alone has execution state `unverified`; a matching
verification applies only to its cited claim. Current independent Work
confirmations are labeled `corroborated`, with their observer, reference and
observation version. Historical system readback records may be labeled
`verified`; there is no new automatic verification service. Corrections retain
the original response reference and supersede the prior outcome. Agent-session answers and
relayed actor metadata do not become the represented person's own decision.

Work comments are always enabled. As the enrolling person, use
`personalAgentInbound.configureDelivery` with
`{"id":"<enrollment-id>","email":{"memberId":"<agent-member-id>","senderAddressId":"<sender-address-id>"}}`
to enable optional email. The recipient is resolved from that active external
agent member's own address, with the same represented person and organization;
it cannot be supplied as an arbitrary address. The sender must be an active
organization email address. Passing `email: null` disables email. This changes
delivery configuration, not membership, representation or permissions.

The existing email mechanism sends once per outcome revision. A recorded send
means provider acceptance, not delivery or reading. If dispatch stops or the
provider result is ambiguous, `sending_or_unknown` remains visible; automatic
retry cannot safely rule out duplicate mail. Inspect the provider receipt before
any operator recovery. Work comments and polling remain available independently.

An agent can poll `<form-url>/outcomes?after=0` over HTTPS with its enrollment
token in the Bearer header. Pages contain at most 100 outcomes, sequence numbers,
`nextCursor`, `hasMore`, email status and acknowledgment time. Keep paging with
the returned cursor; retrying a page is safe. Poll from zero when refreshing
delivery status for older records. Tokens never belong in URLs.

POST JSON to `<form-url>/outcomes/ack` with the same Bearer credential and
`{"outcomeId":"<returned-outcome-id>"}`. An optional `reminderId` records the
agent's report of retiring that reminder. Repeated acknowledgments are deduped.
Neither an acknowledgment nor that report independently verifies suppression.
Revocation disables submission, polling and acknowledgment for this enrollment;
an email already claimed for dispatch may still finish.

## Seven-day value summary

Account settings shows **Personal-agent contributions** in the existing view.
In workspace chat ask "Show my personal-agent contribution summary" using
`personalAgentInbound.value` with `{}` after tool discovery. The capture cohort
is the rolling seven-day UTC interval `[start, end)`, deduplicated per enrolled
agent and external finding key. It shows proposals versus FYIs and the number
decided from the card divided by received decision cards, including zero denominators.
Outcome revisions, verified evidence, emails sent and acknowledgments are
separate counters. Each counter excludes observations after the window end.

Reminders avoided and the historical chat baseline remain unknown without
independent matched suppression observations and a covered chat inventory.
Agent-reported reminder retirements are disclosed separately and deduplicated
by reminder id. There is no claimed savings target or live seven-day pilot.
`apps/api/src/services/personal-agent-outbound.test.ts` exercises the ten-item
fictional correlation pilot with a mocked email binding, not real recipients.
All state reuses the Work response, evidence, event and comment ledgers.
