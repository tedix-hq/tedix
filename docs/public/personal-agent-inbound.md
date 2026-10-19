---
title: "Personal-agent findings"
description: "Enroll a personal agent to submit findings to your existing Feed without execution authority."
summary: "Browser intake, credentials, receipts and revocation for owner-enrolled personal agents"
read_when:
  - Connecting a personal agent to a user's Feed
  - Submitting a finding through a browser form or webhook
visibility: public
---

# Personal-agent findings

This source feature captures findings as proposed Work in your existing Feed.
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
4. Open your Feed in organization scope, or with the enrolled project selected.
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
revocation and isolation against the D1 facade. The Feed projection test is
`apps/os/src/lib/personal-agent-feed.test.ts`. These prove local behavior;
they do not prove a deployed Cloud path or another product's consent flow.

Outbound work can reference the canonical Work id and its
`provenance.personalAgentContribution`; it needs separate authorization and
provider delivery evidence. Metrics can use `personal_agent.finding_received`
events, original capture times and duplicate receipts. Neither extension needs
another intake queue. The source agent id identifies an owner-enrolled inbound
credential, separately from the system intake actor and any coding-agent principal.
