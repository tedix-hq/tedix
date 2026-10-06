---
name: tedix-delegate
description: Delegate a user-requested task to Tedix Home or a named tedi and follow its durable run. Use for tedi help, handoff, or existing run progress; not for a direct tool read or local harness admission.
---

# Ask a tedi and follow the result

Use the authenticated native Tedix plugin connection. No CLI is required.
Honor an explicit user surface or repository CLI policy; `tedix ask` is the
CLI entry to the same durable Home path. Authentication failures go through
`tedix-connect`.

Before dispatch, distinguish an available callable from actual permission to
submit it. If the connection is read-only or the dispatch capability is denied,
do not submit or silently broaden consent. Offer a bounded read of an existing
run the user identified, or prepare handoff text in this chat. Name the missing
capability from the returned access check and explain the normal owner consent
step when the user wants dispatch. A handoff draft is not a queued run.

1. Keep the intended organization and the user's requested outcome. Discover
   the exact callable with a compact `discover.search` in that organization
   namespace, then load only its schema with `discover.describe(callable)`.
   The direct gateway calls it `home.ask`; Connect can expose
   `enqueue_kernel_runtime_message` under the organization namespace. Use the
   returned callable and parameters, including a stable `idempotencyKey` when
   supported. Never assume a literal `home` namespace on Connect.
   Usually omit the delegate and let Home route. Resolve a requested tedi to
   its real ID through a bounded read, never from an email or display name.
2. Send only the authorized task and relevant context. State the expected
   result and any user limits in `content`. Preserve a selected conversation
   or an earlier dispatch receipt when continuing the same task. For a new
   task, use a stable task-scoped conversation ID when the discovered schema
   supports it; omission does not prove caller isolation. Do not reuse a shared
   conversation merely because another request returned it. Supply the exact
   verified `workspaceContext` when the task belongs to a Workspace; never
   inherit an unrelated Workspace as the destination. Use `home:main` only
   when explicitly requested. Reading status is not
   permission to dispatch, approve a plan, or send another message.
3. Record the returned run/conversation IDs and report queued/running status
   as such. Discover the run-status and event readers for that exact run;
   inspect their source/schema rather than guessing names from the router.
   The direct gateway uses `read_home_run` and `read_home_run_events`; Connect
   can expose `read_run` and `read_run_events`. Read bounded event pages and
   carry the returned
   cursor (`stream.nextOffset` on Home) into the next page; use supported
   bounded long polling when caught up. Do not replay the dispatch to poll or retry
   an ambiguous submission: inspect its receipt first.
4. Read the run's terminal status and result before reporting completion.
   A successful status read or completed transcript row does not prove a
   successful run. If the status reader is unavailable, discover the mapped
   `read_run_trace` reader: `trace.status` is the run outcome, while
   `trace.complete` describes trace assembly. Use transcript reads for the
   answer, not as a replacement for run status. An `observe_only` dispatch
   returns a routing observation; it does not prove an ordinary Home answer.
   Report the worker's result, evidence and remaining action. A dispatch
   receipt is not completion; a worker's success message is a claim. Read a
   named Work Item or Output revision when the outcome depends on it. A plan
   awaiting approval stays pending; use the discovered approval flow only
   when authorized and acting as its actual approver. Keep budget, provider,
   scope, and policy errors explicit rather than promising eventual success.

User OAuth lets the user request work from Tedix workers. It does not make
this chat that worker or grant an external coding harness an Attempt. Do not
create a local executor identity merely to delegate. For an existing local
Work execution request use `tedix-resume-work` instead.
