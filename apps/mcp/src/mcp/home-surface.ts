/**
 * First-class "home" namespace MCP tools (docs/product/tedix-os.md "Chat execution and MCP UI").
 *
 * These tools let an org aggregate MCP surface DRIVE that org's kernel and
 * converse with it directly — without borrowing a tedi identity. Unlike the
 * per-tedi `cto__read_home_messages`
 * proof bridges (built by `buildAggregateTediTools`), these are surfaced under a
 * dedicated `home` namespace (`ask`, `home__read_home_messages`, …)
 * so calling them never implies that CTO (or any named tedi) owns Home.
 *
 * Identity / audit model (docs/product/tedix-os.md):
 *  - Org-scoped, not modeled under a tedi. Every tool sets
 *    `allowExplicitTediId: false` and `includeTediIdParam: false`, and never
 *    injects a `tediId` static param.
 *  - The caller's org rides the `X-Tedix-Org-Id` header set in
 *    `handler.ts` (`ctx.callerIdentity?.organizationId ?? ctx.app?.organizationId`).
 *    The `kernelRuntime` procedures resolve org server-side via
 *    `resolveOrganizationId(context, input.organizationId)`, which enforces the
 *    caller's own org and rejects cross-org access. No `organizationId` input is
 *    advertised on these tools and no ORG_INJECT_ROUTERS entry is required —
 *    that allowlist only governs REST tools that embed `{organizationId}` in the
 *    path; these are rpc-transport tools that carry org on the header.
 *
 * All tools use `transport: "rpc"` against `kernelRuntime/<procedure>` and proxy
 * straight to apps/api, so they are runtime-agnostic (no container required).
 */

import type {
	ToolAnnotations,
	ToolInputJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import { EnqueueHomeMessageInputSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { PLATFORM_OPERATOR_APP_SLUG } from "./platform-operator-tools";
import type { AppTool } from "./server-context";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
const MUTATING: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
};
/**
 * Run-terminating writes (e.g. `cancel_home_run`) carry `destructiveHint:true`
 * so `requireDestructiveToolApproval` (governance.ts) trips the destructive
 * elicitation gate before the side effect runs. Without this tier the hint is
 * always unset and a cancel silently bypasses the approval gate.
 */
const DESTRUCTIVE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
};

/**
 * `ask` — drives the kernel (the one way in; there is no
 * alias). idempotencyKey is intentionally not advertised: LLM callers won't
 * supply a stable key, and `kernelRuntime.enqueueMessage` now defaults it
 * server-side.
 */
const ASK_HOME_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		...zodToToolInputJsonSchema(
			EnqueueHomeMessageInputSchema.pick({ workspaceContext: true }),
		).properties,
		content: {
			type: "string",
			minLength: 1,
			description:
				"The Home turn / message to send to the kernel (e.g. 'check my Gmail', 'review today's invoices').",
		},
		conversationId: {
			type: "string",
			description:
				"Home conversation to post into. OMIT to post into your own caller-scoped agent thread — that is the right default for probes, smoke tests, and any automated turn. When selecting workspaceContext, use a new conversation or one already associated with that Workspace; a conflicting Workspace is rejected. Pass 'home:main' ONLY when the operator explicitly asked you to write into their main Home thread: that is the transcript a human reads in Tedix OS, and validation traffic posted there is indistinguishable from the operator's own messages.",
		},
		delegateToTediId: {
			type: "string",
			description:
				"Optional: force delegation to a specific tedi instead of letting the kernel route. Usually omit — Home decides the route.",
		},
		verifyCommand: {
			type: "string",
			minLength: 1,
			maxLength: 500,
			description:
				"Optional, with delegateToTediId: an exact command the delegated tedi must run in its own environment and quote under `Verification output:` before it reports. Home treats a success report without that section as partial.",
		},
		metadata: {
			type: "object",
			additionalProperties: true,
			description:
				"Optional caller metadata to attach to the Home turn. Set correctionOf to a prior homeRunId when this turn explicitly corrects or re-routes that run.",
		},
		attachments: {
			type: "array",
			items: {
				type: "object",
				properties: {
					content: { type: "string", minLength: 1 },
					durationMs: {
						type: "number",
						minimum: 1,
						description: "Optional audio duration in milliseconds.",
					},
					fileName: { type: "string" },
					mimeType: { type: "string" },
					size: {
						type: "integer",
						minimum: 0,
						description: "Optional attachment size in bytes.",
					},
					type: { type: "string", enum: ["audio", "file", "image"] },
				},
				required: ["content", "fileName", "mimeType", "type"],
				additionalProperties: false,
			},
			maxItems: 8,
			description:
				"Optional base64 attachments. Audio attachments are voice notes: the kernel transcribes the first audio file before routing the turn.",
		},
	},
	required: ["content"],
	additionalProperties: false,
};

const SYNTHESIZE_SPOKEN_REPLY_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		text: {
			type: "string",
			minLength: 1,
			maxLength: 8192,
			description:
				"Assistant text to synthesize into a real spoken audio reply.",
		},
		voice: {
			type: "string",
			minLength: 1,
			maxLength: 128,
			description: "Optional provider voice name.",
		},
	},
	required: ["text"],
	additionalProperties: false,
};

const READ_HOME_MESSAGES_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: { type: "string", default: "home:main" },
		limit: { type: "integer", minimum: 1, maximum: 500 },
		cursor: { type: "string" },
	},
	additionalProperties: false,
};

const READ_HOME_RUN_SET_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: { type: "string", default: "home:main" },
		limit: { type: "integer", minimum: 1, maximum: 100 },
	},
	additionalProperties: false,
};

const READ_HOME_RUN_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
	},
	required: ["runId"],
	additionalProperties: false,
};

const READ_HOME_RUN_EVENTS_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: {
			type: "string",
			minLength: 1,
			description: "Home run id to stream events for.",
		},
		offset: {
			type: "integer",
			minimum: 0,
			description:
				"Resume from this run-local event index. Pass the stream.nextOffset returned by the previous call. Omit or pass 0 to read from the start.",
		},
		tail: {
			type: "integer",
			minimum: 1,
			description:
				"Read the last N events instead of paginating from offset. Mutually exclusive with offset.",
		},
		limit: {
			type: "integer",
			minimum: 1,
			description:
				"Maximum events in one offset page (default: the server page size). A run's events carry full payloads and a whole stream routinely exceeds the Code Mode result cap — page with a small limit and resume from stream.nextOffset rather than reading the stream in one call.",
		},
		childRunId: {
			type: "string",
			minLength: 1,
			description:
				"Optional. Scope the stream to a delegated child run's events instead of the parent Home run's own events. The parent runId still gates access.",
		},
		delegatedTediId: {
			type: "string",
			minLength: 1,
			description:
				"Optional. With childRunId, narrows child events to a specific delegated tedi when one child run id is reused across delegates.",
		},
		waitMs: {
			type: "integer",
			minimum: 0,
			maximum: 30000,
			description:
				"Long-poll budget. The read holds open for up to this many ms while the page is EMPTY and the stream is open, and returns as soon as an event lands. It never delays a page that already has events, so a client that is not caught up must still pace its own polls.",
		},
	},
	required: ["runId"],
	additionalProperties: false,
};

const READ_CHILD_RUN_EVIDENCE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		delegatedTediId: {
			type: "string",
			minLength: 1,
			description: "Tedi id that owns the delegated child run.",
		},
		childRunId: {
			type: "string",
			minLength: 1,
			description: "Delegated child run id recorded on the Home parent run.",
		},
		limit: { type: "integer", minimum: 1, maximum: 500 },
		artifactLimit: { type: "integer", minimum: 1, maximum: 100 },
	},
	required: ["delegatedTediId", "childRunId"],
	additionalProperties: false,
};

const READ_CHILD_RUN_TREE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: { type: "string", default: "home:main" },
		limit: { type: "integer", minimum: 1, maximum: 100 },
	},
	additionalProperties: false,
};

/**
 * Async canary input — a thin wrapper over the same conversation read as
 * read_home_run_set, exercised out-of-band so the `_asyncTask` gate
 * (tool-execution.ts) and the GenericTasksWorkflow execution path stay live.
 */
const ASYNC_CANARY_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: { type: "string", default: "home:main" },
		limit: { type: "integer", minimum: 1, maximum: 100 },
	},
	additionalProperties: false,
};

const LIST_HOME_CONVERSATIONS_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		limit: { type: "integer", minimum: 1, maximum: 500 },
		cursor: { type: "string" },
		search: { type: "string" },
		channel: { type: "string" },
		includeArchived: { type: "boolean" },
	},
	additionalProperties: false,
};

const RENAME_HOME_CONVERSATION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: {
			type: "string",
			description: "Home conversation id to rename.",
		},
		title: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "New operator-facing title for the conversation.",
		},
	},
	required: ["conversationId", "title"],
	additionalProperties: false,
};

const PIN_HOME_CONVERSATION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: {
			type: "string",
			description: "Home conversation id to pin or unpin.",
		},
		pinned: {
			type: "boolean",
			description: "true pins the conversation to the top; false unpins it.",
		},
	},
	required: ["conversationId", "pinned"],
	additionalProperties: false,
};

const DELETE_HOME_CONVERSATION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: {
			type: "string",
			description:
				"Home conversation id to permanently delete. The org's main Home thread cannot be deleted.",
		},
		reason: {
			type: "string",
			minLength: 1,
			maxLength: 2000,
			description: "Audit reason for permanently deleting this conversation.",
		},
		confirmDestructive: {
			type: "boolean",
			description:
				"Set true only when the operator explicitly requested permanent deletion. Required for stateless MCP clients.",
		},
	},
	required: ["conversationId", "reason", "confirmDestructive"],
	additionalProperties: false,
};

const ARCHIVE_HOME_CONVERSATION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		conversationId: {
			type: "string",
			description: "Home conversation id to archive or restore.",
		},
		archived: {
			type: "boolean",
			description: "true archives the conversation; false restores it.",
		},
	},
	required: ["conversationId", "archived"],
	additionalProperties: false,
};

const LIST_KERNEL_TRACE_BUNDLES_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: {
			type: "string",
			description: "Optional Home run id to filter to one kernel trace bundle.",
		},
		harnessVersionId: {
			type: "string",
			description:
				"Optional kernel harness version id to filter trace bundles.",
		},
		limit: { type: "integer", minimum: 1, maximum: 200 },
	},
	additionalProperties: false,
};

const READ_DELEGATED_TEDI_TRACES_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		// A REFERENCE to the delegated tedi (a Home run's delegatedTediId), not the
		// caller's identity: allowExplicitTediId stays false so a tedi caller is
		// force-scoped to itself, while a human operator's reference passes through
		// to harness/listTraceBundles, which authorizes it via requireTediAccess.
		tediId: {
			type: "string",
			description:
				"The delegated tedi's id (from a Home run's delegatedTediId).",
		},
		runId: {
			type: "string",
			description:
				"Optional child run id (a Home run's childRunId) to filter to that delegated turn's bundle.",
		},
		harnessVersionId: {
			type: "string",
			description: "Optional harness version id to filter trace bundles.",
		},
		limit: { type: "integer", minimum: 1, maximum: 200 },
	},
	required: ["tediId"],
	additionalProperties: false,
};

const APPROVE_HOME_PLAN_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		assignmentIds: {
			type: "array",
			items: { type: "string" },
		},
		dispatch: { type: "boolean" },
		approvalNote: { type: "string", maxLength: 2000 },
	},
	required: ["runId"],
	additionalProperties: false,
};

const RESPOND_HOME_APPROVAL_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		decision: {
			type: "string",
			enum: ["approve", "reject"],
			description:
				"approve executes/dispatches what the run is waiting on; reject cancels it without executing.",
		},
		assignmentIds: {
			type: "array",
			items: { type: "string" },
			description:
				"Plan proposals only: optional subset of plan assignment ids. Omit to act on all proposed assignments.",
		},
		note: { type: "string", maxLength: 2000 },
	},
	required: ["runId", "decision"],
	additionalProperties: false,
};

const CANCEL_HOME_RUN_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		reason: { type: "string", minLength: 1, maxLength: 2000 },
		confirmDestructive: {
			type: "boolean",
			description:
				"Set true only when the operator explicitly requested this cancellation. Enables an auditable one-round confirmation for stateless MCP clients.",
		},
	},
	required: ["runId", "reason", "confirmDestructive"],
	additionalProperties: false,
};

const STEER_HOME_RUN_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		runId: { type: "string", minLength: 1 },
		instruction: {
			type: "string",
			minLength: 1,
			maxLength: 4000,
			description:
				"Operator steering instruction to attach to the active Home run/work card.",
		},
	},
	required: ["runId", "instruction"],
	additionalProperties: false,
};

const RETRY_DELEGATION_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		workItemId: { type: "string", minLength: 1 },
	},
	required: ["workItemId"],
	additionalProperties: false,
};

const CREATE_WORK_ITEM_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.create),
);
const UPDATE_WORK_ITEM_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.updateSpecification),
);
const CANCEL_WORK_ITEM_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.cancel),
);
const ACCEPT_WORK_ITEM_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.accept),
);
const COMPLETE_WORK_ITEM_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(workItemsContract.complete),
);

type HomeSurfaceToolSpec = {
	/** Bare Code Mode name. `ask` is also the sole direct Home tool. */
	name: string;
	description: string;
	inputSchema: ToolInputJsonSchema;
	annotations: ToolAnnotations;
	/** oRPC endpoint string, e.g. "kernelRuntime/enqueueMessage". */
	rpcEndpoint: string;
	/**
	 * MCP tasks extension (io.modelcontextprotocol/tasks) linkage: tools that
	 * enqueue a Home run set this so the result payload carries
	 * `task: { id: homeRunId, pollWith: "tasks/get" }` (injected by
	 * handler.ts on `_emitTaskLinkage`). Callers that hit short client
	 * timeouts recover the outcome by polling `tasks/get` with that id —
	 * served by `home-task-handlers.ts`.
	 */
	emitTaskLinkage?: boolean;
	/**
	 * Generic async task (io.modelcontextprotocol/tasks): when the caller opts
	 * into the tasks extension, this tool runs out-of-band via the
	 * GenericTasksWorkflow against the durable `mcp_tasks` store
	 * (tool-execution.ts `_asyncTask` gate) instead of synchronously. The
	 * workflow dispatches the snapshotted rpc endpoint and writes the terminal
	 * result. Used by the async canary to keep the gate + workflow path live.
	 */
	asyncTask?: boolean;
};

const HOME_SURFACE_NAMESPACE = "home";

const HOME_CONVERSATION_LIFECYCLE_ENDPOINTS = new Set([
	"kernelRuntime/listConversations",
	"kernelRuntime/renameConversation",
	"kernelRuntime/pinConversation",
	"kernelRuntime/archiveConversation",
	"kernelRuntime/deleteConversation",
]);

/**
 * The app-tool projection derives a public namespace from an RPC endpoint's
 * router root, so kernelRuntime conversation rows otherwise appear as
 * `kernel.*` beside the first-class `home.*` contract. On surfaces that mount
 * Home, remove only those duplicate lifecycle rows. Internal oRPC callers and
 * unrelated kernel diagnostics keep their canonical kernelRuntime endpoints.
 */
export function removeProjectedKernelConversationLifecycleTools(
	tools: AppTool[],
): AppTool[] {
	return tools.filter((tool) => {
		const endpoint = tool.config?.endpoint;
		return (
			typeof endpoint !== "string" ||
			!HOME_CONVERSATION_LIFECYCLE_ENDPOINTS.has(endpoint)
		);
	});
}

const HOME_SURFACE_TOOL_SPECS: HomeSurfaceToolSpec[] = [
	{
		name: "ask",
		description:
			"Delegate a task to your organization, collaborate with or hand off work to another tedi (a teammate worker / agent), or message Home to act on your behalf — this is the primary way to reach and coordinate other tedis. Drive the kernel: submit a Home turn for the caller's organization and get back the typed route decision (run.metadata.kernelRoute: routeKind + rationale) and the kernel's answer (assistantMessage.content). You do NOT choose a tedi — Home assembles tenant context, decides a route (answer_in_home / propose_tool_write / delegate_tedi / suggest_handoff / run_workflow / ask_human), and either answers, drafts a confirmation, or delegates. Returns the parent homeRunId on run.id, echoed as task.id for the MCP tasks extension (io.modelcontextprotocol/tasks): long turns can outlive short client timeouts — poll tasks/get with task.id (or call read_home_run) to retrieve the outcome. idempotencyKey is generated server-side. This creates a turn — not read-only.",
		inputSchema: ASK_HOME_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/enqueueMessage",
		emitTaskLinkage: true,
	},
	{
		name: "read_home_messages",
		description:
			"Read the tenant Home transcript (plan, approval, and async delegation proof) for the caller's organization. Reads still default to the operator's main thread ('home:main') — deliberately NOT symmetric with ask, whose omitted conversationId is caller-scoped. To read back a turn you just posted, pass the conversationId that ask returned.",
		inputSchema: READ_HOME_MESSAGES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readMessages",
	},
	{
		name: "synthesize_spoken_reply",
		description:
			"Synthesize Home/kernel assistant text into a real speech audio attachment payload. Use this for voice-message validation instead of beep or tone fixtures.",
		inputSchema: SYNTHESIZE_SPOKEN_REPLY_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "voice/synthesizeSpokenReply",
	},
	{
		name: "read_home_run_set",
		description:
			"Read Home's durable run set — plan metadata, delegated child links, progress, and active run ids — for the caller's organization.",
		inputSchema: READ_HOME_RUN_SET_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRunSet",
	},
	{
		name: "async_canary",
		description:
			"Generic-async canary (io.modelcontextprotocol/tasks). When the caller opts into the tasks extension, this runs out-of-band via the GenericTasksWorkflow: it returns a `generic-<uuid>` task immediately, dispatches a Home run-set read in the background, and writes the terminal result to the durable mcp_tasks store. Poll tasks/get to retrieve it. Keeps the async task lifecycle (gate → workflow → terminal) reachable in production.",
		inputSchema: ASYNC_CANARY_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRunSet",
		asyncTask: true,
	},
	{
		name: "read_home_run",
		description:
			"Inspect one parent Home run by runId: status, typed route, route branches, child-run links, progress, and evidence.",
		inputSchema: READ_HOME_RUN_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRun",
	},
	{
		name: "read_home_trace",
		description:
			"Read one converged multi-tedi evidence graph for a Home run. Joins the parent Kernel trace anchor with delegated tedi event ids, tool/workstation event ids, artifacts, wake receipts, and final synthesis while leaving payloads in their canonical ledgers. Inspect gaps and complete before claiming end-to-end proof.",
		inputSchema: READ_HOME_RUN_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRunTrace",
	},
	{
		name: "read_home_run_events",
		description:
			"Incrementally tail a Home run's durable event stream by run-local offset. Returns events[], stream.nextOffset (pass as offset on the next call to resume), and stream.closed (true when the run has reached a terminal event). Use offset=0 or omit to start from the beginning; use tail=N to read the last N events; use limit to bound one page. Pass childRunId to tail a delegated child run's events instead. Designed for terminal CLI polling: call repeatedly with the returned nextOffset until a page comes back EMPTY and stream.closed is true. stream.closed is computed from the run's terminal receipt, not from this page, so it can be true while later offsets still hold events — drain to an empty page before treating the stream as finished.",
		inputSchema: READ_HOME_RUN_EVENTS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readRunEvents",
	},
	{
		name: "read_child_run_evidence",
		description:
			"Read delegated child-run evidence for a Home parent: child runtime events, artifacts, terminal status, preview, and stop-control state. Use this from terminal clients after read_home_run or read_home_run_set exposes delegatedTediId and childRunId.",
		inputSchema: READ_CHILD_RUN_EVIDENCE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readChildRunEvidence",
	},
	{
		name: "read_child_run_tree",
		description:
			"Read the read-only delegated child-run hierarchy for one Home conversation. Use this to see parent Home runs, delegated tedi ids, child run ids, active nodes, and child statuses from CLI or Tedix OS without binding the caller to a child runtime.",
		inputSchema: READ_CHILD_RUN_TREE_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/readChildRunTree",
	},
	{
		name: "list_conversations",
		description:
			"List the caller organization's Home conversations (the tenant operating threads), with optional search/channel filters.",
		inputSchema: LIST_HOME_CONVERSATIONS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "kernelRuntime/listConversations",
	},
	{
		name: "rename_conversation",
		description:
			"Set the operator-facing title of a Home conversation (shows in Tedix OS and CLI session lists).",
		inputSchema: RENAME_HOME_CONVERSATION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/renameConversation",
	},
	{
		name: "pin_conversation",
		description:
			"Pin or unpin a Home conversation. Pins are org-durable and shared across every surface (Tedix OS + CLI) — pinned conversations sort to the top of session lists.",
		inputSchema: PIN_HOME_CONVERSATION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/pinConversation",
	},
	{
		name: "archive_conversation",
		description:
			"Archive or restore a Home conversation without deleting its runtime ledger. Archived conversations are hidden from ordinary lists; pass archived=false to restore one.",
		inputSchema: ARCHIVE_HOME_CONVERSATION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/archiveConversation",
	},
	{
		name: "delete_conversation",
		description:
			"Permanently delete a Home conversation and its conversation-owned runtime content. Active parent and delegated child runs are canceled first; accepted Work Items and child-tedi ledgers remain. A content-free tombstone prevents late events from reviving the conversation. The org's main Home thread cannot be deleted.",
		inputSchema: DELETE_HOME_CONVERSATION_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "kernelRuntime/deleteConversation",
	},
	{
		name: "list_kernel_trace_bundles",
		description:
			"List the caller organization's Home Kernel harness trace bundles, newest first. Use this to inspect the subject-keyed evidence that a Home run wrote without borrowing any tedi identity; optionally filter by runId or harnessVersionId.",
		inputSchema: LIST_KERNEL_TRACE_BUNDLES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "harness/listKernelTraceBundles",
	},
	{
		name: "read_delegated_tedi_traces",
		description:
			"Read a delegated tedi's OWN harness trace bundles for a Home delegation — the tedi-side half of the chain the kernel bundles don't carry (per-step token usage, rationale/artifact ids, bundleUri). Pass the Home run's delegatedTediId as tediId and its childRunId as runId to pull exactly that delegated turn's bundle. Org-guarded to tedis the caller can access.",
		inputSchema: READ_DELEGATED_TEDI_TRACES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "harness/listTraceBundles",
	},
	{
		name: "approve_home_plan",
		description:
			"Approve proposed Home plan assignments, promote them into Work Items, and optionally dispatch child runs.",
		inputSchema: APPROVE_HOME_PLAN_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/approvePlanAssignments",
	},
	{
		name: "respond_home_approval",
		description:
			"Approve or reject what a Home run is waiting on — write-action cards, delegation approvals, workstation attachments, and plan proposals. The target resolves from the run itself: a parked mutating-tool approval card (decision approve executes the server-stored call exactly once; reject cancels the run without executing), a Home delegation recommendation or workstation attachment work order (approve dispatches the certified work order; reject cancels it), or proposed plan assignments (approve promotes them into Work Items and dispatches; reject cancels them, optionally scoped to assignmentIds). A delegation hold routed to the org's designated approval tedi (run metadata homeDelegation.agentReview.status pending) is decided by that tedi through the Work approval plane: approve returns CONFLICT until it declines or the review expires, while reject still withdraws the delegation. Only an active org owner or admin may resolve a delegation here, and tedis never can. This is THE Home approval surface — never pass a raw approval UUID, always the runId.",
		inputSchema: RESPOND_HOME_APPROVAL_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/respondApproval",
	},
	{
		name: "cancel_home_run",
		description:
			"Stop a parent Home run by runId without killing the whole Home conversation. Records a cancellation event and optional reason.",
		inputSchema: CANCEL_HOME_RUN_SCHEMA,
		annotations: DESTRUCTIVE,
		rpcEndpoint: "kernelRuntime/cancelRun",
	},
	{
		name: "steer_home_run",
		description:
			"Attach an operator steering instruction to an active parent Home run/work card without canceling the conversation. The instruction is persisted to the Home transcript and run metadata so read_home_run/read_home_messages can prove it.",
		inputSchema: STEER_HOME_RUN_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/steerRun",
	},
	{
		name: "retry_delegation",
		description:
			"Recover a proof-gate BLOCKED delegation Work Item: operator-gated re-dispatch, bounded by MAX_DELEGATION_RETRIES.",
		inputSchema: RETRY_DELEGATION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "kernelRuntime/retryDelegation",
	},
	{
		name: "create_work_item",
		description:
			"Create an artifact-neutral Work Item specification. Execution and acceptance are separate attempt and evidence lifecycles.",
		inputSchema: CREATE_WORK_ITEM_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/create",
	},
	{
		name: "update_work_item",
		description:
			"Update descriptive Work Item specification fields. Disposition, readiness, attempts, and evidence use dedicated lifecycle operations.",
		inputSchema: UPDATE_WORK_ITEM_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/updateSpecification",
	},
	{
		name: "accept_work_item",
		description:
			"Accept a proposed Work Item with an explicit acceptance contract. This does not start an attempt.",
		inputSchema: ACCEPT_WORK_ITEM_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/accept",
	},
	{
		name: "complete_work_item",
		description:
			"Complete an accepted Work Item once its Attempt has settled. Settled means done: no evidence count or review stands in front of completion.",
		inputSchema: COMPLETE_WORK_ITEM_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/complete",
	},
	{
		name: "cancel_work_item",
		description:
			"Cancel a single Work Item specification while preserving immutable attempt and evidence history.",
		inputSchema: CANCEL_WORK_ITEM_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "workItems/cancel",
	},
];

function buildHomeSurfaceTool(spec: HomeSurfaceToolSpec): AppTool {
	const toolId =
		spec.name === "ask" ? "ask" : `${HOME_SURFACE_NAMESPACE}__${spec.name}`;
	return {
		id: `home:${spec.name}`,
		toolId,
		title: toolId,
		description: spec.description,
		toolTypeId: "rpc",
		inputSchema: spec.inputSchema,
		outputSchema: null,
		config: {
			transport: "rpc",
			endpoint: spec.rpcEndpoint,
			method: "POST",
			// Home is not a tedi: never accept or inject a tedi identity. The
			// caller's org is carried on the X-Tedix-Org-Id header (handler.ts)
			// and resolved server-side by resolveOrganizationId.
			allowExplicitTediId: false,
			// allowExplicitAppId:true mirrors the per-tedi home tools — with no
			// appId in the (closed) input schema, enforceContextParams leaves
			// params.appId undefined rather than injecting the tedix-unified app
			// id, which the kernelRuntime procedures do not accept.
			allowExplicitAppId: true,
			...(spec.name === "synthesize_spoken_reply"
				? { staticParams: { subject: { type: "kernel" } } }
				: {}),
			// Forward the authenticated caller's auth to apps/api so the Home
			// kernel runs under the user's speaker authority (docs/product/tedix-os.md).
			// The operator surface is public-auth; this opt-in flag forwards only an
			// already-authenticated oauth/user caller, with no escalation.
			// Detached generic tasks cannot replay a live bearer credential. Async
			// Home tools instead use the Workflow's bounded service-binding identity
			// and code-owned endpoint scope map; keeping both flags would make the
			// safety guard run the tool synchronously and defeat Tasks entirely.
			...(spec.asyncTask ? {} : { _forwardCallerAuth: true }),
			_aggregateNamespace: HOME_SURFACE_NAMESPACE,
			// MCP tasks extension: enqueue tools surface task.id = homeRunId in
			// their result so callers can poll tasks/get past client timeouts.
			...(spec.emitTaskLinkage ? { _emitTaskLinkage: true } : {}),
			// Generic async task: opt this tool into out-of-band execution via the
			// GenericTasksWorkflow (tool-execution.ts `_asyncTask` gate).
			...(spec.asyncTask ? { _asyncTask: true } : {}),
		},
		annotations: spec.annotations,
		meta: { source: "homeSurface", namespace: HOME_SURFACE_NAMESPACE },
		icons: null,
		executionTaskSupport: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: "json-schema-2020-12",
		schemaSource: "manual",
		schemaSourceRef: spec.rpcEndpoint,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
	};
}

/**
 * Home belongs on org aggregate surfaces: `tedix-unified` for platform
 * operators, and tenant-owned aggregators such as `acme-unified`.
 * Single-purpose MCP apps stay focused on their provider tools.
 */
export function shouldExposeHomeSurface(args: {
	appSlug: string;
	metadata?: unknown;
}): boolean {
	if (args.appSlug === PLATFORM_OPERATOR_APP_SLUG) return true;
	const metadata = isRecord(args.metadata) ? args.metadata : {};
	const mcpConfig = isRecord(metadata.mcpConfig) ? metadata.mcpConfig : {};
	const aggregateApps = mcpConfig.aggregateApps;
	const aggregateTedis = mcpConfig.aggregateTedis;
	return (
		(Array.isArray(aggregateApps) && aggregateApps.length > 0) ||
		(Array.isArray(aggregateTedis) && aggregateTedis.length > 0)
	);
}

export function buildHomeSurfaceTools(): AppTool[] {
	return HOME_SURFACE_TOOL_SPECS.map(buildHomeSurfaceTool);
}

/**
 * Honest ack text for the kernel-turn soft-deadline shape (presentation
 * layer only).
 *
 * Since the soft deadline shipped, `kernelRuntime/enqueueMessage` can return an
 * ACK instead of an answer: top-level `status: "queued"`, `run.status:
 * "running"`, and NO `assistantMessage` — the kernel do keeps running
 * the turn and later writes the real `${runId}:assistant` ledger message.
 * Without this, MCP callers of `ask` get bare JSON with no
 * human-readable text.
 *
 * We deliberately do not fabricate a ledger-shaped assistantMessage (the do
 * owns that message id); instead `tool-execution.ts` prepends this text as an
 * extra content block on the TOOL RESULT for `_emitTaskLinkage` tools. Every
 * other shape returns null so fast-turn output stays byte-identical.
 */
export function homeQueuedAckText(data: unknown): string | null {
	if (!isRecord(data)) return null;
	// A real kernel answer exists — nothing to synthesize.
	if (data.assistantMessage != null) return null;
	const run = data.run;
	if (!isRecord(run)) return null;
	const runId = typeof run.id === "string" ? run.id : "";
	if (!runId) return null;
	const isQueuedAck = data.status === "queued" || run.status === "running";
	if (!isQueuedAck) return null;
	return `Working on it — this turn continues in the background. Poll tasks/get with task id ${runId} or read_home_run for the result; the Home transcript receives the answer when ready.`;
}
