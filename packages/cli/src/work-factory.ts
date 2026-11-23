import { claimFiles, fileResourceKeys } from "./work-claim-files";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { mutationCallable, withSession } from "./work-identity";
import { boardCall } from "./work-native";
import { fail, ok, itemsFromList } from "./work-render";
import {
	resolveWorkItemId,
	parseObjectArgument,
	projectArg,
	getWorkItem,
} from "./work-queries";
import type { WorkContext } from "./work";

interface StructuredFactoryVerb {
	tool: string;
	namespace?: "projects" | "work" | "agent" | "dispatcher";
	write: boolean;
	pathField?: string;
	example?: string;
	defaultInput?: (ctx: WorkContext) => Record<string, unknown>;
	transform?: (
		input: Record<string, unknown>,
		ctx: WorkContext,
	) => Record<string, unknown>;
}

export const STRUCTURED_FACTORY_VERBS: Record<string, StructuredFactoryVerb> = {
	"authorize-release": {
		tool: "authorize_personal_cli_release",
		write: false,
		pathField: "id",
	},
	wait: {
		tool: "wait_work_items",
		write: false,
		pathField: "id",
		defaultInput: () => ({}),
	},
	"dispatch-reassign": {
		tool: "update_work_item_specification",
		write: true,
		pathField: "id",
	},
	"dispatch-hold": {
		example: `tedix work dispatch-hold <id> --input '{"expectedWorkItemVersion":1,"laneDispatch":{"state":"held","reason":"Needs review"}}'`,
		tool: "update_work_item_specification",
		write: true,
		pathField: "id",
	},
	"dispatch-idle-list": { tool: "list_work_items", write: false },
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
	"choose-tool": {
		tool: "choose_work_tool",
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
		namespace: "dispatcher",
		write: false,
	},
	"runner-rules": {
		tool: "get_runner_rules",
		namespace: "dispatcher",
		write: false,
	},
	"dispatcher-health-record": {
		tool: "report_dispatcher_health",
		namespace: "dispatcher",
		write: true,
	},
	"case-list": {
		tool: "list_work_cases",
		write: false,
		defaultInput: (ctx) => ({ limit: ctx.work.limit ?? 50 }),
	},
	"case-get": {
		tool: "get_work_case",
		write: false,
		pathField: "caseId",
		defaultInput: () => ({}),
	},
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
	"attempt-grant": {
		tool: "grant_work_lane_attempt",
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

for (const [verb, spec] of Object.entries(STRUCTURED_FACTORY_VERBS)) {
	if (verb.startsWith("case-") && verb !== "case-list")
		STRUCTURED_FACTORY_VERBS[verb.replace("case-", "epic-")] = spec;
}

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
		throw new Error(
			`work ${verb} requires --input <json|@path>. ${spec.example ? `Example: ${spec.example}` : `Inspect the input with: tedix code 'async () => await discover.search({query:"${spec.tool}",limit:1,includeParameters:true})'`}`,
		);
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

export async function workEpics(ctx: WorkContext): Promise<number> {
	if (ctx.work.as)
		throw new Error(
			"work epics uses the credential-scoped canonical read; remove --as",
		);
	const input = {
		limit: ctx.work.limit ?? 50,
		...projectArg(ctx.work.project),
		...(ctx.work.input ? parseObjectArgument(ctx.work.input, "--input") : {}),
		...(!ctx.work.all
			? { stages: ["investigating", "planning", "executing", "monitoring"] }
			: {}),
	};
	const call = await boardCall(ctx, "work.list_work_cases", input);
	if (call.error) return fail(ctx, call.error, call.error.message);
	const rows: (Record<string, unknown> & { openItemCount: number })[] = [];
	for (const epic of itemsFromList(call.value)) {
		let openItemCount = 0;
		let cursor: string | undefined;
		do {
			const detail = await boardCall(ctx, "work.get_work_case", {
				caseId: epic.id,
				itemLimit: 100,
				...(cursor ? { itemCursor: cursor } : {}),
			});
			if (detail.error) return fail(ctx, detail.error, detail.error.message);
			if (!isRecord(detail.value) || !isRecord(detail.value.items))
				throw new Error("Malformed epic item page");
			for (const link of itemsFromList(detail.value.items)) {
				const item = await getWorkItem(ctx, String(link.workItemId));
				if (item.error) return fail(ctx, item.error, item.error.message);
				if (!isRecord(item.value) || !isRecord(item.value.workItem))
					throw new Error("Malformed epic Work Item");
				if (
					!["completed", "cancelled"].includes(
						String(item.value.workItem.disposition),
					)
				)
					openItemCount++;
			}
			cursor =
				typeof detail.value.items.nextCursor === "string"
					? detail.value.items.nextCursor
					: undefined;
		} while (cursor);
		rows.push({ ...epic, openItemCount });
	}
	const nextCursor = isRecord(call.value) ? call.value.nextCursor : null;
	return ok(ctx, { data: rows, nextCursor }, () => {
		console.log("ID\tTITLE\tKIND\tSTAGE\tOPEN ITEMS");
		for (const epic of rows)
			console.log(
				`${epic.id}\t${epic.title}\t${epic.kind}\t${epic.stage}\t${epic.openItemCount}`,
			);
		if (nextCursor)
			console.log(
				`More epics: tedix work epics${ctx.work.all ? " --all" : ""}${ctx.work.project ? ` --project ${ctx.work.project}` : ""} --input '${JSON.stringify({ cursor: nextCursor })}'`,
			);
	});
}
