# Agent review intake configuration

The API uses `AGENT_REVIEW_PROJECT_ID` from installation configuration. Keep
real values in the operator's private configuration. The referenced active
Work project must have an objective, a lead tedi and metadata
`{"agentReviewEnabled": true}`. Disabling it pauses intake. The separate
`AGENT_REVIEW_RATE_LIMITER` binding caps each IP and all submissions at five
requests per minute; a missing binding fails closed.

Register `file-agent-review.json` as an `app_tools` row in the installation's
agent-facing MCP app, using its real `appId`. Replace the API origin for an
own-account installation. Its external transport POSTs to the same intake as
curl, with the same validation, redaction, deduplication and rate limits. It
requires no provider credential. Regenerate `inputSchema` from
`FileAgentReviewInputSchema` when changing the envelope.

The project lead receives an asynchronous, idempotent wake pointing to the
review Work Item. Report content never becomes a trusted wake prompt. The lead
verifies bugs into proposed Work, puts suggestions in one comment and records
a thank-you. A queued wake is not completed triage. Identical submission retries
reuse the stored Work and wake key after a failed notification.

Use the lead's existing scheduler for a weekly private digest: review count,
fit scores, verified bug/proposal links, recurring blockers and pending triage.
Read the schedule back, record its next run and expiry, and include pending
notifications in the digest. Do not add a second review queue or public return
channel. Follow the installation's project-access policy; never publish reports
or use them as marketing content.
