# Agent review intake configuration

The API uses `AGENT_REVIEW_PROJECT_ID` from installation configuration. Keep
real values in the operator's private configuration. The referenced active
Work project must have an objective, a lead tedi and metadata
`{"agentReviewEnabled": true}`. Disabling it pauses intake. The separate
`AGENT_REVIEW_RATE_LIMITER` binding caps each IP and all submissions at five
requests per minute; a missing binding fails closed.

Register `file-agent-review.json` as an `app_tools` row in the installation's
agent-facing MCP app, using its real `appId`. Its first-party RPC transport calls
`workItems/fileAgentReview`, which uses the
same intake service, validation, redaction, deduplication and global quota as
curl. It requires normal Work write authority and keeps the API's external-host
SSRF guard intact. Its explicit `work` namespace avoids deriving a JavaScript
binding from the public HTTP path. Regenerate `inputSchema` from
`FileAgentReviewInputSchema` when changing the envelope.

Before enabling MCP submissions, set `mcpConfig.capturePayloads` to `false` on
every MCP app used to submit reviews, including the Code Mode entry point.
Read the setting back: the optional forensics capture layer must never store
review bodies or feedback. Its default secret redaction does not remove all
emails. Anonymous HTTPS submissions bypass tool-payload capture; the intake
handler never logs request bodies.

The project lead receives an asynchronous, idempotent wake pointing to the
review Work Item. Report content never becomes a trusted wake prompt. The lead
verifies bugs into proposed Work, puts suggestions in one comment and records
a thank-you. A queued wake is not completed triage. Identical submission retries
reuse the stored Work and wake key after a failed notification. Local onboarding
disables intake and its private-project fence; deployed installations still fail
closed when their configured review policy cannot be loaded.

The fleet's existing 15-minute tick sweeps up to 50 eligible reviews per pass.
Project metadata configures recovery separately from intake:

```json
{
	"agentReviewEnabled": true,
	"agentReviewTriage": { "enabled": true, "retryMinutes": 30, "maxRetries": 3 }
}
```

Absent recovery settings use those defaults. `retryMinutes` is bounded to
5–120 minutes and `maxRetries` to 0–5. Each attempt claims a durable retry slot
before dispatch and uses a fresh idempotency key; failed dispatches also consume
a slot. Exhausted reviews stay pending for maintainers. The lead saves its
combined suggestions comment with `metadata.agentReviewTriageResult=true`;
only that lead's nonempty saved result counts as completed triage. New proposed
findings link back with `parentWorkItemId`. Activity receives one content-free
completion event and, if still pending after two hours, one late event. These
are private Work events, not public responses or verification of findings.

Use the lead's existing scheduler for a weekly private digest: review count,
fit scores, verified bug/proposal links, recurring blockers and pending triage.
Read the schedule back, record its next run and expiry, and include pending
notifications in the digest. Do not add a second review queue or public return
channel. The configured project is restricted by the shared authentication guard to
fresh active organization owners/admins and its designated lead tedi. Ordinary
members, other tedis, API keys and generic service principals cannot access it.
Reads returning review references inside an aggregate fail closed for those
principals; they are not partially redacted. Keep this project binding configured
while any reviews remain stored, including when intake is paused.

Receipt URLs contain random UUIDs and reveal only `received`, with no report,
organization, timestamps, triage details or comments. Never log request bodies.
The HTTPS intake counts streamed bytes rather than trusting Content-Length;
leave the `website` honeypot empty. Secrets and emails are redacted before storage.
Reviewers can request deletion privately via the maintainer contact with their
receipt URL. Keep triage findings and comments in the same private project.
Digests outside that project may acknowledge receipt only; never quote or
summarize private review contents, publish them or use them in marketing.
