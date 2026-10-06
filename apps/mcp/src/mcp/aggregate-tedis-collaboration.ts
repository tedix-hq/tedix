// Collaboration-surface tool specs (ask/messaging/learning/memory reads)
// plus the session messaging, approvals, and cron specs shared with the
// full surface.
import { learningFeedbackContract } from "@tedix/api-contract/contracts/learning-feedback";
import {
	AnalyzeRecurringLearningIssuesInputSchema,
	ListLearningImprovementProposalsInputSchema,
	ListLearningInteractionsInputSchema,
	RecordLearningInteractionInputSchema,
} from "@tedix/api-contract/schemas/learning-feedback";
import type { ToolInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	MEMORY_SEARCH_SCHEMA,
	RECORD_ENTITY_MENTION_SCHEMA,
	RATIONALE_CHAIN_LAYOUT_SPEC,
	RATIONALE_CHAIN_SCHEMA,
	REVIEW_MEMORY_FACT_SCHEMA,
} from "./aggregate-tedis-memory";
import {
	MAIN_SESSION_KEY,
	MUTATING,
	READ_ONLY,
	type TediToolSpec,
} from "./aggregate-tedis-shared";
import {
	LIST_SKILLS_SCHEMA,
	READ_RESOURCE_SCHEMA,
	READ_SKILL_SCHEMA,
} from "./aggregate-tedis-skill-workflows";

const EMPTY_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const RECORD_LEARNING_INTERACTION_SCHEMA = zodToToolInputJsonSchema(
	RecordLearningInteractionInputSchema.omit({ tediId: true }),
);
const LIST_LEARNING_INTERACTIONS_SCHEMA = zodToToolInputJsonSchema(
	ListLearningInteractionsInputSchema.omit({ tediId: true }),
);
const ATTRIBUTE_LEARNING_FEEDBACK_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(learningFeedbackContract.attributeFeedback),
);
const RECORD_LEARNING_MEASUREMENT_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(learningFeedbackContract.recordMeasurement),
);
const GET_LEARNING_FEEDBACK_SUMMARY_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(learningFeedbackContract.getSummary),
);
const ANALYZE_RECURRING_LEARNING_ISSUES_SCHEMA = zodToToolInputJsonSchema(
	AnalyzeRecurringLearningIssuesInputSchema.omit({
		tediId: true,
	}),
);
const PROPOSE_LEARNING_IMPROVEMENT_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(learningFeedbackContract.proposeImprovement),
);
const LIST_LEARNING_IMPROVEMENTS_SCHEMA = zodToToolInputJsonSchema(
	ListLearningImprovementProposalsInputSchema.omit({
		tediId: true,
	}),
);
const EVALUATE_LEARNING_IMPROVEMENT_SCHEMA = zodToToolInputJsonSchema(
	procedureInputSchema(learningFeedbackContract.evaluateImprovement),
);

const ASK_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		message: {
			type: "string",
			description: "Message to send to the tedi's main agent session.",
		},
	},
	required: ["message"],
	additionalProperties: false,
};

export const CONVERSATIONS_LIST_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		limit: { type: "number" },
		search: { type: "string" },
		channel: { type: "string" },
		includeDerivedTitles: { type: "boolean" },
		includeLastMessage: { type: "boolean" },
	},
	additionalProperties: false,
};

const SESSION_READ_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		session_key: { type: "string" },
		limit: { type: "number" },
	},
	required: ["session_key"],
	additionalProperties: false,
};

const MESSAGE_ATTACHMENT_SCHEMA: ToolInputJsonSchema = {
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
};

const MESSAGES_SEND_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		session_key: { type: "string" },
		text: { type: "string" },
		client_request_id: { type: "string" },
		attachments: {
			type: "array",
			items: MESSAGE_ATTACHMENT_SCHEMA,
			maxItems: 8,
		},
	},
	required: ["session_key"],
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

const EVENTS_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		after_cursor: { type: "number" },
		session_key: { type: "string" },
		limit: { type: "number" },
		timeout_ms: { type: "number" },
	},
	additionalProperties: false,
};

const EXECUTE_SCHEMA: ToolInputJsonSchema = {
	type: "object",
	properties: {
		code: {
			type: "string",
			description:
				"JavaScript async arrow function to run in this tedi's network-isolated JavaScript sandbox, e.g. `async () => { await state.writeFile({ path: '/out.txt', content: 'hi' }); return await state.readFile({ path: '/out.txt' }); }`. `state.*` is wired to the tedi's durable workspace; there is no network.",
		},
	},
	required: ["code"],
	additionalProperties: false,
};

export const COLLABORATION_TOOLS: TediToolSpec[] = [
	{
		name: "ask",
		remoteName: "run_tedi_turn",
		// Chat turns already have a durable execution boundary in AgentTediDO.
		// Calling them through the request-scoped `code` wrapper keeps a
		// DynamicWorkerExecutor and the full inner-tool catalog resident while the
		// turn runs, which can exhaust the do's isolate memory. Use the directly
		// registered platform tool and preserve the same task/result contract.
		directMcpTool: true,
		description: "Send a message to this tedi's main agent session.",
		inputSchema: ASK_SCHEMA,
		annotations: MUTATING,
		paramMap: { message: "text" },
		staticParams: { session_key: MAIN_SESSION_KEY },
	},
	{
		// Agent runtime only: `execute` runs in the AgentTediDO's WorkerLoader isolate
		// over its durable DO-SQLite workspace. Advertise it for `agent` bodies only.
		name: "execute",
		remoteName: "execute",
		runtimeKinds: ["agent"],
		// `execute` is a top-level tool on the tedi's /mcp server (registered via
		// codeModeExtras on the outer server). Route it as a direct callTool, not
		// wrapped through the tedi's `code` tool (where only inner tools exist).
		directMcpTool: true,
		description:
			"Run model-authored JavaScript in this tedi's network-isolated JavaScript sandbox (Cloudflare WorkerLoader), with `state.*` wired to its durable DO-SQLite workspace (readFile/writeFile/glob/diff/replaceInFiles/applyEdits). No network. HIGH-risk producer gate: if the tedi's coding session isn't pre-authorized this PARKS and returns `requires_approval` + an `execution_id` (an approval card lands in the kernel ledger); once an operator approves, re-issue the same call and it runs inline, returning `{ executionId, result, logs? }`.",
		inputSchema: EXECUTE_SCHEMA,
		annotations: MUTATING,
	},
	{
		name: "conversations_list",
		remoteName: "conversations_list",
		description:
			"List this tedi's cognitive-runtime conversations and agent sessions.",
		inputSchema: CONVERSATIONS_LIST_SCHEMA,
		annotations: READ_ONLY,
	},
	{
		name: "messages_read",
		remoteName: "messages_read",
		description: "Read recent messages from one of this tedi's sessions.",
		inputSchema: SESSION_READ_SCHEMA,
		annotations: READ_ONLY,
	},
	{
		name: "synthesize_spoken_reply",
		remoteName: "synthesize_spoken_reply",
		description:
			"Synthesize this tedi's assistant text into a real speech audio attachment payload. Use this for voice-message validation instead of beep or tone fixtures.",
		inputSchema: SYNTHESIZE_SPOKEN_REPLY_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "voice/synthesizeSpokenReply",
		voiceSubject: "aggregateTedi",
	},
	{
		name: "record_learning_interaction",
		remoteName: "record_learning_interaction",
		description:
			"Record an idempotent accepted, edited, ignored, rejected, retried, undone, manually replaced, or completed-elsewhere product interaction for this tedi.",
		inputSchema: RECORD_LEARNING_INTERACTION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "learningFeedback/recordInteraction",
		allowExplicitTediId: false,
	},
	{
		name: "list_learning_interactions",
		remoteName: "list_learning_interactions",
		description:
			"List this tedi's scoped product-interaction learning signals by kind, issue, scope, or time window.",
		inputSchema: LIST_LEARNING_INTERACTIONS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "learningFeedback/listInteractions",
		allowExplicitTediId: false,
	},
	{
		name: "attribute_learning_feedback",
		remoteName: "attribute_learning_feedback",
		description:
			"Link learning interaction events to a proposed, evaluated, promoted, rejected, or rolled-back memory, directive, skill, harness, or workflow change.",
		inputSchema: ATTRIBUTE_LEARNING_FEEDBACK_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "learningFeedback/attributeFeedback",
		includeTediIdParam: false,
	},
	{
		name: "record_learning_measurement",
		remoteName: "record_learning_measurement",
		description:
			"Record an idempotent baseline or follow-up opportunity/recurrence measurement for an attributed learning change.",
		inputSchema: RECORD_LEARNING_MEASUREMENT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "learningFeedback/recordMeasurement",
		includeTediIdParam: false,
	},
	{
		name: "get_learning_feedback_summary",
		remoteName: "get_learning_feedback_summary",
		description:
			"Read attributed feedback and compare baseline versus follow-up recurrence rates for a learning change.",
		inputSchema: GET_LEARNING_FEEDBACK_SUMMARY_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "learningFeedback/getSummary",
		includeTediIdParam: false,
	},
	{
		name: "analyze_recurring_learning_issues",
		remoteName: "analyze_recurring_learning_issues",
		description:
			"Group this tedi's repeated negative interaction signals into evidence-linked improvement candidates; three distinct occurrences are required by default.",
		inputSchema: ANALYZE_RECURRING_LEARNING_ISSUES_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "learningFeedback/analyzeRecurringIssues",
		allowExplicitTediId: false,
	},
	{
		name: "propose_learning_improvement",
		remoteName: "propose_learning_improvement",
		description:
			"Create an idempotent governed improvement proposal from at least three recurring negative evidence events. This never promotes the target subject.",
		inputSchema: PROPOSE_LEARNING_IMPROVEMENT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "learningFeedback/proposeImprovement",
		includeTediIdParam: false,
	},
	{
		name: "list_learning_improvements",
		remoteName: "list_learning_improvements",
		description:
			"Read this tedi's governed learning proposals, pinned measurement pair, and human handoff disposition.",
		inputSchema: LIST_LEARNING_IMPROVEMENTS_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "learningFeedback/listImprovements",
		allowExplicitTediId: false,
	},
	{
		name: "evaluate_learning_improvement",
		remoteName: "evaluate_learning_improvement",
		description:
			"Evaluate a proposal against exact baseline/follow-up measurements from one attributed, chronological cohort. Only measured improvement becomes ready for human handoff review; downstream certification remains mandatory.",
		inputSchema: EVALUATE_LEARNING_IMPROVEMENT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "learningFeedback/evaluateImprovement",
		includeTediIdParam: false,
	},
	{
		// Entity extraction producer surface: a workflow's deterministic half
		// persists what a tedi judgment turn named. Mentions are immutable
		// extraction evidence — linking one to an entity is a separate reviewed
		// resolution, so recording is safe to automate while linking is not.
		name: "record_entity_mention",
		remoteName: "record_entity_mention",
		description:
			"Record one immutable entity mention: surface form, normalized form, proposed type, confidence, extractor identity, and the source uri/hash it came from. Extraction evidence only — recording a mention never links it to an entity, which requires a separately reviewed resolution decision.",
		inputSchema: RECORD_ENTITY_MENTION_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "memoryEntities/recordMention",
		includeTediIdParam: false,
	},
	{
		// Body-neutral read: routed through apps/api `memoryGraph/search` →
		// canonical D1/Neo4j, not a runtime-local plugin. The selected
		// tedi's id is injected as `tediId` (staticParams) so search is
		// tedi-scoped + visibility-filtered. Advertises on every current runtime.
		name: "memory_search",
		remoteName: "memory_search",
		description: "Search this tedi's memory facts.",
		inputSchema: MEMORY_SEARCH_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "memoryGraph/search",
	},
	{
		// Body-neutral read: routed through apps/api `memoryGraph/health`. Health
		// is org/graph-scoped (no tediId input), so suppress tediId injection.
		name: "memory_health",
		remoteName: "memory_health",
		description: "Inspect this tedi's memory system health.",
		inputSchema: EMPTY_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "memoryGraph/health",
		includeTediIdParam: false,
	},
	{
		// Body-neutral write: routed through apps/api `memoryGraph/review`.
		// The selected tedi id is injected as review provenance, while the API
		// enforces the fact's org ownership before mutating lifecycle fields.
		name: "review_memory_fact",
		remoteName: "review_memory_fact",
		description:
			"Review, reject, supersede, or archive one of this tedi org's memory facts through the canonical lifecycle fields.",
		inputSchema: REVIEW_MEMORY_FACT_SCHEMA,
		annotations: MUTATING,
		rpcEndpoint: "memoryGraph/review",
		allowExplicitTediId: false,
	},
	{
		// Body-neutral read: routed through apps/api `rationaleRecords/chain` →
		// canonical D1 decision journal (org-scoped via orgScopeForRead). The
		// selected tedi's id is injected as `tediId` (staticParams) and required
		// by the contract. Advertises on every current runtime.
		name: "get_rationale_chain",
		remoteName: "get_rationale_chain",
		description: "Read this tedi's rationale chain.",
		inputSchema: RATIONALE_CHAIN_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "rationaleRecords/chain",
		layoutId: "rationale-chain",
		layoutSpec: RATIONALE_CHAIN_LAYOUT_SPEC,
		widgetDescription:
			"Recent rationale records for this tedi, including category, confidence, and outcomes.",
	},
	{
		name: "get_tedi_runtime_status",
		remoteName: "get_tedi_runtime_status",
		description:
			"Read canonical Tedix runtime status for this tedi, independent of runtime implementation.",
		inputSchema: EMPTY_SCHEMA,
		annotations: READ_ONLY,
		rpcEndpoint: "cognitiveRuntime/getStatus",
	},
];

export const MESSAGING_TOOLS: TediToolSpec[] = [
	{
		name: "run_tedi_turn",
		remoteName: "run_tedi_turn",
		// `run_tedi_turn` is registered directly on the outer per-tedi MCP server.
		// Its durable turn must not be nested inside stateless Code Mode: that
		// duplicates the tool catalog and WorkerLoader executor for the lifetime of
		// the turn and has caused production do memory resets across every role.
		directMcpTool: true,
		description:
			"Start a durable tedi turn with a message or voice attachment. Returns a task or pending run receipt; use messages_read for its reply and reuse client_request_id on retries.",
		inputSchema: MESSAGES_SEND_SCHEMA,
		annotations: MUTATING,
	},
	{
		name: "cron",
		remoteName: "cron",
		description:
			"Manage this tedi's cron jobs through the Agent runtime durable scheduler.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string" },
				includeDisabled: { type: "boolean" },
				job: { type: "object", additionalProperties: true },
				jobId: { type: "string" },
				id: { type: "string" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
];
