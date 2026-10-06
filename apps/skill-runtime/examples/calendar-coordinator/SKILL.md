---
name: calendar-coordinator
description: Keep selected Google and Outlook calendars aligned using private busy blockers and reviewed personal-account delegation.
capabilities:
  network: false
  mcp:
    os: [reconcile_calendar_subscription]
  rationale:
    mode: important
  expectedAnnotations:
    destructive: true
    readOnly: false
audience:
  - tedi
---

# Calendar coordinator

This executable skill responds to Tedix's provider subscriptions. It does not
create a booking page or send invitations. Google and Outlook accounts stay
separate; the owner selects the exact accounts and calendars in the workspace.
The server checks the selected worker, reviewed skill revision, resource binding,
provider permissions and any personal delegation on each credential call.

## Install and review

From the repository root, preview a new worker-owned installation:

```sh
bun scripts/skills/install-calendar-coordinator.ts \
  --api-url https://api.tedix.dev --organization ORGANIZATION_UUID \
  --worker WORKER_UUID --google-provider PROVIDER_ID --google-calendars 3 \
  --outlook-provider PROVIDER_ID --outlook-calendars 2
```

The default is a local dry run, with no network calls. To create the skill and
organization-local Blueprint, an operator supplies `TEDIX_API_KEY` in the
environment and repeats the command with `--apply --reviewed` and
`--review-reason "Reviewed the workflow, permissions and failure handling"`.
Never put the key in a command argument. The installer creates a new skill;
it refuses an existing matching asset instead of overwriting it. The published
Blueprint pins that organization's worker-owned skill revision and source hash.
This is an explicit operator activation, not evidence of a successful provider
run. The installer does not connect accounts, grant personal delegation, start
subscriptions or write calendar events.

## Connect, preview and enable

Instantiate the local Blueprint and select each named account and calendar.
Choose the active worker and review this skill's current revision. Review the
chosen create/update/delete actions and read/subscribe access, including a finite
expiry for personal-account delegation. Preview the rolling availability window
before enabling automation. Provider subscriptions then start this workflow;
there is no calendar cron or chat reminder in this asset.

Busy periods become private blockers without attendees or copied meeting
content. Only owned, unchanged blockers can be updated or cleared. Clearing an
Outlook blocker releases its busy time using a conditional update; Outlook keeps
a private event marked as free. Google can conditionally delete the owned hold.
The server refuses operations lacking verified safe provider support.

## Watch the result

The workspace distinguishes enabled configuration from active monitoring and
shows the last successful check and the latest receipt. A partial, conflicted or
unknown receipt fails this workflow and needs attention; it is not a successful
calendar synchronization. Do not retry an uncertain write blindly: use the
workspace's readback recovery first. Undo is separately previewed and applies
only to server-confirmed eligible changes; it pauses monitoring. Deleted holds
are not promised as restorable. Disable automation or revoke personal consent
when access should stop. Expiry, account changes and skill changes can require
renewed review, consent and a new preview.

Incoming workflow parameters identify a persisted subscription and its skill
revision. They grant no authority and cannot select another owner or account.
