import {
	ListWorkCliProjectionInputSchema,
	ListWorkCliProjectionResultSchema,
	WorkCheckpointProjectionInputSchema,
	WorkCheckpointProjectionSchema,
	WorkCliLedgerInputSchema,
	WorkCliEventInputSchema,
	ListWorkAttemptCliProjectionResultSchema,
	ListWorkEvidenceCliProjectionResultSchema,
	ListWorkEventCliProjectionResultSchema,
} from "@tedix/api-contract/schemas/work-items";
import {
	ListWorkInteractionCliInboxInputSchema,
	ListWorkInteractionCliInboxResultSchema,
} from "@tedix/api-contract/schemas/work-interactions";
import {
	TriageAgentTurnInputSchema,
	TriageResultSchema,
	LabelAgentReplyInputSchema,
	LabelAgentReplyResultSchema,
	RequestAgentReplyDraftInputSchema,
	RequestAgentReplyDraftResultSchema,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import {
	McpNativeBootstrapSchema,
	McpNativeDescriptorSchema,
} from "@tedix/api-contract/schemas/mcp-native-transport";
import * as z from "zod";
import { errorText } from "./format";
import { NATIVE_DESCRIPTOR_CACHE_TTL_MS } from "./native-bootstrap-cache";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { NativeToolContext } from "./work";
import type { BoardError, BoardResult } from "./work-identity";

/**
 * Detect an error envelope returned (not thrown) through native transport.
 *
 * Two distinct shapes reach here and BOTH must be caught, because a board list
 * that misses one renders it as an empty board — the caller then concludes there
 * is no work when the truth is "your arguments were rejected":
 *
 * 1. The oRPC contract error: a top-level string `code` plus (`defined` or a
 *    4xx/5xx `status`). A successful board payload never carries a string `code`.
 * 2. The MCP gateway's own rejection envelope, `{ ok: false, error: "<text>" }`,
 *    which is what an input-validation failure actually looks like. It carries no
 *    `code`, no `status` and no `defined`, so shape 1 cannot see it; without
 *    this, an over-limit `--limit` or an unknown project prints "No work items."
 */
export function boardErrorFromValue(value: unknown): BoardError | undefined {
	if (!isRecord(value)) return undefined;
	const retryAfter =
		typeof value.retryAfter === "number" &&
		Number.isFinite(value.retryAfter) &&
		value.retryAfter >= 0
			? value.retryAfter
			: undefined;
	if (value.ok === false) {
		const text =
			typeof value.error === "string"
				? value.error
				: typeof value.message === "string"
					? value.message
					: undefined;
		return {
			...(retryAfter !== undefined ? { retryAfter } : {}),
			...(typeof value.status === "number" ? { status: value.status } : {}),
			code: "GATEWAY_REJECTED",
			message: text ?? "gateway rejected the call",
		};
	}
	const code = typeof value.code === "string" ? value.code : undefined;
	const status = typeof value.status === "number" ? value.status : undefined;
	const message = typeof value.message === "string" ? value.message : undefined;
	const isError =
		code !== undefined &&
		(value.defined === true || (status !== undefined && status >= 400));
	if (!isError) return undefined;
	return {
		...(retryAfter !== undefined ? { retryAfter } : {}),
		...(code ? { code } : {}),
		...(status !== undefined ? { status } : {}),
		message: message ?? code ?? "board error",
	};
}

/** A native command owns one deadline and a snapshot of the selected context. */
interface NativeCommand {
	protocolSequence: object;
	deadlineAt: number;
	callDeadlineAt?: number;
	context?: z.infer<typeof McpNativeBootstrapSchema>;
	/** The bootstrap came from the local cache, not this command's get_info. */
	contextFromCache?: boolean;
	/** Native tool names recorded with the cached bootstrap. */
	tools?: Record<string, string>;
}
export const nativeCommands = new WeakMap<NativeToolContext, NativeCommand>();
const WORK_RESPONSE_BYTES = 4 * 1024 * 1024;
const CLI_PROJECTION_SCHEMAS: Record<
	string,
	{ input: z.ZodType; output: z.ZodType }
> = {
	"agentTurnTriage/triage": {
		input: TriageAgentTurnInputSchema,
		output: TriageResultSchema,
	},
	"agentTurnTriage/labelReply": {
		input: LabelAgentReplyInputSchema,
		output: LabelAgentReplyResultSchema,
	},
	"agentTurnTriage/requestReplyDraft": {
		input: RequestAgentReplyDraftInputSchema,
		output: RequestAgentReplyDraftResultSchema,
	},
	"workItems/listCliProjection": {
		input: ListWorkCliProjectionInputSchema,
		output: ListWorkCliProjectionResultSchema,
	},
	"workItems/getCheckpointProjection": {
		input: WorkCheckpointProjectionInputSchema,
		output: WorkCheckpointProjectionSchema,
	},
	"workItems/listAttemptCliProjection": {
		input: WorkCliLedgerInputSchema,
		output: ListWorkAttemptCliProjectionResultSchema,
	},
	"workItems/listEvidenceCliProjection": {
		input: WorkCliLedgerInputSchema,
		output: ListWorkEvidenceCliProjectionResultSchema,
	},
	"workItems/listEventCliProjection": {
		input: WorkCliEventInputSchema,
		output: ListWorkEventCliProjectionResultSchema,
	},
	"workInteractions/listCliInboxProjection": {
		input: ListWorkInteractionCliInboxInputSchema,
		output: ListWorkInteractionCliInboxResultSchema,
	},
};
const WORK_NATIVE_ENDPOINTS: Record<string, string> = {
	list_deck_cards: "attention/listDeckCards",
	get_deck_card: "attention/getDeckCard",
	decide_deck_card: "attention/decideDeckCard",
	list_feed_for_you: "attention/listFeedForYou",
	record_agent_decision: "decisionGraph/recordAgentDecision",
	record_agent_decision_outcome: "decisionGraph/recordAgentDecisionOutcome",
	list_agent_decisions: "decisionGraph/listAgentDecisions",
	triage_agent_turn: "agentTurnTriage/triage",
	label_agent_reply: "agentTurnTriage/labelReply",
	request_agent_reply_draft: "agentTurnTriage/requestReplyDraft",
	report_work_agent_session_status: "workAgentSessions/report",
	list_work_item_cli_rows: "workItems/listCliProjection",
	corroborate_work_items: "workItems/corroborate",
	accept_work_item: "workItems/accept",
	add_comment: "workItems/addComment",
	add_project_milestone_dependency: "projects/addMilestoneDependency",
	add_work_case_dependency: "workItems/addCaseDependency",
	attach_project_milestone_work_item: "projects/attachMilestoneWorkItem",
	attach_work_case_item: "workItems/attachCaseWorkItem",
	authorize_owned_channel: "workItems/authorizeOwnedChannel",
	cancel_work_interaction: "workInteractions/cancel",
	cancel_work_items: "workItems/cancel",
	complete_work_item: "workItems/complete",
	create_project_milestone: "projects/createMilestone",
	create_work_case: "workItems/createCase",
	ack_work_interaction_delivery: "workInteractions/ackDelivery",
	record_reply_draft_delivery: "workInteractions/recordDraftDelivery",
	create_work_interaction: "workInteractions/create",
	create_work_items: "workItems/create",
	decide_work_approval: "workApprovals/decide",
	get_work_admission_specification: "workItems/getAdmissionSpecification",
	get_work_case: "workItems/getCase",
	get_work_fleet_control_tower: "workFleet/getControlTower",
	get_work_interaction: "workInteractions/get",
	get_work_item_checkpoint: "workItems/getCheckpointProjection",
	get_work_item_readiness: "workItems/getReadiness",
	get_work_items_by_id: "workItems/getById",
	heartbeat_work_item_attempt: "workItems/heartbeatAttempt",
	list_project_health_judgments: "projects/listHealthJudgments",
	list_project_milestones: "projects/listMilestones",
	list_undelivered_work_interaction_responses:
		"workInteractions/listUndelivered",
	list_ready_work: "workScheduler/listReady",
	list_work_approval_audit: "workApprovals/listAudit",
	list_work_approvals: "workApprovals/listInbox",
	list_work_attempt_cli_rows: "workItems/listAttemptCliProjection",
	list_work_budget_envelopes: "workItems/listBudgetEnvelopes",
	list_work_cases: "workItems/listCases",
	list_work_event_cli_rows: "workItems/listEventCliProjection",
	list_work_evidence_cli_rows: "workItems/listEvidenceCliProjection",
	list_work_interaction_audit: "workInteractions/listAudit",
	list_work_interaction_cli_rows: "workInteractions/listCliInboxProjection",
	list_work_interaction_outbox: "workInteractions/listOutbox",
	list_work_item_attempts: "workItems/listAttempts",
	list_work_item_events: "workItems/listEvents",
	list_work_item_evidence: "workItems/listEvidence",
	list_work_items: "workItems/list",
	list_work_resource_pools: "workItems/listResourcePools",
	plan_work_execution_clusters: "workScheduler/planClusters",
	propose_work_approval: "workApprovals/propose",
	put_work_budget_envelope: "workItems/putBudgetEnvelope",
	put_work_resource_pool: "workItems/putResourcePool",
	record_project_health_judgment: "projects/recordHealthJudgment",
	replace_work_admission_specification:
		"workItems/replaceAdmissionSpecification",
	respond_work_interaction: "workInteractions/respond",
	revoke_owned_channel: "workItems/revokeOwnedChannel",
	settle_work_item_attempt: "workItems/settleAttempt",
	start_work_item_attempt: "workItems/startAttempt",
	submit_work_item_evidence: "workItems/submitEvidence",
	update_project_milestone: "projects/updateMilestone",
	update_work_case: "workItems/updateCase",
};

function nativeOptions(ctx: NativeToolContext) {
	const state = nativeCommands.get(ctx);
	if (!state) throw new Error("Work native command context is missing");
	ctx.signal?.throwIfAborted();
	if (Date.now() >= (state.callDeadlineAt ?? state.deadlineAt))
		throw new Error("Work native command deadline exceeded");
	return {
		retryable: false,
		protocolSequence: state.protocolSequence,
		deadlineAt: state.callDeadlineAt ?? state.deadlineAt,
		maxResponseBytes: WORK_RESPONSE_BYTES,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	};
}

function usableDescriptor(value: unknown) {
	const descriptor = McpNativeDescriptorSchema.parse(value);
	const freshness = descriptor.schemaFreshness;
	if (
		!descriptor.eligible ||
		!descriptor.authorized ||
		!freshness.source ||
		!freshness.sourceRef ||
		!freshness.sourceHash ||
		!freshness.syncedAt ||
		!Number.isFinite(Date.parse(freshness.syncedAt))
	)
		throw new Error(
			"Work native descriptor is denied, ineligible or has no current schema provenance",
		);
	return descriptor;
}

function bootstrapCacheKey(ctx: NativeToolContext): string | undefined {
	if (!ctx.bootstrapCache || !ctx.mcpUrl) return undefined;
	return [
		ctx.mcpUrl,
		ctx.nativeCacheScope ?? ctx.workspace,
		ctx.organizationId ?? "",
	].join("|");
}

/** Validate a gateway bootstrap answer, fresh or cached, for this command. */
function checkedBootstrap(
	ctx: NativeToolContext,
	info: Record<string, unknown>,
) {
	const bootstrap = McpNativeBootstrapSchema.parse({
		nativeContext: info.nativeContext,
		nativeCatalog: info.nativeCatalog,
	});
	const gatewayOrg = bootstrap.nativeContext?.organizationId;
	if (!bootstrap.nativeContext || bootstrap.nativeCatalog.status !== "usable")
		throw new Error(
			`Work native catalog unavailable for organization ${gatewayOrg ?? "(unidentified)"}: the gateway for workspace ${ctx.workspace} does not expose authorized catalog search/describe routes, which the CLI needs to resolve Work tools such as list_work_item_cli_rows. Configure authorized native routes for this credential. No Code Mode fallback is available.`,
		);
	if (ctx.organizationId !== undefined && gatewayOrg !== ctx.organizationId)
		throw new Error(
			`Work native gateway organization mismatch: workspace ${ctx.workspace} expects organization ${ctx.organizationId}, but the gateway answered for ${gatewayOrg}. Run \`tedix login --workspace ${ctx.workspace}\` against the matching gateway.`,
		);
	if (
		usableDescriptor(bootstrap.nativeCatalog.search).endpoint !==
			"catalog/search" ||
		usableDescriptor(bootstrap.nativeCatalog.describe).endpoint !==
			"catalog/describe"
	)
		throw new Error("Native catalog endpoint mismatch");
	return bootstrap;
}

export async function nativeBootstrap(ctx: NativeToolContext) {
	const state = nativeCommands.get(ctx)!;
	if (state.context) return state.context;
	if (!ctx.mcpUrl)
		throw new Error("Work native transport requires the selected gateway");
	const key = bootstrapCacheKey(ctx);
	const cached = key ? ctx.bootstrapCache!.read(key) : undefined;
	if (cached) {
		try {
			state.context = checkedBootstrap(ctx, cached.bootstrap);
			state.contextFromCache = true;
			state.tools = cached.tools;
			return state.context;
		} catch {
			ctx.bootstrapCache!.forget(key!);
		}
	}
	const info = await ctx.client.callTool("get_info", {}, nativeOptions(ctx));
	if (!isRecord(info)) throw new Error("Malformed native gateway bootstrap");
	state.context = checkedBootstrap(ctx, info);
	state.contextFromCache = false;
	state.tools = {};
	if (key)
		ctx.bootstrapCache!.write(key, {
			bootstrap: {
				nativeContext: info.nativeContext,
				nativeCatalog: info.nativeCatalog,
			},
			tools: {},
		});
	return state.context;
}

/** Remember the native tool a callable resolved to, beside the cached bootstrap. */
function recordNativeTool(
	ctx: NativeToolContext,
	callable: string,
	name: string,
) {
	const state = nativeCommands.get(ctx)!;
	const key = bootstrapCacheKey(ctx);
	if (!key || !state.context || state.tools?.[callable] === name) return;
	state.tools = { ...state.tools, [callable]: name };
	const cached = ctx.bootstrapCache!.read(key);
	if (cached) ctx.bootstrapCache!.write(key, { ...cached, tools: state.tools });
}

/** Drop a cached bootstrap that failed to resolve; the next read fetches it fresh. */
function forgetCachedBootstrap(ctx: NativeToolContext): boolean {
	const state = nativeCommands.get(ctx)!;
	const key = bootstrapCacheKey(ctx);
	if (!state.contextFromCache || !key) return false;
	ctx.bootstrapCache!.forget(key);
	state.context = undefined;
	state.contextFromCache = false;
	state.tools = {};
	return true;
}

/** Validate the returned configured JSON schema before retaining or publishing data. */
function validateNativeSchema(schema: unknown, value: unknown): void {
	if (!isRecord(schema)) throw new Error("Native Work schema is absent");
	// Zod's converter rejects unsupported schemas instead of silently ignoring them.
	const validator = z.fromJSONSchema(schema);
	const result = validator.safeParse(value);
	if (!result.success)
		throw new Error(
			`Native Work schema validation failed: ${result.error.message}`,
		);
}

/** Explain why a catalog row cannot be called, keeping the row's alias and scope details. */
function catalogRowRefusal(
	ctx: NativeToolContext,
	callable: string,
	row: unknown,
): string {
	if (!isRecord(row)) return `Native Work callable ${callable} is malformed`;
	if (typeof row.aliasOf === "string" && row.aliasOf)
		return `Native Work callable ${callable} is an alias of ${row.aliasOf}; the CLI only calls canonical tools.`;
	const scopes = (value: unknown) =>
		Array.isArray(value)
			? value.filter((s): s is string => typeof s === "string")
			: [];
	const missing = scopes(row.missingScopes);
	const required = scopes(row.requiredScopes);
	const login = `run \`tedix login --workspace ${ctx.workspace}\` with a login that grants them.`;
	if (required.length === 0 && missing.length === 0)
		return `Native Work callable ${callable} is not authorized for this login; ${login}`;
	const needs = required.length > 0 ? ` needs ${required.join(", ")};` : "";
	const lacks =
		missing.length > 0
			? ` this login is missing ${missing.join(", ")}`
			: " this login does not grant them";
	return `Native Work callable ${callable}${needs}${lacks}; ${login}`;
}

function isNativeSchemaError(error: unknown): boolean {
	const message =
		isRecord(error) && typeof error.message === "string"
			? error.message
			: errorText(error);
	const status = isRecord(error) ? error.status : undefined;
	return (
		/schema|invalid.?params|validation|unknown tool|tool.*not found|method not found/i.test(
			message,
		) &&
		(status === undefined ||
			(typeof status === "number" && status >= 400 && status < 500))
	);
}

function invalidateNativeResolution(ctx: NativeToolContext, callable: string) {
	const key = bootstrapCacheKey(ctx);
	const entry = key ? ctx.bootstrapCache!.read(key) : undefined;
	if (!key || !entry) return;
	const resolutions = { ...entry.resolutions };
	delete resolutions[callable];
	ctx.bootstrapCache!.write(key, { ...entry, resolutions });
}

/** Resolve an exact configured callable; the catalog's native name is the wire identity. */
export async function boardCall(
	ctx: NativeToolContext,
	callable: string,
	args: Record<string, unknown>,
	destructiveApprovalReason?: string,
): Promise<BoardResult> {
	const input = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
	const state = nativeCommands.get(ctx)!;
	state.callDeadlineAt = Math.min(
		state.deadlineAt,
		Date.now() + ctx.client.getTimeoutMs(),
	);
	try {
		const expectedEndpoint =
			WORK_NATIVE_ENDPOINTS[callable.slice(callable.indexOf(".") + 1)];
		if (!expectedEndpoint) throw new Error("Unknown typed Work endpoint");
		const projectionSchema = CLI_PROJECTION_SCHEMAS[expectedEndpoint];
		projectionSchema?.input.parse(input);
		const dot = callable.indexOf(".");
		const resolve = async () => {
			const bootstrap = await nativeBootstrap(ctx);
			const key = bootstrapCacheKey(ctx);
			const entry = key ? ctx.bootstrapCache!.read(key) : undefined;
			const cached = entry?.resolutions?.[callable];
			const catalogHash = JSON.stringify(bootstrap.nativeCatalog);
			const cachedResolution =
				!!cached &&
				cached.catalogHash === catalogHash &&
				cached.at <= Date.now() &&
				Date.now() - cached.at < NATIVE_DESCRIPTOR_CACHE_TTL_MS;
			const search = usableDescriptor(bootstrap.nativeCatalog.search);
			const describe = usableDescriptor(bootstrap.nativeCatalog.describe);
			// Search and describe are independent reads; the checks below still
			// require both to agree before the call.
			const [result, detail] = cachedResolution
				? [{ results: [cached!.row] }, cached!.detail]
				: await Promise.all([
						ctx.client.callTool(
							search.name,
							{
								query: callable.slice(dot + 1),
								namespace: callable.slice(0, dot),
								limit: 100,
								includeOutputSchema: true,
							},
							nativeOptions(ctx),
						),
						ctx.client.callTool(
							describe.name,
							{ callable },
							nativeOptions(ctx),
						),
					]);
			if (!isRecord(result) || !Array.isArray(result.results))
				throw new Error("Malformed native Work catalog search");
			const matches = result.results.filter(
				(row: unknown) => isRecord(row) && row.callable === callable,
			);
			if (matches.length !== 1)
				throw new Error(
					`Native Work callable ${callable} is absent or ambiguous`,
				);
			const row = matches[0];
			if (!isRecord(row) || row.aliasOf || row.authorized !== true)
				throw new Error(catalogRowRefusal(ctx, callable, row));
			const selected = usableDescriptor(row.native);
			if (!expectedEndpoint || selected.endpoint !== expectedEndpoint)
				throw new Error("Native Work endpoint mismatch");
			if (
				!isRecord(detail) ||
				detail.callable !== callable ||
				detail.aliasOf ||
				detail.authorized !== true
			)
				throw new Error("Native Work catalog description mismatch");
			const descriptor = usableDescriptor(detail.native);
			if (JSON.stringify(selected) !== JSON.stringify(descriptor))
				throw new Error("Native Work descriptor changed during resolution");
			if (
				!isRecord(detail.schemaFreshness) ||
				detail.schemaFreshness.source !== descriptor.schemaFreshness.source ||
				detail.schemaFreshness.sourceHash !==
					descriptor.schemaFreshness.sourceHash ||
				detail.schemaFreshness.sourceRef !==
					descriptor.schemaFreshness.sourceRef ||
				detail.schemaFreshness.syncedAt !== descriptor.schemaFreshness.syncedAt
			)
				throw new Error("Native Work described schema provenance mismatch");
			if (
				typeof detail.schemaFreshness.toolUpdatedAt === "string" &&
				(!Number.isFinite(Date.parse(detail.schemaFreshness.toolUpdatedAt)) ||
					Date.parse(detail.schemaFreshness.toolUpdatedAt) >
						Date.parse(descriptor.schemaFreshness.syncedAt!))
			)
				throw new Error(
					"Native Work schema is stale relative to the configured tool",
				);
			validateNativeSchema(detail.parameters, input);
			// Prove the output schema is supported before invoking a mutation.
			if (!isRecord(row.outputSchema))
				throw new Error("Native Work output schema is absent");
			z.fromJSONSchema(row.outputSchema);
			if (!cachedResolution && key && entry) {
				ctx.bootstrapCache!.write(key, {
					...entry,
					resolutions: {
						...entry.resolutions,
						[callable]: {
							at: Date.now(),
							catalogHash,
							row,
							detail,
						},
					},
				});
			}
			return {
				descriptor,
				detail: { ...detail, outputSchema: row.outputSchema },
			};
		};
		let resolved: Awaited<ReturnType<typeof resolve>>;
		try {
			resolved = await resolve();
		} catch (error) {
			// A cached bootstrap may be stale: fetch it fresh and resolve once more.
			if (!forgetCachedBootstrap(ctx)) throw error;
			resolved = await resolve();
		}
		const { descriptor, detail } = resolved;
		recordNativeTool(ctx, callable, descriptor.name);
		const value = destructiveApprovalReason
			? await ctx.client.callToolWithDestructiveApproval(
					descriptor.name,
					input,
					destructiveApprovalReason,
					nativeOptions(ctx),
				)
			: await ctx.client.callTool(descriptor.name, input, nativeOptions(ctx));
		if (isRecord(value) && value.__tedix_truncated === true)
			return {
				value: undefined,
				error: {
					code: "RESULT_TRUNCATED",
					message: "Native Work response is incomplete; narrow or paginate",
				},
			};
		const error = boardErrorFromValue(value);
		if (error) {
			if (isNativeSchemaError(error)) invalidateNativeResolution(ctx, callable);
			return { value, error };
		}
		nativeOptions(ctx);
		validateNativeSchema(detail.outputSchema, value);
		projectionSchema?.output.parse(value);
		return { value };
	} catch (error) {
		if (isNativeSchemaError(error)) invalidateNativeResolution(ctx, callable);
		return {
			value: undefined,
			error: {
				message: errorText(error),
				...(isRecord(error) &&
				typeof error.retryAfter === "number" &&
				Number.isFinite(error.retryAfter) &&
				error.retryAfter >= 0
					? { retryAfter: error.retryAfter }
					: {}),
				...(isRecord(error) && typeof error.status === "number"
					? { status: error.status }
					: {}),
			},
		};
	}
}

/** Resolve a configured canonical tool through the same tenant/schema/native checks as Work. */
export async function callConfiguredNativeTool(
	ctx: NativeToolContext,
	callable: string,
	input: Record<string, unknown>,
): Promise<unknown> {
	nativeCommands.set(ctx, {
		protocolSequence: {},
		deadlineAt: Date.now() + ctx.client.getTimeoutMs(),
	});
	const result = await boardCall(ctx, callable, input);
	if (result.error) throw new Error(result.error.message);
	return result.value;
}
