---
name: tedix-guardian-session
description: Run an explicit, read-only Tedix guardian check at the start, checkpoint, or close of a local Codex or Claude Code session. Use when the user asks for session oversight or a guardian check; ordinary Tedix tasks do not need it.
---

# Guardian check for a coding session

Use the installed `tedix` CLI to give the operator a short, evidence-backed view
of this session's authority, work, and next risk. This skill runs when invoked;
the SessionStart hook may supply context, but it does not monitor the session.
Do not record prompts, tool calls, or transcripts, or create a Work Item merely
because the skill was invoked.

## Start

1. Run `tedix auth status`. Use `-w <workspace>` for the task's organization;
   distinguish the CLI profile from a Tedix OS Workspace. Report credential
   kind and relevant scopes without printing credential values.
2. If the user supplied a Work Item, read
   `tedix -w <workspace> work context <id>` and
   `tedix -w <workspace> work attempts <id> --limit 5`. Identify the
   accepted outcome, current Attempt, and lease state. A visible Attempt is
   not authority to use another executor's fence. For repo work, run the repo's
   neighbour check and follow its Work admission instructions before editing.
3. State the session's intended outcome and up to three concrete watchpoints
   from those reads. Label missing or stale evidence as unknown.

## Checkpoint

For a connected Codex chat with selected Work, run `tedix -w <profile> work
checkpoint` at a safe point, including during a goal continuation. It reads the
current Work and one bounded page of credential-targeted open Interactions.
The effective gateway and canonical organization must match the chat selection;
missing routing identity fails closed. This command makes no writes and does
not create or restore an Attempt. Follow `hasMore`/`nextCursor` through the
existing interaction-list command, and read truncated requests with
`work interaction-get <id>` before acting.

A checkpoint establishes **retrieved**, not model delivery or use. For an exact
request you have read, use the existing `work interaction-respond <id> --input
<json|@path>` with its `expectedRequestVersion`, `responseKind:
"coordination_update"`, a compact acknowledgment body, and
`resolvesRequest:false`. Record a later acted/deferred result separately with
specific evidence. Do not claim that writing an acknowledgment proves execution,
resolve a request prematurely, or approve/complete Work through an Interaction.

On an explicit check-in or after a material handoff, re-read only the facts
that may have changed: Work context/Attempt for governed work, local git status
for coding, and the named deploy or runtime surface if shipping is claimed.
Compare the current state with the accepted outcome. Surface expired authority,
overlapping ownership, missing proof, or a contradictory completion claim
promptly. Do not infer deployment from a commit or a green build.

Use these distinctions when judging a finding:

- An acceptance contract states the required outcome; its presence and a
  succeeded Attempt are recorded claims, not independent fulfillment proof.
- Flag a contradicted current claim or invalid execution authority. Mark
  missing evidence unknown rather than treating it as a proven failure.
- An expired lease forbids further Attempt-owned writes. Re-read readiness
  and obtain a fresh admitted Attempt; waiting or heartbeating cannot revive it.
  A valid owned lease is ordinary operation, not itself an alert. Historical
  expired Attempts on terminal Work do not imply current expired authority.
- Check later authorized Work and commit history before interpreting changed
  live content. A later intentional change can supersede an earlier outcome;
  current divergence alone cannot prove the original settlement was false.
- Keep the suggested action within the observed facts and this task's scope.
  A missing deployment read warrants verification, not an automatic rollback.

For a delegated tedi review, use `tedix -w <workspace> --no-repo-context tedi
<slug> ask '<bounded request>'` when repository context is unnecessary. Return
only the fields needed for each claim from gateway-native Code Mode calls.
Report context overflow or denied source access as an unavailable check; a
completed run alone does not make its conclusions correct.

## Close

Report what changed, what was verified, what remains unverified, and the next
owner or action. If this session owns an admitted Attempt, use the canonical
`work-item-operating-protocol` or `tedix-resume-work` procedure to heartbeat,
settle, and complete it; this skill itself grants no Work authority. If a
settled claim is demonstrably false, use the Work contradiction path under the
appropriate identity instead of silently repeating the claim.

When a durable handoff is requested, record only the compact finding on the
existing Work Item through `work comment`: observation time, source, unresolved
claim, and next action. Attribute host observations and tedi findings accurately.
The later session re-reads Work context and relevant changing facts. CLI context
can truncate comments; retrieve the exact comment through the scoped gateway
when the missing text affects a decision. A stored comment is a handoff, not a
fresh verification or execution authority.

Keep each guardian report compact: **state → evidence → next action**. The
guardian may advise or flag; it does not approve its own work, intercept other
sessions, or make production writes without the task's authorization and
admission.
