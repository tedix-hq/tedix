import { claimFiles, fileResourceKeys } from "./work-claim-files";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { mutationCallable, withSession } from "./work-identity";
import { boardCall } from "./work-native";
import { fail, ok } from "./work-render";
import { resolveWorkItemId, parseObjectArgument } from "./work-queries";
import type { WorkContext } from "./work";

interface StructuredFactoryVerb {
	tool: string;
	namespace?: "projects" | "work" | "agent";
	write: boolean;
	pathField?: string;
	defaultInput?: (ctx: WorkContext) => Record<string, unknown>;
	transform?: (
		input: Record<string, unknown>,
		ctx: WorkContext,
	) => Record<string, unknown>;
}

export const STRUCTURED_FACTORY_VERBS: Record<string, StructuredFactoryVerb> = {
	"dispatch-list": { tool: "list_work_items", write: false },
	"dispatch-get": {
		tool: "get_work_items_by_id",
		write: false,
		pathField: "id",
	},
	"dispatch-attempts": {
		tool: "list_work_item_attempts",
		write: false,
		pathField: "id",
	},
	"agent-turn-triage": {
		tool: "triage_agent_turn",
		namespace: "agent",
		write: false,
	},
	"agent-reply-label": {
		tool: "label_agent_reply",
		namespace: "agent",
		write: false,
	},
	"agent-reply-draft-request": {
		tool: "request_agent_reply_draft",
		namespace: "agent",
		write: true,
	},
	"agent-session-report": {
		tool: "report_work_agent_session_status",
		write: true,
	},
	"dispatcher-health-list": {
		tool: "list_dispatcher_health",
		write: false,
	},
	"dispatcher-health-record": {
		tool: "report_dispatcher_health",
		write: true,
	},
	"case-list": {
		tool: "list_work_cases",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"case-get": { tool: "get_work_case", write: false, pathField: "caseId" },
	"case-create": { tool: "create_work_case", write: true },
	"case-stage": { tool: "update_work_case", write: true, pathField: "caseId" },
	"case-close": {
		tool: "update_work_case",
		write: true,
		pathField: "caseId",
		transform: (input) => ({ ...input, stage: "closed" }),
	},
	"case-attach": {
		tool: "attach_work_case_item",
		write: true,
		pathField: "caseId",
	},
	"case-dependency-add": { tool: "add_work_case_dependency", write: true },
	"milestone-list": {
		tool: "list_project_milestones",
		namespace: "projects",
		write: false,
		pathField: "id",
	},
	"milestone-create": {
		tool: "create_project_milestone",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-update": {
		tool: "update_project_milestone",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-attach": {
		tool: "attach_project_milestone_work_item",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"milestone-dependency-add": {
		tool: "add_project_milestone_dependency",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"health-list": {
		tool: "list_project_health_judgments",
		namespace: "projects",
		write: false,
		pathField: "id",
	},
	"health-record": {
		tool: "record_project_health_judgment",
		namespace: "projects",
		write: true,
		pathField: "id",
	},
	"approval-list": {
		tool: "list_work_approvals",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"approval-audit-list": {
		tool: "list_work_approval_audit",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"approval-propose": { tool: "propose_work_approval", write: true },
	"approval-decide": {
		tool: "decide_work_approval",
		write: true,
		pathField: "proposalId",
	},
	"interaction-list": {
		tool: "list_work_interaction_cli_rows",
		write: false,
		defaultInput: (ctx) => ({ limit: Math.min(5, ctx.work.limit ?? 5) }),
	},
	"interaction-audit-list": {
		tool: "list_work_interaction_audit",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-outbox-list": {
		tool: "list_work_interaction_outbox",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-get": {
		tool: "get_work_interaction",
		write: false,
		pathField: "requestId",
		defaultInput: () => ({}),
	},
	"interaction-create": {
		tool: "create_work_interaction",
		write: true,
		transform: (input, ctx) => withSession(ctx, input),
	},
	"interaction-respond": {
		tool: "respond_work_interaction",
		write: true,
		pathField: "requestId",
		// --no-deliver: response metadata.delivery="none" (a closure the
		// asking session need not see; never listed as undelivered).
		transform: (input, ctx) =>
			ctx.work.noDeliver
				? {
						...input,
						metadata: {
							...(isRecord(input.metadata) ? input.metadata : {}),
							delivery: "none",
						},
					}
				: input,
	},
	"interaction-cancel": {
		tool: "cancel_work_interaction",
		write: true,
		pathField: "requestId",
		transform: (input, ctx) => ({
			...input,
			confirmDestructive: true,
			reason:
				ctx.work.reason?.trim() || "User requested work interaction-cancel",
		}),
	},
	"interaction-undelivered": {
		tool: "list_undelivered_work_interaction_responses",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"interaction-ack": { tool: "ack_work_interaction_delivery", write: true },
	"interaction-draft-delivered": {
		tool: "record_reply_draft_delivery",
		write: true,
		pathField: "requestId",
	},
	"admission-get": {
		tool: "get_work_admission_specification",
		write: false,
		pathField: "id",
	},
	"admission-replace": {
		tool: "replace_work_admission_specification",
		write: true,
		pathField: "id",
	},
	"resource-list": {
		tool: "list_work_resource_pools",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"resource-put": { tool: "put_work_resource_pool", write: true },
	"budget-list": {
		tool: "list_work_budget_envelopes",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"budget-put": { tool: "put_work_budget_envelope", write: true },
	fleet: {
		tool: "get_work_fleet_control_tower",
		write: false,
		defaultInput: () => ({}),
	},
	clusters: {
		tool: "plan_work_execution_clusters",
		write: false,
		defaultInput: (ctx) => ({
			limit: ctx.work.limit ?? 100,
			candidateLimit: 10,
			maxParallelism: 8,
		}),
	},
	scheduler: {
		tool: "list_ready_work",
		write: false,
		defaultInput: (ctx) => ({
			limit: ctx.work.limit ?? 20,
			candidateLimit: 200,
		}),
	},
};

function structuredFactoryInput(
	ctx: WorkContext,
	verb: string,
	spec: StructuredFactoryVerb,
	pathId: string,
): Record<string, unknown> {
	const raw = ctx.work.input?.trim();
	if (!raw) {
		const defaults = spec.defaultInput?.(ctx);
		if (defaults) {
			const withPath =
				spec.pathField && pathId
					? { ...defaults, [spec.pathField]: pathId }
					: defaults;
			return spec.transform?.(withPath, ctx) ?? withPath;
		}
		throw new Error(`work ${verb} requires --input <json|@path>`);
	}
	const parsed = parseObjectArgument(raw, "--input");
	const input =
		spec.pathField && pathId ? { ...parsed, [spec.pathField]: pathId } : parsed;
	return spec.transform?.(input, ctx) ?? input;
}

export async function workStructuredFactory(
	ctx: WorkContext,
	verb: string,
	pathId: string,
): Promise<number> {
	const spec = STRUCTURED_FACTORY_VERBS[verb];
	if (!spec) throw new Error(`Unknown structured Work factory verb ${verb}`);
	const callable = `${spec.namespace ?? "work"}.${spec.tool}`;
	if (spec.write) mutationCallable(ctx.work.as?.trim(), callable);
	else if (ctx.work.as?.trim())
		throw new Error(
			`work ${verb} does not expose a tedi-scoped callable; remove --as and use the credential-scoped canonical read`,
		);
	if (ctx.work.executorTedi && verb !== "clusters")
		throw new Error("--executor-tedi is only valid with work clusters");
	let input = structuredFactoryInput(ctx, verb, spec, pathId);
	if (verb === "clusters") {
		const embeddedExecutor = isRecord(input.executor)
			? input.executor
			: undefined;
		const embedded =
			embeddedExecutor?.type === "tedi" &&
			typeof embeddedExecutor.id === "string"
				? embeddedExecutor.id
				: undefined;
		if (ctx.work.executorTedi && embedded && ctx.work.executorTedi !== embedded)
			throw new Error("--executor-tedi conflicts with executor.id in --input");
		const selected = ctx.work.executorTedi ?? embedded;
		if (ctx.authSource?.startsWith("stored-login") && !selected)
			throw new Error(
				"Operator cluster planning requires --executor-tedi <uuid>",
			);
		if (ctx.work.executorTedi)
			input = {
				...input,
				executor: { type: "tedi", id: ctx.work.executorTedi },
			};
	}
	const call = await boardCall(ctx, callable, input);
	if (call.error) {
		return fail(
			ctx,
			call.error,
			`Could not run work ${verb}: ${call.error.message}`,
		);
	}
	return ok(ctx, call.value, () =>
		console.log(JSON.stringify(call.value, null, 2)),
	);
}

export async function workClaimFiles(
	ctx: WorkContext,
	id: string,
	text: string,
): Promise<number> {
	if (!id || text)
		throw new Error(
			"work claim-files requires exactly one Work Item id; pass files with --path",
		);
	mutationCallable(ctx.work.as, "work.replace_work_admission_specification");
	if (ctx.work.input)
		throw new Error("work claim-files uses --repo-key and --path, not --input");
	const keys = fileResourceKeys(ctx.work.repoKey, ctx.work.paths);
	id = await resolveWorkItemId(ctx, id);
	const result = await claimFiles(id, keys, (tool, input) =>
		boardCall(ctx, tool, input),
	);
	if (result.error) return fail(ctx, result.error, result.error.message);
	return ok(ctx, result.value, () =>
		console.log(
			`${result.value.changed ? "Declared" : "Already declared"} ${keys.length} file requirement(s) for ${id}. Resources are reserved only at work start.`,
		),
	);
}
