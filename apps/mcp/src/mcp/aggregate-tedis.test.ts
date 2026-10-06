import { validateSpec } from "@json-render/core";
import {
	SkillRunSchema,
	SkillRunSummarySchema,
	skillsContract,
} from "@tedix/api-contract/contracts/cognitive";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import { describe, expect, it } from "vite-plus/test";
import { hydrateAggregateRuntimeKinds } from "../index";
import {
	buildAggregateTediTools,
	buildTediCodeInvocation,
	getTediMcpServerUrl,
} from "./aggregate-tedis";
import { SKILL_WORKFLOW_TOOLS } from "./aggregate-tedis-skill-workflows";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";

const env = {
	MCP_URL: "https://mcp.tedix.dev",
} as CloudflareEnv;

type RuntimeMetaRow = {
	slug: string;
	id: string;
	organizationId: string;
	runtimeKind: string;
	runtimeState: string;
	status: string | null;
};

/**
 * Build a CloudflareEnv whose API_SERVICE binding answers the
 * `tedis/listRuntimeMetaBySlugs` service-binding call. `handler` receives the
 * requested slugs and returns the rows to serve (or throws to simulate a
 * transient API outage).
 */
function envWithRuntimeMeta(
	handler: (slugs: string[]) => RuntimeMetaRow[],
	opts?: { status?: number },
): CloudflareEnv {
	return {
		MCP_URL: "https://mcp.tedix.dev",
		API_SERVICE: {
			fetch: async (request: Request) => {
				const slugs =
					((await request.json()) as { json?: { slugs?: string[] } }).json
						?.slugs ?? [];
				const status = opts?.status ?? 200;
				if (status !== 200) {
					return new Response("upstream error", { status });
				}
				const data = handler(slugs);
				return new Response(JSON.stringify({ json: { data } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		},
	} as unknown as CloudflareEnv;
}

describe("aggregate tedis", () => {
	it("gives trajectory mining its bounded long-running RPC deadline", () => {
		expect(
			SKILL_WORKFLOW_TOOLS.find((tool) => tool.name === "mine_skill_candidates")
				?.timeout,
		).toBe(120_000);
	});

	it("projects the artifact-neutral Work Item lifecycle as dedicated RPC tools", () => {
		const tools = buildAggregateTediTools(
			[
				{
					slug: "cto",
					namespace: "cto",
					runtimeKind: "agent",
					tediId: "cto-id",
				},
			],
			env,
		);
		const endpoints = new Map(
			tools.map((tool) => [
				tool.toolId,
				(tool.config as { endpoint?: string }).endpoint,
			]),
		);
		for (const [name, endpoint] of Object.entries({
			get_work_item_readiness: "workItems/getReadiness",
			start_work_attempt: "workItems/startAttempt",
			heartbeat_work_attempt: "workItems/heartbeatAttempt",
			settle_work_attempt: "workItems/settleAttempt",
			list_work_attempts: "workItems/listAttempts",
			submit_work_evidence: "workItems/submitEvidence",
			complete_work_item: "workItems/complete",
			list_work_evidence: "workItems/listEvidence",
			list_work_events: "workItems/listEvents",
		})) {
			expect(endpoints.get(`cto__${name}`), name).toBe(endpoint);
		}
		expect(endpoints.has("cto__work_item_claim")).toBe(false);
		expect(endpoints.has("cto__work_item_release")).toBe(false);
		for (const name of [
			"start_work_attempt",
			"heartbeat_work_attempt",
			"settle_work_attempt",
			"submit_work_evidence",
			"complete_work_item",
		]) {
			const tool = tools.find(
				(candidate) => candidate.toolId === `cto__${name}`,
			);
			expect(tool?.inputSchema.properties).not.toHaveProperty("tediId");
			expect(tool?.config).toMatchObject({
				_aggregateTediId: "cto-id",
				_credentialDerivedTediActor: true,
			});
		}
	});

	it("builds tedi MCP URLs from the configured MCP base host", () => {
		expect(getTediMcpServerUrl({ slug: "cto" }, env)).toBe(
			"https://cto.tedi.tedix.dev/mcp",
		);
	});

	it("carries D1-hydrated tedi identity into managed MCP proxy config", () => {
		const tools = buildAggregateTediTools(
			[
				{
					slug: "acme-operator",
					namespace: "acme_tedi",
					runtimeKind: "agent",
					tediId: "5eed0027-0000-4000-8000-000000000027",
					organizationId: "5eed0045-0000-4000-8000-000000000045",
				},
			],
			env,
		);

		const send = tools.find(
			(tool) => tool.toolId === "acme_tedi__run_tedi_turn",
		);
		expect(send?.config).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://acme-operator.tedi.tedix.dev/mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediSlug: "acme-operator",
			_aggregateTediId: "5eed0027-0000-4000-8000-000000000027",
			_aggregateTediOrgId: "5eed0045-0000-4000-8000-000000000045",
		});
		expect(send?.config).not.toHaveProperty("responsePath");
		expect(send?.config).not.toHaveProperty("_aggregateTediRemoteName");

		const ask = buildAggregateTediTools(
			[
				{
					slug: "acme-operator",
					namespace: "acme_tedi",
					runtimeKind: "agent",
					surface: "collaboration",
				},
			],
			env,
		).find((tool) => tool.toolId === "acme_tedi__ask");
		expect(ask?.config).toMatchObject({
			transport: "mcp",
			mcpToolName: "run_tedi_turn",
		});
		expect(ask?.config).not.toHaveProperty("responsePath");
		expect(ask?.config).not.toHaveProperty("_aggregateTediRemoteName");
	});

	it("exposes the complete learning feedback loop as body-neutral RPC tools", () => {
		const tools = buildAggregateTediTools(
			[
				{
					slug: "echo",
					namespace: "echo",
					runtimeKind: "agent",
					tediId: "tedi-1",
					organizationId: "org-1",
				},
			],
			env,
		);
		const byId = new Map(tools.map((tool) => [tool.toolId, tool]));
		for (const id of [
			"echo__record_learning_interaction",
			"echo__list_learning_interactions",
			"echo__attribute_learning_feedback",
			"echo__record_learning_measurement",
			"echo__get_learning_feedback_summary",
			"echo__analyze_recurring_learning_issues",
			"echo__propose_learning_improvement",
			"echo__list_learning_improvements",
			"echo__evaluate_learning_improvement",
		]) {
			expect(byId.has(id), id).toBe(true);
		}
		expect(byId.get("echo__record_learning_interaction")?.config).toMatchObject(
			{
				transport: "rpc",
				endpoint: "learningFeedback/recordInteraction",
				staticParams: { tediId: "tedi-1" },
			},
		);
		expect(
			byId.get("echo__record_learning_interaction")?.inputSchema.properties,
		).not.toHaveProperty("tediId");
		expect(
			byId.get("echo__record_learning_interaction")?.outputSchema,
		).toBeTruthy();
		expect(
			byId.get("echo__get_learning_feedback_summary")?.annotations,
		).toMatchObject({
			readOnlyHint: true,
		});
		expect(
			byId.get("echo__analyze_recurring_learning_issues")?.inputSchema
				.properties,
		).not.toHaveProperty("tediId");
		expect(
			byId.get("echo__propose_learning_improvement")?.annotations,
		).toMatchObject({
			readOnlyHint: false,
		});
	});

	it("does not advertise container-only tools for agent runtime rows", () => {
		const tools = buildAggregateTediTools(
			[{ slug: "cto", namespace: "cto", runtimeKind: "agent" }],
			env,
		);
		const toolIds = tools.map((tool) => tool.toolId);

		expect(new Set(toolIds).size).toBe(toolIds.length);
		expect(toolIds).toEqual(expect.arrayContaining(["cto__run_tedi_turn"]));
		expect(toolIds).not.toContain("cto__run_skill_workflow");
		expect(toolIds).not.toContain("cto__get_skill_workflow_status");
		expect(toolIds).not.toContain("cto__get_tedi_runtime_status");
		expect(toolIds).not.toContain("cto__work_items_list");
		expect(toolIds).not.toContain("cto__harness_versions");
		expect(toolIds).not.toContain("cto__get_process_logs");
		expect(toolIds).not.toContain("cto__permissions_respond");
		expect(toolIds).not.toContain("cto__browser_quick_capture");
	});

	it("keeps run context out of strict Computer arguments", () => {
		const tools = buildAggregateTediTools(
			[{ slug: "cto", namespace: "cto", runtimeKind: "agent" }],
			env,
		);

		for (const toolId of [
			"cto__exec",
			"cto__read_execution",
			"cto__cancel_execution",
		]) {
			const schema = tools.find((tool) => tool.toolId === toolId)
				?.inputSchema as { properties?: Record<string, unknown> } | undefined;
			expect(schema?.properties).toBeDefined();
			for (const key of [
				"kernelRunId",
				"traceBundleId",
				"traceId",
				"workItemId",
				"leaseId",
				"jobId",
				"kind",
			])
				expect(schema?.properties).not.toHaveProperty(key);
		}
	});

	it("projects Computer v0.3 file pagination and edit contracts", () => {
		const tools = buildAggregateTediTools(
			[{ slug: "cto", namespace: "cto", runtimeKind: "agent" }],
			env,
		);
		const schema = (name: string) =>
			tools.find((tool) => tool.toolId === `cto__${name}`)!.inputSchema;
		expect(schema("read")).toMatchObject({
			required: ["path"],
			properties: {
				offset: { type: "integer", minimum: 1 },
				byteOffset: { type: "integer", minimum: 0 },
				limit: { type: "integer", minimum: 1 },
			},
		});
		expect(schema("ls")).toMatchObject({
			required: ["path"],
			properties: {
				limit: { type: "integer", minimum: 1, maximum: 1000 },
				offset: { type: "integer", minimum: 0 },
			},
		});
		expect(schema("find")).toMatchObject({
			required: ["pattern"],
			properties: {
				path: { default: "/workspace" },
				exclude: { type: "array", items: { type: "string" } },
			},
		});
		expect(schema("grep")).toMatchObject({
			required: ["query"],
			properties: {
				context: { type: "integer", minimum: 0, maximum: 10 },
				regex: { type: "boolean" },
				ignoreCase: { type: "boolean" },
				include: { type: "string" },
			},
		});
		expect(schema("delete")).toMatchObject({
			required: ["path"],
			properties: { recursive: { type: "boolean" } },
		});
		expect(schema("write").required).toEqual(["path", "content"]);
		expect(schema("edit")).toMatchObject({
			required: ["path", "edits"],
			properties: {
				edits: {
					type: "array",
					items: {
						required: ["oldText", "newText"],
						additionalProperties: false,
					},
				},
			},
		});
		for (const name of ["read", "ls", "find", "grep", "read_execution"])
			expect(
				tools.find((tool) => tool.toolId === `cto__${name}`)?.annotations
					?.readOnlyHint,
			).toBe(true);
		for (const name of [
			"write",
			"edit",
			"delete",
			"exec",
			"open_computer",
			"close_computer",
			"cancel_execution",
		])
			expect(
				tools.find((tool) => tool.toolId === `cto__${name}`)?.annotations
					?.readOnlyHint,
			).toBe(false);
	});

	it("projects promote_skill with the canonical skills.promote input schema", () => {
		const tools = buildAggregateTediTools(
			[
				{ slug: "cto", namespace: "cto", tediId: "cto-id" },
				{ slug: "ceo", namespace: "ceo", tediId: "ceo-id" },
				{ slug: "cmo", namespace: "cmo", tediId: "cmo-id" },
			],
			env,
		);
		const canonicalPromoteSchema = zodToToolInputJsonSchema(
			procedureInputSchema(skillsContract.promote),
		);

		for (const namespace of ["cto", "ceo", "cmo"]) {
			const promoteSkill = tools.find(
				(tool) => tool.toolId === `${namespace}__promote_skill`,
			);
			expect(promoteSkill?.inputSchema).toEqual(canonicalPromoteSchema);
		}
	});

	it("projects list_promotion_candidates with the native tedi schema shape", () => {
		const tools = buildAggregateTediTools(
			[
				{ slug: "cto", namespace: "cto", tediId: "cto-id" },
				{ slug: "ceo", namespace: "ceo", tediId: "ceo-id" },
				{ slug: "cmo", namespace: "cmo", tediId: "cmo-id" },
			],
			env,
		);
		const canonicalCandidateSchema = zodToToolInputJsonSchema(
			procedureInputSchema(skillsContract.listPromotionCandidates),
		);
		const { tediId: _tediId, ...candidateProperties } =
			canonicalCandidateSchema.properties ?? {};
		const expectedCandidateSchema = {
			...canonicalCandidateSchema,
			properties: candidateProperties,
			required: canonicalCandidateSchema.required?.filter(
				(name) => name !== "tediId",
			),
		};

		for (const namespace of ["cto", "ceo", "cmo"]) {
			const candidateTool = tools.find(
				(tool) => tool.toolId === `${namespace}__list_promotion_candidates`,
			);
			expect(candidateTool?.inputSchema).toEqual(expectedCandidateSchema);
			expect(candidateTool?.annotations).toMatchObject({ readOnlyHint: true });
		}
	});

	it("projects the workflow operations and inspection surface with canonical annotations", () => {
		const tools = buildAggregateTediTools(
			[
				{
					slug: "cto",
					namespace: "cto",
					runtimeKind: "agent",
					tediId: "cto-id",
				},
			],
			env,
		);
		const byName = (name: string) =>
			tools.find((tool) => tool.toolId === `cto__${name}`);

		for (const name of [
			"inspect_skill_workflow_run",
			"list_skill_workflow_steps",
			"list_skill_workflow_tool_calls",
			"list_skill_workflow_revisions",
			"get_skill_workflow_revision",
			"compare_skill_workflow_revisions",
			"get_skill_workflow_reliability",
			"list_skill_workflow_schedules",
		]) {
			expect(byName(name)?.annotations).toMatchObject({ readOnlyHint: true });
		}
		for (const name of [
			"pause_skill_workflow",
			"resume_skill_workflow",
			"approve_skill_workflow",
			"reject_skill_workflow",
		]) {
			expect(byName(name)?.annotations).toMatchObject({ readOnlyHint: false });
		}
		expect(byName("cancel_skill_workflow")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		expect(byName("restart_skill_workflow")?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
		});
		for (const name of [
			"run_skill_workflow",
			"approve_skill_workflow",
			"reject_skill_workflow",
			"send_skill_workflow_event",
		]) {
			expect(byName(name)?.annotations).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
			});
			expect(byName(name)?.inputSchema.properties).toHaveProperty(
				"confirmDestructive",
			);
			expect(byName(name)?.inputSchema.properties).toHaveProperty("reason");
		}
		for (const name of ["cancel_skill_workflow", "restart_skill_workflow"]) {
			expect(byName(name)?.inputSchema.properties).toHaveProperty(
				"confirmDestructive",
			);
			expect(byName(name)?.inputSchema.properties).toHaveProperty("reason");
		}
		expect(byName("inspect_skill_workflow_run")?.outputSchema).toBeTruthy();
		expect(byName("record_artifact")?.outputSchema).toBeTruthy();
		expect(byName("record_artifact")?.config).toMatchObject({
			allowExplicitTediId: false,
			staticParams: { tediId: "cto-id" },
		});
		expect(
			byName("record_artifact")?.inputSchema.properties,
		).not.toHaveProperty("tediId");
		expect(byName("inspect_skill_workflow_run")?.config).toMatchObject({
			allowExplicitTediId: false,
			staticParams: { tediId: "cto-id" },
		});
		expect(
			byName("inspect_skill_workflow_run")?.inputSchema.properties,
		).not.toHaveProperty("tediId");
		expect(byName("run_skill_workflow")?.inputSchema.properties).toHaveProperty(
			"idempotencyKey",
		);
		expect(byName("run_skill_workflow")?.inputSchema.properties).toHaveProperty(
			"runId",
		);
		expect(
			byName("cancel_skill_workflow")?.inputSchema.properties,
		).toHaveProperty("rollback");
		expect(
			byName("restart_skill_workflow")?.inputSchema.properties,
		).toHaveProperty("restartId");
		expect(byName("restart_skill_workflow")?.inputSchema.required).toContain(
			"restartId",
		);
		expect(
			byName("restart_skill_workflow")?.inputSchema.properties.restartId,
		).toMatchObject({
			maxLength: 128,
		});
		expect(
			byName("restart_skill_workflow")?.inputSchema.properties,
		).toHaveProperty("abortUnknown");
		expect(
			byName("restart_skill_workflow")?.inputSchema.properties.abortUnknown,
		).toMatchObject({
			type: "boolean",
			default: false,
		});
		expect(
			byName("restart_skill_workflow")?.outputSchema?.properties,
		).toHaveProperty("restartAborted");
	});

	it("projects audit_low_quality_skills with the native tedi schema shape", () => {
		const tools = buildAggregateTediTools(
			[
				{ slug: "cto", namespace: "cto", tediId: "cto-id" },
				{ slug: "ceo", namespace: "ceo", tediId: "ceo-id" },
				{ slug: "cmo", namespace: "cmo", tediId: "cmo-id" },
			],
			env,
		);
		const canonicalAuditSchema = zodToToolInputJsonSchema(
			procedureInputSchema(skillsContract.auditLowQuality),
		);
		const { tediId: _tediId, ...auditProperties } =
			canonicalAuditSchema.properties ?? {};
		const expectedAuditSchema = {
			...canonicalAuditSchema,
			properties: auditProperties,
			required: canonicalAuditSchema.required?.filter(
				(name) => name !== "tediId",
			),
		};

		for (const namespace of ["cto", "ceo", "cmo"]) {
			const auditTool = tools.find(
				(tool) => tool.toolId === `${namespace}__audit_low_quality_skills`,
			);
			expect(auditTool?.inputSchema).toEqual(expectedAuditSchema);
			expect(auditTool?.annotations).toMatchObject({ readOnlyHint: false });
		}
	});

	it("keeps container tools off the collaboration surface", () => {
		const tools = buildAggregateTediTools(
			[
				{
					slug: "cto",
					namespace: "cto",
					surface: "collaboration",
					runtimeKind: "agent",
					tediId: "cto-id",
				},
			],
			env,
		);

		expect(tools.map((tool) => tool.toolId)).toContain("cto__ask");
		expect(tools.map((tool) => tool.toolId)).toContain(
			"cto__synthesize_spoken_reply",
		);
		expect(tools.map((tool) => tool.toolId)).toContain("cto__memory_search");
		expect(tools.map((tool) => tool.toolId)).toContain(
			"cto__review_memory_fact",
		);
		expect(tools.map((tool) => tool.toolId)).not.toContain(
			"cto__read_resource",
		);
		expect(tools.map((tool) => tool.toolId)).not.toContain(
			"cto__get_tedi_status",
		);
		expect(tools.map((tool) => tool.toolId)).toContain(
			"cto__get_tedi_runtime_status",
		);
		expect(tools.map((tool) => tool.toolId)).not.toContain(
			"cto__run_skill_workflow",
		);
	});

	it("filters requiresContainer collaboration tools off the Agent runtime", () => {
		// Hydrated collaboration surface is the Agent runtime: the bridge
		// subset only, with `requiresContainer` collaboration tools removed.
		const tools = buildAggregateTediTools(
			[
				{
					slug: "echo",
					namespace: "echo",
					surface: "collaboration",
					tediId: "echo-id",
				},
			],
			env,
		);
		const ids = tools.map((tool) => tool.toolId);

		// Bridge collaboration tools remain advertised.
		expect(ids).toContain("echo__ask");
		expect(ids).toContain("echo__memory_search");
		expect(ids).toContain("echo__review_memory_fact");
		expect(ids).toContain("echo__get_tedi_runtime_status");
		// Container-only collaboration tools are gone.
		expect(ids).not.toContain("echo__read_resource");
		expect(ids).not.toContain("echo__get_tedi_status");
	});

	it("hides container diagnostics on the full tedi surface", () => {
		const tools = buildAggregateTediTools(
			[{ slug: "cto", namespace: "cto", runtimeKind: "agent" }],
			env,
		);
		const toolIds = tools.map((tool) => tool.toolId);

		expect(toolIds).not.toContain("cto__get_process_logs");
	});

	it("filters container-only tools out of the isolate surface", () => {
		const isolateTools = buildAggregateTediTools(
			[
				{
					slug: "echo",
					namespace: "echo",
					runtimeKind: "agent",
					tediId: "echo-tedi-id",
				},
			],
			env,
		);
		const containerTools = buildAggregateTediTools(
			[{ slug: "cto", namespace: "cto", runtimeKind: "agent" }],
			env,
		);

		const isolateToolIds = isolateTools.map((tool) => tool.toolId);
		// Isolate-supported bridge tools advertised.
		expect(isolateToolIds).toContain("echo__conversations_list");
		expect(isolateToolIds).toContain("echo__conversation_get");
		expect(isolateToolIds).toContain("echo__run_tedi_turn");
		expect(isolateToolIds).toContain("echo__messages_read");
		expect(isolateToolIds).toContain("echo__synthesize_spoken_reply");
		// rpcEndpoint-backed tools remain runtime-agnostic.
		expect(isolateToolIds).toContain("echo__payments_list_accounts");
		expect(isolateToolIds).toContain("echo__payments_list_reservations");
		expect(isolateToolIds).toContain("echo__email_send");
		expect(isolateToolIds).toContain("echo__get_tedi_runtime_status");
		expect(isolateToolIds).toContain("echo__review_memory_fact");
		expect(isolateToolIds).toContain("echo__run_skill_workflow");
		expect(isolateToolIds).toContain("echo__work_items_list");
		expect(isolateToolIds).not.toContain("echo__record_owned_channel_publish");
		expect(isolateToolIds).toContain("echo__start_work_attempt");
		expect(isolateToolIds).toContain("echo__submit_work_evidence");
		expect(isolateToolIds).toContain("echo__list_work_events");
		expect(isolateToolIds).toContain("echo__harness_versions");
		expect(isolateToolIds).toContain("echo__harness_trace_bundle");
		expect(isolateToolIds).toContain("echo__harness_eval_runs");
		expect(isolateToolIds).toContain("echo__harness_compare");
		expect(isolateToolIds).toContain("echo__cron");
		expect(isolateToolIds).toContain("echo__repo_load");
		expect(isolateToolIds).toContain("echo__clone_repo");
		expect(isolateToolIds).toContain("echo__run_git");
		expect(isolateToolIds).not.toContain("echo__bash");
		expect(isolateToolIds).not.toContain("echo__workspace_snapshot");
		expect(isolateToolIds).toContain("echo__repo_commit");
		expect(isolateToolIds).toContain("echo__repo_commit_drain");
		expect(isolateToolIds).toContain("echo__repo_commit_status");
		expect(isolateToolIds).not.toContain("echo__read_workspace_file");
		expect(isolateToolIds).not.toContain("echo__write_workspace_file");
		expect(isolateToolIds).not.toContain("echo__diff_workspace_content");
		expect(isolateToolIds).not.toContain("echo__apply_workspace_edits");
		expect(isolateToolIds).not.toContain("echo__replace_workspace_text");
		expect(isolateToolIds).not.toContain("echo__validate_workspace_typescript");
		expect(isolateToolIds).not.toContain(
			"echo__validate_workspace_worker_bundle",
		);
		expect(isolateToolIds).toContain("echo__open_computer");
		expect(isolateToolIds).not.toContain("echo__workstation_status");
		expect(isolateToolIds).toContain("echo__exec");
		expect(isolateToolIds).toContain("echo__read_execution");
		expect(isolateToolIds).toContain("echo__cancel_execution");
		expect(isolateToolIds).not.toContain("echo__workstation_start_dev_server");
		expect(isolateToolIds).toContain("echo__close_computer");
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__cron")?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__email_send")?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "tediEmail/sendEmail",
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__start_work_attempt")
				?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "workItems/startAttempt",
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__work_items_list")
				?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "workItems/list",
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__work_items_list")
				?.config,
		).toMatchObject({
			staticParams: { __tedixOmitAggregateTediId: true },
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__work_item_comment")
				?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "workItems/addComment",
			staticParams: {
				authorType: "tedi",
				authorId: "echo-tedi-id",
				tediId: "echo-tedi-id",
			},
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find(
				(tool) => tool.toolId === "echo__heartbeat_work_attempt",
			)?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "workItems/heartbeatAttempt",
		});
		const heartbeatTool = isolateTools.find(
			(tool) => tool.toolId === "echo__heartbeat_work_attempt",
		);
		expect(heartbeatTool?.inputSchema.required).toEqual(["id", "attemptId"]);
		expect(isolateToolIds).not.toContain("echo__get_next_work_item");
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__review_memory_fact")
				?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "memoryGraph/review",
			allowExplicitTediId: false,
			staticParams: { tediId: "echo-tedi-id" },
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__harness_versions")
				?.config,
		).toMatchObject({
			transport: "rpc",
			endpoint: "harness/listHarnessVersions",
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__repo_load")?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			mcpToolName: "repo_load",
			timeout: 300_000,
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__repo_load")
				?.annotations,
		).toMatchObject({ readOnlyHint: true });
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__clone_repo")?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			mcpToolName: "clone_repo",
			timeout: 300_000,
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__clone_repo")
				?.annotations,
		).toMatchObject({ readOnlyHint: false });
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__clone_repo")
				?.inputSchema,
		).toMatchObject({
			properties: {
				depth: { minimum: 1, maximum: 50 },
			},
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__run_git")?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			mcpToolName: "run_git",
			timeout: 300_000,
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__run_git")?.annotations,
		).toMatchObject({ readOnlyHint: false });
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__run_git")?.inputSchema,
		).toMatchObject({
			required: ["args"],
			properties: {
				args: { minItems: 1, maxItems: 64 },
			},
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__repo_commit")?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			mcpToolName: "repo_commit",
			timeout: 300_000,
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__repo_commit_drain")
				?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			mcpToolName: "repo_commit_drain",
			timeout: 300_000,
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__repo_commit_status")
				?.config,
		).toMatchObject({
			transport: "mcp",
			mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
			mcpToolName: "repo_commit_status",
			timeout: 300_000,
			_aggregateTediSlug: "echo",
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__repo_commit_status")
				?.annotations,
		).toMatchObject({ readOnlyHint: true });
		for (const name of [
			"open_computer",
			"close_computer",
			"exec",
			"read_execution",
			"cancel_execution",
			"read",
			"write",
			"edit",
			"delete",
			"ls",
			"find",
			"grep",
		]) {
			const tool = isolateTools.find((tool) => tool.toolId === `echo__${name}`);
			expect(tool?.config).toMatchObject({
				transport: "mcp",
				mcpServerUrl: "https://echo.tedi.tedix.dev/mcp",
				mcpToolName: name,
				_aggregateTediSlug: "echo",
			});
			expect(tool?.config).not.toHaveProperty("responsePath");
		}
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__exec")?.inputSchema,
		).toMatchObject({
			required: ["command"],
			additionalProperties: false,
			properties: {
				command: { type: "string", minLength: 1 },
				timeoutMs: { type: "integer", minimum: 1000, maximum: 21600000 },
			},
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__read_execution")
				?.inputSchema,
		).toMatchObject({
			required: ["executionId"],
			properties: { executionId: { type: "string", minLength: 1 } },
		});
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__open_computer")
				?.inputSchema.properties,
		).toEqual({ repository: { type: "boolean" } });
		expect(
			isolateTools.find((tool) => tool.toolId === "echo__edit")?.inputSchema,
		).toMatchObject({
			required: ["path", "edits"],
			properties: {
				edits: {
					type: "array",
					items: {
						required: ["oldText", "newText"],
						additionalProperties: false,
					},
				},
			},
		});
		// Container-only tools must not be advertised on isolate.
		expect(isolateToolIds).not.toContain("echo__browser_session_start");
		expect(isolateToolIds).not.toContain("echo__attachments_fetch");
		expect(isolateToolIds).not.toContain("echo__memory_learn");
		expect(isolateToolIds).not.toContain("echo__write_rationale");
		const containerToolIds = containerTools.map((tool) => tool.toolId);
		expect(containerToolIds).not.toContain("cto__get_process_logs");
	});

	it("hydrates a null runtime kind as the Agent runtime, not legacy container", () => {
		// runtime_kind is notNull/default 'isolate' in D1, but an unhydrated
		// aggregate entry can carry an undefined kind. It must default to the
		// Agent runtime so container-only tools stay hidden — never to legacy.
		const hydratedTools = buildAggregateTediTools(
			[{ slug: "echo", namespace: "echo" }],
			env,
		);
		const explicitIsolateTools = buildAggregateTediTools(
			[{ slug: "echo", namespace: "echo", runtimeKind: "agent" }],
			env,
		);

		const hydratedIds = hydratedTools.map((tool) => tool.toolId).sort();
		const isolateIds = explicitIsolateTools.map((tool) => tool.toolId).sort();
		expect(hydratedIds).toEqual(isolateIds);
		// Container-only (`requiresContainer`) tools must not leak onto the
		// default Agent surface.
		expect(hydratedIds).not.toContain("echo__get_process_logs");
	});

	it("hides container-only tools even for agent rows", () => {
		const agentTools = buildAggregateTediTools(
			[{ slug: "cmo", namespace: "cmo", runtimeKind: "agent" }],
			env,
		);
		const agentIds = agentTools.map((tool) => tool.toolId);
		expect(agentIds).not.toContain("cmo__get_process_logs");
	});

	it("transient-API-failure fallback does not expose container tools", async () => {
		// When apps/api is briefly unavailable (binding present, fetch throws),
		// hydrateAggregateRuntimeKinds cannot read the authoritative runtime_kind.
		// It falls back to the Agent runtime and container tools stay hidden.
		const throwingApiEnv = envWithRuntimeMeta(() => {
			throw new Error("transient API outage");
		});
		const fallbackEntries = await hydrateAggregateRuntimeKinds(
			[{ slug: "cmo", namespace: "cmo" }],
			throwingApiEnv,
		);
		expect(fallbackEntries.every((e) => e.runtimeKind === "agent")).toBe(true);
		const fallbackToolIds = buildAggregateTediTools(fallbackEntries, env).map(
			(tool) => tool.toolId,
		);
		expect(fallbackToolIds).not.toContain("cmo__get_process_logs");
		expect(fallbackToolIds).not.toContain("cmo__run_skill_workflow");
		expect(fallbackToolIds).not.toContain(
			"cmo__get_skill_workflow_reliability",
		);
		expect(fallbackToolIds).toContain("cmo__run_tedi_turn");

		// Contrast: a normally-hydrated Agent tedi also does not advertise
		// container-only tools.
		const isolateToolIds = buildAggregateTediTools(
			[{ slug: "echo", namespace: "echo", runtimeKind: "agent" }],
			env,
		).map((tool) => tool.toolId);
		expect(isolateToolIds).not.toContain("echo__get_process_logs");
	});

	it("wraps role tool params for the upstream tedi code tool", () => {
		const invocation = buildTediCodeInvocation("run_tedi_turn", {
			session_key: "agent:main:main",
			text: "hello",
		});

		expect(invocation).toContain(
			'async () => await codemode.run_tedi_turn({"session_key":"agent:main:main","text":"hello","client_request_id":"',
		);
	});
});

describe("aggregate Work Item write tools are fail-closed without the write scope", () => {
	const tools = buildAggregateTediTools(
		[
			{
				slug: "cto",
				namespace: "cto",
				runtimeKind: "agent",
				tediId: "cto-id",
			},
		],
		env,
	);
	const byId = new Map(tools.map((tool) => [tool.toolId, tool]));
	const SINGLE_WRITES = [
		"cto__create_work_item",
		"cto__update_work_item",
		"cto__cancel_work_item",
	];

	it("resolves targeted Work Item writes to the Work capability", () => {
		const expectedScopes: Record<string, string> = {
			cto__create_work_item: "mcp:work.write",
			cto__update_work_item: "mcp:work.write",
			cto__cancel_work_item: "mcp:work.admin",
		};
		for (const id of SINGLE_WRITES) {
			const tool = byId.get(id);
			expect(tool, id).toBeDefined();
			const required = resolveMcpToolRequiredScopes(tool!, "cto", undefined);
			expect(required, id).toEqual([expectedScopes[id]]);
		}
	});

	it("denies a scopeless caller and admits one holding the resolved scope (service transport bypasses)", () => {
		for (const id of SINGLE_WRITES) {
			const tool = byId.get(id)!;
			const [scope] = resolveMcpToolRequiredScopes(tool, "cto", undefined);
			// Authenticated but scopeless → fail-closed.
			expect(
				isMcpToolVisibleToCaller(tool, "cto", undefined, {
					authType: "oauth",
					scopes: [],
				}),
				id,
			).toBe(false);
			// Holds the resolved write scope → admitted.
			expect(
				isMcpToolVisibleToCaller(tool, "cto", undefined, {
					authType: "oauth",
					scopes: [scope!],
				}),
				id,
			).toBe(true);
			// Trusted service-binding transport bypasses the scope gate.
			expect(
				isMcpToolVisibleToCaller(tool, "cto", undefined, {
					authType: "service",
				}),
				id,
			).toBe(true);
		}
	});
});

describe("hydrateAggregateRuntimeKinds — runtime-meta via apps/api binding", () => {
	const activeRow = (slug: string): RuntimeMetaRow => ({
		slug,
		id: `id-${slug}`,
		organizationId: `org-${slug}`,
		runtimeKind: "agent",
		runtimeState: "active",
		status: "active",
	});

	it("hydrates tediId / organizationId / runtimeKind from the endpoint", async () => {
		const hydrated = await hydrateAggregateRuntimeKinds(
			[{ slug: "cto", namespace: "cto" }],
			envWithRuntimeMeta((slugs) => slugs.map(activeRow)),
		);
		expect(hydrated).toEqual([
			{
				slug: "cto",
				namespace: "cto",
				tediId: "id-cto",
				organizationId: "org-cto",
				runtimeKind: "agent",
			},
		]);
	});

	it("drops archived / paused / error / provisioning tedis from the surface", async () => {
		const hydrated = await hydrateAggregateRuntimeKinds(
			[
				{ slug: "ok", namespace: "ok" },
				{ slug: "archived", namespace: "archived" },
				{ slug: "paused", namespace: "paused" },
				{ slug: "error", namespace: "error" },
				{ slug: "provisioning", namespace: "provisioning" },
			],
			envWithRuntimeMeta(() => [
				activeRow("ok"),
				{ ...activeRow("archived"), runtimeState: "archived" },
				{ ...activeRow("paused"), status: "paused" },
				{ ...activeRow("error"), status: "error" },
				{ ...activeRow("provisioning"), status: "provisioning" },
			]),
		);
		expect(hydrated.map((e) => e.slug)).toEqual(["ok"]);
	});

	it("keeps a slug with no matching row un-hydrated (not dropped)", async () => {
		const hydrated = await hydrateAggregateRuntimeKinds(
			[{ slug: "ghost", namespace: "ghost" }],
			envWithRuntimeMeta(() => []),
		);
		expect(hydrated).toEqual([{ slug: "ghost", namespace: "ghost" }]);
		expect(hydrated[0]?.tediId).toBeUndefined();
	});

	it("non-ok API response stamps every entry agent and drops nothing (fail-safe)", async () => {
		const hydrated = await hydrateAggregateRuntimeKinds(
			[
				{ slug: "a", namespace: "a" },
				{ slug: "b", namespace: "b" },
			],
			envWithRuntimeMeta(() => [], { status: 503 }),
		);
		expect(hydrated).toEqual([
			{ slug: "a", namespace: "a", runtimeKind: "agent" },
			{ slug: "b", namespace: "b", runtimeKind: "agent" },
		]);
	});

	it("a thrown fetch stamps every entry agent (transient outage)", async () => {
		const hydrated = await hydrateAggregateRuntimeKinds(
			[{ slug: "a", namespace: "a" }],
			envWithRuntimeMeta(() => {
				throw new Error("boom");
			}),
		);
		expect(hydrated).toEqual([
			{ slug: "a", namespace: "a", runtimeKind: "agent" },
		]);
	});

	it("no API_SERVICE binding leaves entries unmodified (permanent/dev case)", async () => {
		const entries = [{ slug: "a", namespace: "a" }];
		const hydrated = await hydrateAggregateRuntimeKinds(entries, {
			MCP_URL: "https://mcp.tedix.dev",
		} as CloudflareEnv);
		expect(hydrated).toEqual(entries);
		expect(hydrated[0]?.runtimeKind).toBeUndefined();
	});

	it("tolerates an enum-drifted runtime kind (hydrates identity, no kind override)", async () => {
		// A legacy/drifted row (runtime_kind not "agent") must not poison the batch:
		// identity still hydrates; runtimeKind is left unset (matching the old
		// `row.runtimeKind === "agent" ? … : {}`), so it is not advertised as agent.
		const hydrated = await hydrateAggregateRuntimeKinds(
			[{ slug: "legacy", namespace: "legacy" }],
			envWithRuntimeMeta(() => [
				{ ...activeRow("legacy"), runtimeKind: "isolate" },
			]),
		);
		expect(hydrated).toEqual([
			{
				slug: "legacy",
				namespace: "legacy",
				tediId: "id-legacy",
				organizationId: "org-legacy",
			},
		]);
	});

	it("excludes empty slugs from the batch without poisoning valid entries", async () => {
		// One bad metadata row (empty slug) must not 400 the batch (the endpoint
		// requires z.string().min(1)) and fail-open the whole surface: valid
		// entries still hydrate, the empty-slug entry passes through un-hydrated,
		// and inactive valid tedis are still dropped.
		const batches: string[][] = [];
		const hydrated = await hydrateAggregateRuntimeKinds(
			[
				{ slug: "", namespace: "blank" },
				{ slug: "ok", namespace: "ok" },
				{ slug: "retired", namespace: "retired" },
			],
			envWithRuntimeMeta((slugs) => {
				batches.push(slugs);
				return [
					activeRow("ok"),
					{ ...activeRow("retired"), runtimeState: "archived" },
				];
			}),
		);
		expect(batches).toEqual([["ok", "retired"]]);
		expect(hydrated).toEqual([
			{ slug: "", namespace: "blank" },
			{
				slug: "ok",
				namespace: "ok",
				tediId: "id-ok",
				organizationId: "org-ok",
				runtimeKind: "agent",
			},
		]);
	});

	it("skips the fetch entirely when every slug is empty (entries unmodified)", async () => {
		let called = false;
		const entries = [
			{ slug: "", namespace: "a" },
			{ slug: "", namespace: "b" },
		];
		const hydrated = await hydrateAggregateRuntimeKinds(
			entries,
			envWithRuntimeMeta(() => {
				called = true;
				return [];
			}),
		);
		expect(called).toBe(false);
		expect(hydrated).toEqual(entries);
		expect(hydrated[0]?.runtimeKind).toBeUndefined();
	});

	it("chunks a >200-slug surface into multiple requests and hydrates all", async () => {
		const many = Array.from({ length: 250 }, (_, i) => `t${i}`);
		const batches: string[][] = [];
		const hydrated = await hydrateAggregateRuntimeKinds(
			many.map((s) => ({ slug: s, namespace: s })),
			envWithRuntimeMeta((slugs) => {
				batches.push(slugs);
				return slugs.map(activeRow);
			}),
		);
		expect(batches.length).toBe(2);
		expect(batches[0]?.length).toBe(200);
		expect(batches[1]?.length).toBe(50);
		expect(hydrated).toHaveLength(250);
		expect(hydrated.every((e) => e.runtimeKind === "agent")).toBe(true);
	});
});

describe("aggregate skill workflow chat widgets", () => {
	const tools = buildAggregateTediTools(
		[
			{
				slug: "cto",
				namespace: "cto",
				runtimeKind: "agent",
				tediId: "cto-id",
			},
		],
		env,
	);
	const byId = new Map(tools.map((tool) => [tool.toolId, tool]));

	function widgetTool(toolId: string, layoutId: string) {
		const tool = byId.get(toolId);
		expect(tool, toolId).toBeDefined();
		expect(tool).toMatchObject({
			widgetKey: "render",
			widgetRoute: `/r/${layoutId}`,
			widgetAccessible: true,
			widgetDescription: expect.any(String),
			outputTemplate: `ui://widgets/apps-sdk/tedix-unified/r/${layoutId}.html`,
		});
		const config = tool!.config as Record<string, unknown>;
		expect(config.layoutId, toolId).toBe(layoutId);
		const layoutSpec = config.layoutSpec as Record<string, unknown>;
		expect(layoutSpec, toolId).toMatchObject({
			root: expect.any(String),
			elements: expect.any(Object),
		});
		return layoutSpec;
	}

	/** Collect every `{ $state: "..." }` pointer anywhere in a layout spec. */
	function collectStatePointers(node: unknown, found: string[] = []): string[] {
		if (Array.isArray(node)) {
			for (const item of node) collectStatePointers(item, found);
			return found;
		}
		if (node == null || typeof node !== "object") return found;
		const record = node as Record<string, unknown>;
		if (typeof record.$state === "string") found.push(record.$state);
		for (const value of Object.values(record)) {
			collectStatePointers(value, found);
		}
		return found;
	}

	it("attaches structurally valid render layouts (same validator as ui.validate_layout)", () => {
		for (const [toolId, layoutId] of [
			["cto__get_rationale_chain", "rationale-chain"],
			["cto__get_skill_workflow_status", "skill-workflow-run-status"],
			["cto__list_skill_workflow_history", "skill-workflow-history"],
		] as const) {
			const layoutSpec = widgetTool(toolId, layoutId);
			const result = validateSpec(layoutSpec as never, { checkOrphans: true });
			expect(result.issues, toolId).toEqual([]);
			expect(result.valid, toolId).toBe(true);
		}
	});

	it("binds the history widget only to real runWorkflowHistory fields", () => {
		const layoutSpec = widgetTool(
			"cto__list_skill_workflow_history",
			"skill-workflow-history",
		);
		const elements = layoutSpec.elements as Record<
			string,
			{ props?: Record<string, unknown> }
		>;
		const runsProps = elements.runs?.props as {
			data?: unknown;
			columns?: Array<{ field: string }>;
		};
		// The table binds the contract's `runs` array...
		expect(runsProps?.data).toEqual({ $state: "/json/runs" });
		// ...and every column is a real SkillRunSummary field.
		const summaryFields = Object.keys(SkillRunSummarySchema.shape);
		expect(runsProps?.columns?.map((column) => column.field)).toEqual([
			"skillSlug",
			"status",
			"startedAt",
			"completedAt",
		]);
		for (const column of runsProps?.columns ?? []) {
			expect(summaryFields, column.field).toContain(column.field);
		}
	});

	it("binds the status widget only to real SkillRun fields", () => {
		const layoutSpec = widgetTool(
			"cto__get_skill_workflow_status",
			"skill-workflow-run-status",
		);
		const pointers = collectStatePointers(layoutSpec);
		expect(pointers).toContain("/json/status");
		const runFields = Object.keys(SkillRunSchema.shape);
		for (const pointer of pointers) {
			expect(pointer).toMatch(/^\/json\//);
			const field = pointer.split("/")[2];
			expect(runFields, pointer).toContain(field);
		}
	});
});
