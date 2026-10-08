import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { withCompletionEvidence } from "@tedix/api-contract/schemas/execution-evidence";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TedixHomeClient } from "./home-client";
import type { WorkAttemptKey, WorkAttemptStore } from "./work-attempt-store";
import {
	attemptSessionLabel,
	boardErrorFromValue,
	contextBriefJson,
	expiresToIso,
	filterEvidenceRows,
	principalLabel,
	renderWorkAttemptsTable,
	renderWorkEventsTable,
	renderWorkEvidenceTable,
	renderWorkItemsTable,
	runWork,
	WORK_EXIT_FAIL,
	type WorkContext,
	type WorkOptions,
	workUsage,
	buildAcceptanceContract,
	buildSettlementMetadata,
	workVerbNames,
} from "./work";
import { detachedGitEnv } from "../../../scripts/oss/git-env";

const ITEM = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

const TEST_ORG = "99999999-9999-4999-8999-999999999999";
const TEST_ENDPOINTS: Record<string, string> = {
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
function nativeDescriptorFixture(callable: string) {
	const tool = callable.slice(callable.indexOf(".") + 1);
	return {
		name: `configured_${callable.replace(".", "__")}`,
		toolRowId: `row-${tool}`,
		endpoint: TEST_ENDPOINTS[tool] ?? "unknown",
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: "orpc",
			sourceRef: TEST_ENDPOINTS[tool] ?? "unknown",
			sourceHash: "fixture-hash",
			syncedAt: "2026-10-07T12:00:00Z",
		},
	};
}
function nativeBootstrapFixture() {
	const catalog = (name: string, endpoint: string) => ({
		...nativeDescriptorFixture(name),
		name,
		endpoint,
		schemaFreshness: {
			source: "catalog",
			sourceRef: endpoint,
			sourceHash: "fixture-hash",
			syncedAt: "2026-10-07T12:00:00Z",
		},
	});
	return {
		nativeContext: {
			version: 1,
			surface: "mcp-gateway",
			appId: "fixture-app",
			appSlug: "fixture",
			organizationId: TEST_ORG,
			actor: { authType: "user" },
			nativeTransportAvailable: true,
		},
		nativeCatalog: {
			status: "usable",
			search: catalog("catalog_search", "catalog/search"),
			describe: catalog("catalog_describe", "catalog/describe"),
		},
	};
}

describe("coding-host Work handoff", () => {
	test("previews an accepted item without launching or mutating Work", async () => {
		const { ctx, sources } = makeContext({ host: "codex" }, undefined, () => ({
			workItem: { id: ITEM, disposition: "accepted" },
		}));
		const result = await capture(`handoff ${ITEM}`, ctx);
		expect(result.code).toBe(0);
		const preview = JSON.parse(result.out[0]!);
		expect(preview.command).toContain("codex --no-daemon -C");
		expect(preview.command).toContain(
			"env -u TEDIX_AGENT_SESSION -u TEDIX_EXTERNAL_AGENT",
		);
		expect(preview.command).toContain(`TEDIX_WORK_ITEM_ID=${ITEM}`);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toContain("get_work_items_by_id");
	});

	test("launches Codex without the shared daemon for SessionStart", async () => {
		const { ctx } = makeContext(
			{ host: "codex", launch: true },
			undefined,
			() => ({ workItem: { id: ITEM, disposition: "accepted" } }),
		);
		ctx.launchHost = (host, args, env) => {
			expect(host).toBe("codex");
			expect(args.slice(0, 2)).toEqual(["--no-daemon", "-C"]);
			expect(args[2]).toBe(process.cwd());
			expect(args[3]).toContain(`Work Item ${ITEM}`);
			expect(env.TEDIX_PLUGIN_PREFLIGHT).toBe("1");
			expect(env.TEDIX_WORK_ITEM_ID).toBe(ITEM);
			expect(env.TEDIX_AGENT_SESSION).toBeUndefined();
			expect(env.TEDIX_EXTERNAL_AGENT).toBeUndefined();
			return 0;
		};
		expect(await runWork(`handoff ${ITEM}`, ctx)).toBe(0);
	});

	test("launches Claude with fresh context and no inherited executor credential", async () => {
		const { ctx } = makeContext(
			{ host: "claude", launch: true },
			undefined,
			() => ({ workItem: { id: ITEM, disposition: "accepted" } }),
		);
		let launched = false;
		ctx.launchHost = (host, args, env) => {
			launched = true;
			expect(host).toBe("claude");
			expect(args[0]).toContain(`Work Item ${ITEM}`);
			expect(env.TEDIX_PLUGIN_PREFLIGHT).toBe("1");
			expect(env.TEDIX_WORK_ITEM_ID).toBe(ITEM);
			expect(env.TEDIX_AGENT_SESSION).toBeUndefined();
			expect(env.TEDIX_EXTERNAL_AGENT).toBeUndefined();
			expect(env.TEDIX_MCP_BEARER_TOKEN).toBeUndefined();
			expect(env.TEDIX_MCP_API_KEY).toBeUndefined();
			return 0;
		};
		const prior = process.env.TEDIX_EXTERNAL_AGENT;
		process.env.TEDIX_EXTERNAL_AGENT = "parent-principal";
		try {
			expect(await runWork(`handoff ${ITEM}`, ctx)).toBe(0);
		} finally {
			if (prior === undefined) delete process.env.TEDIX_EXTERNAL_AGENT;
			else process.env.TEDIX_EXTERNAL_AGENT = prior;
		}
		expect(launched).toBe(true);
	});

	test("refuses terminal items and flags on other verbs", async () => {
		const terminal = makeContext(
			{ host: "codex", launch: true },
			undefined,
			() => ({ workItem: { id: ITEM, disposition: "completed" } }),
		);
		await expect(runWork(`handoff ${ITEM}`, terminal.ctx)).rejects.toThrow(
			"accepted",
		);
		await expect(runWork(`context ${ITEM}`, terminal.ctx)).rejects.toThrow(
			"only valid",
		);
	});
});

function makeContext(
	work: WorkOptions = {},
	activeAttempt?: string,
	respond?: (source: string) => unknown,
	settings: { json?: boolean; authSource?: string } = {},
) {
	const sources: string[] = [];
	const attempts = new Map<string, string>();
	const key = (value: WorkAttemptKey) => JSON.stringify(value);
	const attemptStore: WorkAttemptStore = {
		get: (value) => attempts.get(key(value)) ?? null,
		set: (value, attemptId) => attempts.set(key(value), attemptId),
		remove: (value, attemptId) =>
			attempts.get(key(value)) === attemptId && attempts.delete(key(value)),
	};
	const session = "codex:33333333-3333-4333-8333-333333333333";
	const options = { session, ...work };
	if (activeAttempt)
		attemptStore.set(
			{
				workspace: "test",
				actor: options.as ?? "credential",
				agentSession: session,
				workItemId: ITEM,
			},
			activeAttempt,
		);
	const nativeCalls: Array<{
		name: string;
		args: Record<string, unknown>;
		options: unknown;
	}> = [];
	const descriptors = new Map<
		string,
		ReturnType<typeof nativeDescriptorFixture>
	>();
	const invoke = async (
		name: string,
		args: Record<string, unknown>,
		callOptions: unknown,
	) => {
		nativeCalls.push({ name, args, options: callOptions });
		if (name === "get_info") return nativeBootstrapFixture();
		if (name === "catalog_search") {
			const callable = `${args.namespace}.${args.query}`;
			const descriptor = nativeDescriptorFixture(callable);
			descriptors.set(descriptor.name, descriptor);
			return { results: [{ callable, authorized: true, native: descriptor }] };
		}
		if (name === "catalog_describe") {
			const callable = String(args.callable);
			const native = nativeDescriptorFixture(callable);
			return {
				callable,
				authorized: true,
				native,
				schemaFreshness: native.schemaFreshness,
				parameters: { type: "object", additionalProperties: true },
				outputSchema: {},
			};
		}
		const descriptor = descriptors.get(name);
		if (!descriptor) throw new Error(`Unresolved native fixture tool ${name}`);
		const callable = name.slice("configured_".length).replace("__", ".");
		const source = `${callable}(${JSON.stringify(args)})`;
		sources.push(source);
		let result = respond
			? await respond(source)
			: source.includes("start_work_item_attempt") ||
				  source.includes("start_work_attempt")
				? { attempt: { id: ATTEMPT, externalSessionKey: session } }
				: { id: ITEM };
		if (
			callable.endsWith("list_work_item_cli_rows") &&
			!boardErrorFromValue(result) &&
			!(result as Record<string, unknown>)?.__tedix_truncated
		) {
			const page = result as Record<string, unknown>;
			const data = Array.isArray(page?.data) ? page.data : [];
			result = {
				view: args.view,
				data,
				pagination: page?.pagination ?? {
					limit: args.limit,
					offset: args.offset ?? 0,
					total: data.length,
					hasMore: false,
				},
			};
		}
		if (
			callable.endsWith("get_work_item_checkpoint") &&
			(result as Record<string, unknown>)?.workItem
		)
			result = (result as Record<string, unknown>).workItem;
		if (
			callable.endsWith("list_work_event_cli_rows") &&
			(result as Record<string, unknown>)?.data
		) {
			const page = result as Record<string, unknown>;
			result = { events: page.data, nextSequence: page.next ?? null };
		}
		if (result && typeof result === "object" && !boardErrorFromValue(result)) {
			if (callable.endsWith("get_work_item_checkpoint"))
				result = { disposition: "accepted", ...(result as object) };
			if (/list_work_(attempt|evidence)_cli_rows$/.test(callable))
				result = { nextCursor: null, ...(result as object) };
			if (callable.endsWith("list_work_interaction_cli_rows") && !respond)
				result = {
					data: [],
					nextCursor: null,
					hasMore: false,
					observedAt: "2026-10-07T12:00:00Z",
				};
			const page = result as Record<string, unknown>;
			if (
				callable.endsWith("list_work_item_cli_rows") &&
				Array.isArray(page.data)
			)
				page.data = page.data.map((row) => ({
					workKind: "coding",
					disposition: "proposed",
					riskLevel: "low",
					priority: "medium",
					projectId: null,
					createdAt: "2026-10-07T12:00:00Z",
					...(args.view === "board" ? { activeAttempt: null } : {}),
					...(row as object),
				}));
			if (
				callable.endsWith("list_work_evidence_cli_rows") &&
				Array.isArray(page.data)
			)
				page.data = page.data.map((row) => ({
					label: null,
					attemptId: null,
					submittedByType: "user",
					submittedById: "fixture-user",
					submittedAt: "2026-10-07T12:00:00Z",
					reviewedByType: null,
					reviewedById: null,
					reviewedAt: null,
					reviewReason: null,
					...(row as object),
				}));
			if (
				callable.endsWith("list_work_attempt_cli_rows") &&
				Array.isArray(page.data)
			)
				page.data = page.data.map((row) => ({
					externalSessionKey: null,
					expiresAt: null,
					finishedAt: null,
					summary: null,
					...(row as object),
				}));
			if (
				callable.endsWith("list_work_interaction_cli_rows") &&
				Array.isArray(page.data)
			)
				page.data = page.data.map((row) => {
					const r = row as Record<string, unknown>;
					if (!r.request || typeof r.request !== "object") return row;
					const request = r.request as Record<string, unknown>;
					return {
						canCancel: false,
						workItem: null,
						responseCount: 0,
						...r,
						request: {
							subject: "Example request",
							version: 1,
							caseId: null,
							projectId: null,
							kind: "coordination",
							requestedFromType: "user",
							requestedFromId: "fixture-user",
							creatorType: "user",
							creatorId: "fixture-user",
							creatorSessionId: null,
							state: "open",
							requestedAt: "2026-10-07T12:00:00Z",
							dueAt: null,
							expiresAt: null,
							resolvedAt: null,
							...request,
							prompt:
								typeof request.prompt === "string"
									? request.prompt.slice(0, 800)
									: (request.prompt ?? "Example prompt"),
							promptComplete:
								request.promptComplete === true &&
								typeof request.prompt === "string" &&
								request.prompt.length <= 800,
						},
					};
				});
		}
		return result;
	};
	const client = {
		callTool: invoke,
		callToolWithDestructiveApproval: (
			name: string,
			args: Record<string, unknown>,
			_reason: string,
			options: unknown,
		) => invoke(name, args, options),
		getTimeoutMs: () => 60_000,
	} as unknown as TedixHomeClient;
	const ctx: WorkContext = {
		client,
		color: { enabled: false },
		json: settings.json ?? true,
		workspace: "test",
		mcpUrl: "https://tenant.example/mcp",
		organizationId: TEST_ORG,
		authSource: settings.authSource,
		attemptStore,
		work: options,
	};
	return { ctx, sources, attemptStore, nativeCalls };
}

async function capture(
	args: string,
	ctx: WorkContext,
): Promise<{ code: number; out: string[]; err: string[] }> {
	const out: string[] = [];
	const err: string[] = [];
	const priorLog = console.log;
	const priorError = console.error;
	console.log = (...values: unknown[]) =>
		out.push(values.map(String).join(" "));
	console.error = (...values: unknown[]) =>
		err.push(values.map(String).join(" "));
	try {
		return { code: await runWork(args, ctx), out, err };
	} finally {
		console.log = priorLog;
		console.error = priorError;
	}
}

describe("claim-files command", () => {
	test("rejects invalid paths, extra positional arguments, --input, and impersonation before gateway calls", async () => {
		for (const work of [
			{ paths: ["../a.ts"] },
			{ repoKey: "" },
			{ paths: [] },
			{ input: "{}" },
			{ as: "cto" },
		]) {
			const { ctx, sources } = makeContext({
				repoKey: "tedix",
				paths: ["src/a.ts"],
				...work,
			});
			await expect(runWork(`claim-files ${ITEM}`, ctx)).rejects.toThrow();
			expect(sources).toEqual([]);
		}
		const { ctx, sources } = makeContext({
			repoKey: "tedix",
			paths: ["src/a.ts"],
		});
		await expect(
			runWork(`claim-files ${ITEM} another.ts`, ctx),
		).rejects.toThrow();
		expect(sources).toEqual([]);
		await expect(runWork(`start ${ITEM}`, ctx)).rejects.toThrow("only valid");
	});

	test("uses credential-bound native tools and preserves gateway authority errors", async () => {
		const { ctx, sources } = makeContext(
			{ repoKey: "tedix", paths: ["src/a.ts"] },
			undefined,
			() => ({
				defined: true,
				code: "FORBIDDEN",
				status: 403,
				message: "owner/admin required",
			}),
		);
		const result = await capture(`claim-files ${ITEM}`, ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			error: { code: "FORBIDDEN", status: 403 },
		});
		expect(sources).toHaveLength(1);
		expect(sources[0]).toContain("work.get_work_admission_specification");
	});

	test("gateway-enriched failures and truncation remain errors before admission parsing", async () => {
		for (const [value, code] of [
			[
				{
					defined: true,
					code: "FORBIDDEN",
					status: 403,
					message: "owner/admin required",
				},
				"FORBIDDEN",
			],
			[{ ok: false, error: "scope denied" }, "GATEWAY_REJECTED"],
			[
				{
					__tedix_truncated: true,
					preview: "{}",
					guidance: "Paginate this result",
				},
				"RESULT_TRUNCATED",
			],
		] as const) {
			const { ctx, sources } = makeContext(
				{ repoKey: "tedix", paths: ["src/a.ts"] },
				undefined,
				() => withCompletionEvidence("get_work_admission_specification", value),
			);
			const result = await capture(`claim-files ${ITEM}`, ctx);
			expect(result.code).toBe(WORK_EXIT_FAIL);
			expect(JSON.parse(result.out[0]!)).toMatchObject({
				error: { code, replacementAttempted: false, createdResourceKeys: [] },
			});
			expect(sources).toHaveLength(1);
		}
	});

	test("human and JSON no-op output distinguish declared requirements from reservations", async () => {
		for (const json of [true, false]) {
			const { ctx, sources } = makeContext(
				{ repoKey: "tedix", paths: ["src/a.ts"] },
				undefined,
				(source) =>
					source.includes("list_work_resource_pools")
						? {
								data: [
									{
										pool: {
											id: ITEM,
											orgId: ITEM,
											resourceKey: "file:tedix:src/a.ts",
											allocationMode: "exclusive",
											capacity: 1,
											ownerRef: null,
											createdAt: "2026-09-19T00:00:00Z",
											updatedAt: null,
											version: 1,
										},
										activeReserved: 0,
										effectiveAvailable: 1,
									},
								],
								nextCursor: null,
							}
						: {
								workItemId: ITEM,
								workItemVersion: 7,
								admissionSpecRevision: "rev-1",
								resources: [
									{ resourceKey: "file:tedix:src/a.ts", quantity: 1 },
								],
								budget: null,
							},
				{ json },
			);
			const result = await capture(`claim-files ${ITEM}`, ctx);
			expect(result.code).toBe(0);
			expect(sources).toHaveLength(2);
			expect(sources[1]).toContain('"resourceKey":"file:tedix:src/a.ts"');
			expect(sources[1]).toContain('"limit":1');
			expect(sources[1]).not.toContain('"cursor"');
			if (json)
				expect(JSON.parse(result.out[0]!)).toMatchObject({
					changed: false,
					reservation: "at_work_start",
				});
			else
				expect(result.out[0]).toContain(
					"Already declared 1 file requirement(s)",
				);
		}
	});
});

describe("canonical work lifecycle", () => {
	test("exports only attempt/evidence lifecycle verbs", () => {
		const verbs = workVerbNames();
		for (const verb of [
			"accept",
			"readiness",
			"start",
			"heartbeat",
			"settle",
			"submit-evidence",
			"evidence",
			"complete",
			"cancel",
		])
			expect(verbs).toContain(verb);
		for (const legacy of [
			"claim",
			"release",
			"review",
			// Retired with the review plane: there is no reviewer to decide a
			// row any more (decisions/minimal-gates-over-pre-proof.md).
			"review-evidence",
			"done",
			"next",
			"plan",
			"authorize-git",
			"repair-git",
		])
			expect(verbs).not.toContain(legacy);
		expect(verbs).toContain("clusters");
	});

	test("watches the original Attempt serially until the bounded horizon", async () => {
		let now = Date.parse("2026-08-28T18:00:00Z");
		const { ctx, sources } = makeContext({ watch: 65 }, ATTEMPT, () => ({
			expiresAt: new Date(now + 300_000).toISOString(),
		}));
		ctx.heartbeatClock = {
			now: () => now,
			wait: async (ms) => {
				now += ms;
			},
		};
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(0);
		expect(sources).toHaveLength(3);
		for (const source of sources) {
			expect(source).toContain("work.heartbeat_work_item_attempt");
			expect(source).toContain(ATTEMPT);
			expect(source).not.toContain("start_work_item_attempt");
		}
	});

	test("watch stops without touching a replacement cached Attempt", async () => {
		let now = 0;
		const { ctx, sources, attemptStore } = makeContext(
			{ watch: 65 },
			ATTEMPT,
			() => ({ expiresAt: new Date(now + 300_000).toISOString() }),
		);
		const key = {
			workspace: "test",
			actor: "credential",
			agentSession: ctx.work.session!,
			workItemId: ITEM,
		};
		ctx.heartbeatClock = {
			now: () => now,
			wait: async (ms) => {
				now += ms;
				attemptStore.set(key, "replacement");
			},
		};
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(sources).toHaveLength(1);
		expect(attemptStore.get(key)).toBe("replacement");
	});

	test("watch stops on gateway failure without retrying or clearing the fence", async () => {
		const { ctx, sources, attemptStore } = makeContext(
			{ watch: 65 },
			ATTEMPT,
			() => ({
				code: "SERVICE_UNAVAILABLE",
				status: 503,
				message: "unavailable",
			}),
		);
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(sources).toHaveLength(1);
		expect(
			attemptStore.get({
				workspace: "test",
				actor: "credential",
				agentSession: ctx.work.session!,
				workItemId: ITEM,
			}),
		).toBe(ATTEMPT);
	});

	test("watch requires a future server expiry", async () => {
		for (const value of [
			{},
			{ expiresAt: "invalid" },
			{ expiresAt: "1970-01-01T00:00:00Z" },
		]) {
			const { ctx, sources } = makeContext({ watch: 65 }, ATTEMPT, () => value);
			expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(
				WORK_EXIT_FAIL,
			);
			expect(sources).toHaveLength(1);
		}
	});

	test("watch rejects invalid horizons and unrelated verbs before any call", async () => {
		for (const watch of [0, -1, 3601, 1.5, NaN]) {
			const { ctx, sources } = makeContext({ watch }, ATTEMPT);
			await expect(runWork(`heartbeat ${ITEM}`, ctx)).rejects.toThrow("1–3600");
			expect(sources).toHaveLength(0);
		}
		const { ctx, sources } = makeContext({ watch: 30 }, ATTEMPT);
		await expect(runWork(`start ${ITEM}`, ctx)).rejects.toThrow(
			"only valid with work heartbeat",
		);
		expect(sources).toHaveLength(0);
	});

	test("starts and persists a fenced attempt", async () => {
		const { ctx, sources, attemptStore } = makeContext();
		expect(await runWork(`start ${ITEM}`, ctx)).toBe(0);
		expect(sources[0]).toContain("work.start_work_item_attempt");
		expect(
			attemptStore.get({
				workspace: "test",
				actor: "credential",
				agentSession: ctx.work.session!,
				workItemId: ITEM,
			}),
		).toBe(ATTEMPT);
	});

	test("provisions a worktree only after the server returns an Attempt", async () => {
		const provisioned: unknown[] = [];
		const { ctx, sources } = makeContext({ worktree: true });
		ctx.provisionWorktree = (request) => {
			provisioned.push(request);
			return {
				path: "/tmp/worktree",
				branch: "codex/work-test",
				reused: false,
			};
		};
		expect(await runWork(`start ${ITEM}`, ctx)).toBe(0);
		expect(sources[0]).toContain("work.start_work_item_attempt");
		expect(provisioned).toEqual([
			expect.objectContaining({ workItemId: ITEM, attemptId: ATTEMPT }),
		]);
	});

	test("does not provision when admission fails", async () => {
		const fixture = makeContext({ worktree: true }, undefined, () => ({
			defined: true,
			code: "CONFLICT",
			status: 409,
			message: "busy",
		}));
		fixture.ctx.provisionWorktree = () => {
			throw new Error("must not run");
		};
		expect(await runWork(`start ${ITEM}`, fixture.ctx)).toBe(2);
	});

	test("start reports the reason admission actually gave, not a live attempt", async () => {
		// Admission answers CONFLICT for a reserved resource key, a stale
		// specification revision and an exhausted budget as well as for a live
		// attempt. Printing the live-attempt sentence for all of them sent the
		// reader to `work context`, which shows a healthy item, instead of to the
		// budget that refused.
		const fixture = makeContext(
			{},
			undefined,
			() => ({
				defined: true,
				code: "CONFLICT",
				status: 409,
				message: "Budget 9f2c lacks capacity",
			}),
			{ json: false },
		);
		const { code, err } = await capture(`start ${ITEM}`, fixture.ctx);
		expect(code).toBe(WORK_EXIT_FAIL);
		const line = err.join("\n");
		expect(line).toContain("Budget 9f2c lacks capacity");
		expect(line).not.toContain("already has a live attempt");
		expect(line).toContain(`tedix work readiness ${ITEM}`);
	});

	test("rejects worktree flags outside start and requires the opt-in flag", async () => {
		await expect(
			runWork("context", makeContext({ worktree: true }).ctx),
		).rejects.toThrow("only valid with work start");
		await expect(
			runWork("start", makeContext({ worktreeRoot: "/tmp/root" }).ctx),
		).rejects.toThrow("requires --worktree");
	});

	test("persists the server-stamped external session instead of a caller hint", async () => {
		const serverSession = "codex:server-certified-session";
		const { ctx, sources, attemptStore } = makeContext(
			{ session: "codex:stale-caller-hint" },
			undefined,
			(source) =>
				source.includes("start_work_item_attempt")
					? {
							attempt: {
								id: ATTEMPT,
								externalSessionKey: serverSession,
							},
						}
					: { id: ITEM },
		);
		expect(await runWork(`start ${ITEM}`, ctx)).toBe(0);
		expect(
			attemptStore.get({
				workspace: "test",
				actor: "credential",
				agentSession: serverSession,
				workItemId: ITEM,
			}),
		).toBe(ATTEMPT);
		expect(
			attemptStore.get({
				workspace: "test",
				actor: "credential",
				agentSession: "codex:stale-caller-hint",
				workItemId: ITEM,
			}),
		).toBeNull();

		ctx.work.session = serverSession;
		expect(await runWork(`heartbeat ${ITEM}`, ctx)).toBe(0);
		expect(sources.at(-1)).toContain(`"attemptId":"${ATTEMPT}"`);
	});

	test("heartbeats, submits evidence, and settles with the cached fence", async () => {
		const { ctx, sources } = makeContext(
			{
				claimKey: "tests",
				evidenceKind: "test_report",
				evidence: "artifact://tests",
				evidenceMediaType: "application/json",
				evidenceLabel: "CLI tests",
				evidenceMetadata: '{"suite":"cli"}',
				outcome: "succeeded",
			},
			ATTEMPT,
		);
		expect(await runWork(`heartbeat ${ITEM}`, ctx)).toBe(0);
		expect(await runWork(`submit-evidence ${ITEM}`, ctx)).toBe(0);
		expect(await runWork(`settle ${ITEM}`, ctx)).toBe(0);
		expect(sources[0]).toContain("work.heartbeat_work_item_attempt");
		expect(sources[1]).toContain("work.submit_work_item_evidence");
		// The digest flag is gone, not merely unset: demanding one invites a
		// hand-typed sha256.
		expect(sources[1]).not.toContain('"digest"');
		expect(sources[1]).toContain('"mediaType":"application/json"');
		expect(sources[1]).toContain('"label":"CLI tests"');
		expect(sources[1]).toContain('"metadata":{"suite":"cli"');
		expect(sources[2]).toContain("work.settle_work_item_attempt");
		for (const source of sources)
			expect(source).toContain(`"attemptId":"${ATTEMPT}"`);
	});

	for (const verb of ["heartbeat", "settle"]) {
		test(`${verb} preserves the fence after a stale response so the server can revalidate a retry`, async () => {
			let calls = 0;
			const { ctx, sources, attemptStore } = makeContext(
				{ outcome: "succeeded" },
				ATTEMPT,
				() => {
					calls++;
					return calls === 1
						? {
								code: "STALE_ATTEMPT",
								status: 409,
								message: "Attempt is no longer authoritative",
							}
						: { id: ITEM };
				},
			);
			const key = {
				workspace: "test",
				actor: "credential",
				agentSession: ctx.work.session!,
				workItemId: ITEM,
			};
			expect((await capture(`${verb} ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
			expect(attemptStore.get(key)).toBe(ATTEMPT);
			expect((await capture(`${verb} ${ITEM}`, ctx)).code).toBe(0);
			expect(sources).toHaveLength(2);
			for (const source of sources)
				expect(source).toContain(`"attemptId":"${ATTEMPT}"`);
			expect(attemptStore.get(key)).toBe(verb === "settle" ? null : ATTEMPT);
		});
	}
	test("repeated stale settlement responses remain failures, never local success", async () => {
		const { ctx, sources } = makeContext(
			{ outcome: "succeeded" },
			ATTEMPT,
			() => ({ code: "STALE_ATTEMPT", status: 409, message: "lease expired" }),
		);
		for (let retry = 0; retry < 2; retry++)
			expect((await capture(`settle ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(sources).toHaveLength(2);
	});

	// Replaces "reviews evidence and completes": the review step it pinned is
	// deliberately removed, so what survives is the claim that still holds —
	// complete is one unconditional board call with no evidence decision in
	// front of it (decisions/minimal-gates-over-pre-proof.md).
	test("completes without a review step in front of it", async () => {
		const { ctx, sources } = makeContext();
		expect(await runWork(`complete ${ITEM}`, ctx)).toBe(0);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toContain("work.complete_work_item");
		expect(sources[0]).not.toContain("review_work_item_evidence");
	});

	test("refuses a review-evidence invocation instead of quietly ignoring it", async () => {
		const { ctx, sources } = makeContext();
		await expect(
			runWork(
				`review-evidence ${ITEM} 44444444-4444-4444-8444-444444444444`,
				ctx,
			),
		).rejects.toThrow();
		expect(sources).toHaveLength(0);
	});

	// The evidence LEDGER outlives its reviewer: ~22 in-flight items carry
	// historical work_evidence rows that must stay readable.
	test("still reads the evidence ledger of an in-flight item", async () => {
		const { ctx, sources } = makeContext({}, undefined, () => ({
			data: [
				{
					id: "44444444-4444-4444-8444-444444444444",
					claimKey: "tests",
					kind: "test_report",
					disposition: "accepted",
					uri: "artifact://tests",
				},
			],
		}));
		expect(await runWork(`evidence ${ITEM}`, ctx)).toBe(0);
		expect(sources[0]).toContain("work.list_work_evidence_cli_rows");
	});

	test("cancels obsolete unstarted Work through the curated lifecycle verb", async () => {
		const { ctx, sources } = makeContext({ reason: "Purpose expired" });
		expect(await runWork(`cancel ${ITEM}`, ctx)).toBe(0);
		expect(sources[0]).toContain("work.cancel_work_items");
		expect(sources[0]).toContain('"reason":"Purpose expired"');
	});

	test("rejects --as for mutations instead of treating a namespace as authority", async () => {
		const { ctx, sources } = makeContext({ as: "research-lead" });
		await expect(runWork(`start ${ITEM}`, ctx)).rejects.toThrow(
			"--as selects a read-only tedi namespace",
		);
		expect(sources).toHaveLength(0);
	});

	test("preserves --as for read-only namespace selection", async () => {
		const { ctx, sources } = makeContext({ as: "research-lead" });
		expect(await runWork("list", ctx)).toBe(0);
		expect(sources[0]).toContain("research_lead.list_work_item_cli_rows");
	});
});

describe("artifact-neutral factory control verbs", () => {
	test("routes project milestone and health controls through projects", async () => {
		const callables = {
			"milestone-list": "projects.list_project_milestones",
			"milestone-create": "projects.create_project_milestone",
			"milestone-update": "projects.update_project_milestone",
			"milestone-attach": "projects.attach_project_milestone_work_item",
			"milestone-dependency-add": "projects.add_project_milestone_dependency",
			"health-list": "projects.list_project_health_judgments",
			"health-record": "projects.record_project_health_judgment",
		} as const;
		for (const [verb, callable] of Object.entries(callables)) {
			const { ctx, sources } = makeContext({
				input: JSON.stringify({ id: ITEM }),
			});
			expect(await runWork(verb, ctx)).toBe(0);
			expect(sources[0]).toContain(callable);
			expect(sources[0]).not.toContain(`work.${callable.split(".")[1]}`);
		}
	});

	test("exposes every first-class operator domain without legacy board verbs", () => {
		const verbs = workVerbNames();
		for (const verb of [
			"case-create",
			"case-stage",
			"case-close",
			"milestone-create",
			"health-record",
			"approval-decide",
			"approval-audit-list",
			"interaction-respond",
			"interaction-audit-list",
			"interaction-outbox-list",
			"admission-replace",
			"resource-put",
			"budget-put",
			"fleet",
			"clusters",
			"scheduler",
		])
			expect(verbs).toContain(verb);
		for (const retired of ["claim", "release", "done", "next", "checkout"])
			expect(verbs).not.toContain(retired);
	});

	test("explains the scheduler truncation receipt", () => {
		expect(workUsage()).toContain("factsTruncated + truncatedFacts");
		expect(workUsage()).toContain("evaluation_required");
		expect(workUsage()).toContain("graphTruncated (ranking only)");
	});

	test("requests bounded advisory execution clusters", async () => {
		const bounded = makeContext();
		expect(await runWork("clusters", bounded.ctx)).toBe(0);
		expect(bounded.sources[0]).toContain("work.plan_work_execution_clusters");
		expect(bounded.sources[0]).toContain('"maxParallelism":8');
		expect(bounded.sources[0]).toContain('"candidateLimit":10');
		expect(workUsage()).toContain("resource-compatible waves");
	});

	test("requires and forwards an explicit tedi executor for operator clusters", async () => {
		const missing = makeContext({}, undefined, undefined, {
			authSource: "stored-login:user",
		});
		await expect(runWork("clusters", missing.ctx)).rejects.toThrow(
			"requires --executor-tedi",
		);
		const selected = makeContext(
			{ executorTedi: "55555555-5555-4555-8555-555555555555" },
			undefined,
			undefined,
			{ authSource: "stored-login:user" },
		);
		expect(await runWork("clusters", selected.ctx)).toBe(0);
		expect(selected.sources[0]).toContain(
			'"executor":{"type":"tedi","id":"55555555-5555-4555-8555-555555555555"}',
		);
	});

	test("routes interaction inbox, outbox, and audit reads to separate tools", async () => {
		const inbox = makeContext();
		expect(await runWork("interaction-list", inbox.ctx)).toBe(0);
		expect(inbox.sources[0]).toContain("work.list_work_interaction_cli_rows");

		const audit = makeContext();
		expect(await runWork("interaction-audit-list", audit.ctx)).toBe(0);
		expect(audit.sources[0]).toContain("work.list_work_interaction_audit");

		const outbox = makeContext();
		expect(await runWork("interaction-outbox-list", outbox.ctx)).toBe(0);
		expect(outbox.sources[0]).toContain("work.list_work_interaction_outbox");
	});

	test("loads structured input from inline JSON and calls the exact verb-first tool", async () => {
		const { ctx, sources } = makeContext({
			input: JSON.stringify({
				requestId: ITEM,
				expectedRequestVersion: 2,
			}),
		});
		expect(await runWork("interaction-cancel", ctx)).toBe(0);
		expect(sources[0]).toContain("work.cancel_work_interaction");
		expect(sources[0]).toContain('"expectedRequestVersion":2');
	});

	test("lets the positional route id override an id embedded in JSON input", async () => {
		const routeId = "55555555-5555-4555-8555-555555555555";
		const { ctx, sources } = makeContext({
			input: JSON.stringify({
				requestId: ITEM,
				expectedRequestVersion: 2,
			}),
		});
		expect(await runWork(`interaction-cancel ${routeId}`, ctx)).toBe(0);
		expect(sources[0]).toContain(`"requestId":"${routeId}"`);
		expect(sources[0]).not.toContain(`"requestId":"${ITEM}"`);
	});

	test("loads structured input from an @path file", async () => {
		const directory = mkdtempSync(join(tmpdir(), "tedix-work-input-"));
		try {
			const path = join(directory, "case.json");
			writeFileSync(path, JSON.stringify({ caseId: ITEM }));
			const { ctx, sources } = makeContext({ input: `@${path}` });
			expect(await runWork("case-get", ctx)).toBe(0);
			expect(sources[0]).toContain("work.get_work_case");
			expect(sources[0]).toContain(`"caseId":"${ITEM}"`);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("defaults bounded reads and rejects --as for every structured write", async () => {
		const bounded = makeContext({ limit: 17 });
		expect(await runWork("scheduler", bounded.ctx)).toBe(0);
		expect(bounded.sources[0]).toContain('"limit":17');
		expect(bounded.sources[0]).toContain('"candidateLimit":200');

		const mutation = makeContext({
			as: "cto",
			input: JSON.stringify({ caseId: ITEM, expectedVersion: 1 }),
		});
		await expect(runWork("case-close", mutation.ctx)).rejects.toThrow(
			"--as selects a read-only tedi namespace",
		);
		expect(mutation.sources).toHaveLength(0);
	});

	test("rejects --as for structured reads instead of silently ignoring it", async () => {
		const { ctx, sources } = makeContext({ as: "cto", limit: 10 });
		await expect(runWork("scheduler", ctx)).rejects.toThrow(
			"does not expose a tedi-scoped callable",
		);
		expect(sources).toHaveLength(0);
	});
});

describe("canonical board errors and credentials", () => {
	test("recognizes contract and gateway error envelopes without hiding them as empty data", () => {
		expect(
			boardErrorFromValue({
				defined: true,
				code: "CONFLICT",
				status: 409,
				message: "attempt already active",
			}),
		).toMatchObject({ code: "CONFLICT", status: 409 });
		expect(
			boardErrorFromValue({ ok: false, error: "invalid limit" }),
		).toMatchObject({ code: "GATEWAY_REJECTED", message: "invalid limit" });
		expect(boardErrorFromValue({ data: [], pagination: {} })).toBeUndefined();
	});

	test("surfaces a gateway rejection in machine-readable list output", async () => {
		const { ctx } = makeContext({}, undefined, () => ({
			ok: false,
			error: "BAD_REQUEST: invalid disposition",
		}));
		const result = await capture("list", ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			error: { code: "GATEWAY_REJECTED" },
		});
	});

	test("refuses owner OAuth attribution from a detected coding harness", async () => {
		const session = "codex:33333333-3333-4333-8333-333333333333";
		const { ctx, sources } = makeContext({ session }, undefined, undefined, {
			authSource: "stored-login:tedix",
		});
		const result = await capture(`trailers ${ITEM}`, ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			error: { code: "EXTERNAL_AGENT_IDENTITY_REQUIRED" },
		});
		expect(sources).toHaveLength(0);
	});

	test("preserves an opaque external session key in immutable trailers", async () => {
		const { ctx } = makeContext({
			session: "codex:oss-license-20260810-01",
		});
		const result = await capture(`trailers ${ITEM}`, ctx);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			workItemId: ITEM,
			agentSession: "codex:oss-license-20260810-01",
			trailers: [
				`Work-Item: ${ITEM}`,
				"Agent-Session: codex:oss-license-20260810-01",
			],
		});
	});
});

describe("canonical list pagination and output", () => {
	const row = (index: number) => ({
		id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
		workKind: "coding",
		disposition: "accepted",
		riskLevel: "medium",
		priority: "medium",
		title: `Item ${index}`,
	});

	test("pages and stitches a requested window while preserving the server total", async () => {
		const all = Array.from({ length: 75 }, (_, index) => row(index));
		const { ctx, sources } = makeContext({ limit: 75 }, undefined, (source) => {
			const args = JSON.parse(
				source.match(/list_work_item_cli_rows\((\{[^)]*\})\)/)?.[1] ?? "{}",
			) as { limit: number; offset?: number };
			const offset = args.offset ?? 0;
			return {
				data: all.slice(offset, offset + args.limit),
				pagination: {
					limit: args.limit,
					offset,
					total: all.length,
					hasMore: offset + args.limit < all.length,
				},
			};
		});
		const result = await capture("list", ctx);
		const output = JSON.parse(result.out[0]!);
		expect(result.code).toBe(0);
		expect(sources).toHaveLength(2);
		expect(sources[0]).toContain('"limit":50');
		expect(sources[1]).toContain('"offset":50');
		expect(output.data).toHaveLength(75);
		expect(output.pagination).toMatchObject({
			limit: 75,
			offset: 0,
			total: 75,
			hasMore: false,
		});
	});

	test("sends canonical disposition, project UUID, and namespaced mine filters", async () => {
		const project = "70000000-0000-4000-8000-000000000001";
		const filtered = makeContext({
			disposition: "accepted",
			project,
		});
		expect((await capture("list", filtered.ctx)).code).toBe(0);
		expect(filtered.sources[0]).toContain('"disposition":"accepted"');
		expect(filtered.sources[0]).toContain(`"projectId":"${project}"`);
		expect(filtered.sources[0]).not.toContain("projectKey");

		const mine = makeContext({ as: "research-lead", mine: true });
		expect((await capture("list", mine.ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(mine.nativeCalls).toEqual([]);
		await expect(
			runWork("list", makeContext({ mine: true }).ctx),
		).rejects.toThrow("needs --as <tediSlug>");
	});

	test("fails loudly on a truncated page in JSON mode", async () => {
		const { ctx } = makeContext({}, undefined, () => ({
			__tedix_truncated: true,
			marker: "--- TRUNCATED ---",
			originalType: "object",
			approxTokens: 9_999,
			maxTokens: 6_000,
			guidance: "narrow or paginate",
			preview: "x".repeat(18_000),
		}));
		const result = await capture("list", ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			error: { code: "RESULT_TRUNCATED" },
		});
	});

	test("renders canonical fields for humans and an honest empty state", () => {
		const table = renderWorkItemsTable([row(7)], { enabled: false });
		expect(table).toContain("KIND");
		expect(table).toContain("DISPOSITION");
		expect(table).toContain("RISK");
		expect(table).toContain("coding");
		expect(table).toContain("accepted");
		expect(table).toContain("Item 7");
		expect(renderWorkItemsTable([], { enabled: false })).toContain(
			"No work items.",
		);
	});
});

describe("canonical ID and title resolution", () => {
	const FULL_A = "aaaaaa11-2222-4333-8444-555555555555";
	const FULL_B = "aaaaaa22-2222-4333-8444-555555555555";

	test("a full UUID takes the direct context fast path", async () => {
		const { ctx, sources } = makeContext({}, undefined, () => ({
			workItem: { id: FULL_A, title: "Alpha" },
			comments: [],
			projections: [],
		}));
		expect((await capture(`context ${FULL_A}`, ctx)).code).toBe(0);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toContain("get_work_items_by_id");
		expect(sources[0]).not.toContain("list_work_item_cli_rows");
	});

	test("a unique mixed-case prefix resolves server-side before context", async () => {
		const { ctx, sources } = makeContext({}, undefined, (source) =>
			source.includes("list_work_item_cli_rows")
				? { data: [{ id: FULL_A, title: "Alpha" }] }
				: {
						workItem: { id: FULL_A, title: "Alpha" },
						comments: [],
						projections: [],
					},
		);
		expect((await capture("context AAAAAA11", ctx)).code).toBe(0);
		expect(sources[0]).toContain('"idPrefix":"aaaaaa11"');
		expect(sources[0]).toContain('"limit":2');
		expect(sources[1]).toContain(`"id":"${FULL_A}"`);
	});

	test("ambiguous and unknown prefixes fail with actionable identity details", async () => {
		const ambiguous = makeContext({}, undefined, () => ({
			data: [
				{ id: FULL_A, title: "Alpha" },
				{ id: FULL_B, title: "Beta" },
			],
		}));
		await expect(runWork("context aaaaaa", ambiguous.ctx)).rejects.toThrow(
			new RegExp(`ambiguous prefix aaaaaa.*${FULL_A}.*${FULL_B}`),
		);
		const missing = makeContext({}, undefined, () => ({ data: [] }));
		await expect(runWork("context ffffff", missing.ctx)).rejects.toThrow(
			"no work item matches prefix ffffff",
		);
	});

	test("find uses server-side title filtering and human output keeps the full id", async () => {
		const { ctx, sources } = makeContext(
			{},
			undefined,
			() => ({
				data: [
					{
						id: FULL_B,
						title: "Ship CLI factory views",
						disposition: "accepted",
					},
				],
			}),
			{ json: false },
		);
		const result = await capture("find CLI factory", ctx);
		expect(result.code).toBe(0);
		expect(sources[0]).toContain('"titleContains":"CLI factory"');
		expect(result.out.join("\n")).toContain(FULL_B);
	});

	test("find keeps project, disposition and limit on prefix fallback", async () => {
		const project = "70000000-0000-4000-8000-000000000001";
		const { ctx, sources } = makeContext(
			{ project, disposition: "accepted", limit: 3 },
			undefined,
			(source) =>
				source.includes("idPrefix")
					? { data: [] }
					: { data: [{ id: FULL_A, title: "Commit deadbe11" }] },
		);
		await capture("find deadbe11", ctx);
		expect(sources).toHaveLength(2);
		for (const source of sources) {
			expect(source).toContain(`"projectId":"${project}"`);
			expect(source).toContain('"limit":3');
			expect(source).toContain('"disposition":"accepted"');
		}
	});

	test("find rejects invalid filters before reading the gateway", async () => {
		for (const filter of [
			{ project: "wrong-project" },
			{ limit: 101 },
			{ limit: 0 },
			{ limit: 2.5 },
			{ disposition: "running" },
		]) {
			const { ctx, sources } = makeContext(filter);
			await expect(runWork("find plugin", ctx)).rejects.toThrow();
			expect(sources).toHaveLength(0);
		}
	});

	test("find falls back from a hex id prefix to a title search", async () => {
		const { ctx, sources } = makeContext({}, undefined, (source) =>
			source.includes("idPrefix")
				? { data: [] }
				: { data: [{ id: FULL_A, title: "Commit deadbe11" }] },
		);
		const result = await capture("find deadbe11", ctx);
		expect(result.code).toBe(0);
		expect(sources).toHaveLength(2);
		expect(sources[0]).toContain('"idPrefix":"deadbe11"');
		expect(sources[1]).toContain('"titleContains":"deadbe11"');
	});
});

describe("canonical create validation", () => {
	const OBJECTIVE = "12345678-1234-4234-8234-123456789012";
	const PROJECT = "87654321-4321-4321-8321-210987654321";

	test("rejects purposeless and unbounded exception work before the network", async () => {
		const purposeless = makeContext();
		await expect(
			runWork("create Fix production", purposeless.ctx),
		).rejects.toThrow("requires a purpose");
		expect(purposeless.sources).toHaveLength(0);
		const unbounded = makeContext({ workClass: "hygiene" });
		await expect(runWork("create Sweep debt", unbounded.ctx)).rejects.toThrow(
			"requires --expires",
		);
		expect(unbounded.sources).toHaveLength(0);
	});

	test("rejects invalid objective, project, kind, priority, and class locally", async () => {
		for (const work of [
			{ objective: "not-a-uuid" },
			{ objective: OBJECTIVE, project: "legacy-project-key" },
			{ objective: OBJECTIVE, kind: "epic" },
			{ objective: OBJECTIVE, priority: "urgent" },
			{ workClass: "objective", expires: "72h" },
		]) {
			const fixture = makeContext(work);
			await expect(runWork("create Invalid", fixture.ctx)).rejects.toThrow();
			expect(fixture.sources).toHaveLength(0);
		}
	});

	test("emits adapter-neutral kind and canonical project UUID", async () => {
		const { ctx, sources } = makeContext({
			objective: OBJECTIVE,
			project: PROJECT,
			kind: "research",
			priority: "high",
		});
		expect((await capture("create Research scheduling", ctx)).code).toBe(0);
		expect(sources[0]).toContain("work.create_work_items");
		expect(sources[0]).toContain('"workKind":"research"');
		expect(sources[0]).toContain(`"projectId":"${PROJECT}"`);
		expect(sources[0]).not.toContain("projectKey");
		expect(sources[0]).not.toContain("itemType");
	});

	test("normalizes duration and ISO exception expiries", () => {
		const now = Date.parse("2026-08-20T00:00:00.000Z");
		expect(expiresToIso("72h", now)).toBe("2026-08-23T00:00:00.000Z");
		expect(expiresToIso("7d", now)).toBe("2026-08-27T00:00:00.000Z");
		expect(expiresToIso("2026-09-01T00:00:00Z")).toBe(
			"2026-09-01T00:00:00.000Z",
		);
		expect(() => expiresToIso("eventually")).toThrow("--expires");
	});
});

describe("canonical context JSON and human rendering", () => {
	const payload = {
		workItem: {
			id: ITEM,
			workKind: "research",
			disposition: "accepted",
			riskLevel: "medium",
			priority: "high",
			title: "Research agent scheduling",
			description: "  Evidence-backed scheduling context.  ",
			metadata: { huge: "not projected" },
			acceptanceContract: { claims: [] },
		},
		comments: Array.from({ length: 7 }, (_, index) => ({
			eventType: "comment",
			body: `Comment ${index}`,
			createdAt: `2026-08-20T00:0${index}:00.000Z`,
		})),
		projections: [
			{ provider: "linear", externalUrl: "https://linear.example/item" },
		],
	};

	test("JSON emits the compact context brief with bounded recent comments", async () => {
		const { ctx } = makeContext({}, undefined, () => payload);
		const result = await capture(`context ${ITEM}`, ctx);
		const output = JSON.parse(result.out[0]!);
		expect(result.code).toBe(0);
		expect(output).toMatchObject({
			id: ITEM,
			workKind: "research",
			disposition: "accepted",
			description: "Evidence-backed scheduling context.",
			commentCount: 7,
		});
		expect(output.recentComments).toHaveLength(5);
		expect(output.links).toEqual([
			{ provider: "linear", ref: "https://linear.example/item" },
		]);
		expect(output.metadata).toBeUndefined();
	});

	test("human context renders title, disposition, description, links, and recent comments", async () => {
		const { ctx } = makeContext({}, undefined, () => payload, { json: false });
		const result = await capture(`context ${ITEM}`, ctx);
		const text = result.out.join("\n");
		expect(result.code).toBe(0);
		expect(text).toContain("Research agent scheduling");
		expect(text).toContain("accepted");
		expect(text).toContain("Evidence-backed scheduling context.");
		expect(text).toContain("https://linear.example/item");
		expect(text).toContain("Recent comments (5 of 7)");
	});

	test("context surfaces gateway truncation instead of rendering a partial brief", async () => {
		const { ctx } = makeContext({}, undefined, () => ({
			__tedix_truncated: true,
			marker: "--- TRUNCATED ---",
			originalType: "object",
			approxTokens: 8_000,
			maxTokens: 6_000,
			guidance: "narrow the context projection",
			preview: "partial",
		}));
		const result = await capture(`context ${ITEM}`, ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			error: { code: "RESULT_TRUNCATED" },
		});
	});
});

describe("work item ledger reads", () => {
	const EVIDENCE_A = "55555555-5555-4555-8555-555555555555";
	const EVIDENCE_B = "66666666-6666-4666-8666-666666666666";

	function evidenceRow(
		id: string,
		claimKey: string,
		disposition: string,
	): Record<string, unknown> {
		return {
			id,
			claimKey,
			kind: "test_report",
			disposition,
			uri: `artifact://${claimKey}`,
			attemptId: ATTEMPT,
			submittedByType: "external_agent",
			submittedById: "codex-7f3a9b12",
			submittedAt: "2026-08-28T18:00:00.000Z",
			reviewedByType: disposition === "pending" ? null : "tedi",
			reviewedById: disposition === "pending" ? null : "cto-9911aabb",
			reviewedAt: disposition === "pending" ? null : "2026-08-28T19:30:00.000Z",
		};
	}

	test("evidence reads the ledger and returns discoverable evidence ids", async () => {
		const { ctx, sources } = makeContext({}, undefined, () => ({
			data: [
				evidenceRow(EVIDENCE_A, "tests", "accepted"),
				evidenceRow(EVIDENCE_B, "deploy", "pending"),
			],
			nextCursor: null,
		}));
		const result = await capture(`evidence ${ITEM}`, ctx);
		expect(result.code).toBe(0);
		expect(sources[0]).toContain("work.list_work_evidence_cli_rows");
		expect(sources[0]).toContain(`"id":"${ITEM}"`);
		expect(sources[0]).toContain('"limit":25');
		const payload = JSON.parse(result.out[0]!) as {
			data: { id: string }[];
			nextCursor: unknown;
		};
		expect(payload.data.map((e) => e.id)).toEqual([EVIDENCE_A, EVIDENCE_B]);
		expect(payload.nextCursor).toBeNull();
	});

	test("evidence filters client-side and never invents a server-side filter", async () => {
		const { ctx, sources } = makeContext(
			{ disposition: "accepted", claimKey: "tests" },
			undefined,
			() => ({
				data: [
					evidenceRow(EVIDENCE_A, "tests", "accepted"),
					evidenceRow(EVIDENCE_B, "tests", "pending"),
				],
				nextCursor: null,
			}),
		);
		const result = await capture(`evidence ${ITEM}`, ctx);
		expect(result.code).toBe(0);
		// The board takes only { id, limit }; the filters never reach the wire.
		expect(sources[0]).toContain(
			`work.list_work_evidence_cli_rows({"id":"${ITEM}","limit":25})`,
		);
		const payload = JSON.parse(result.out[0]!) as { data: { id: string }[] };
		expect(payload.data.map((e) => e.id)).toEqual([EVIDENCE_A]);
	});

	test("evidence rejects a disposition the evidence ledger cannot hold", async () => {
		const { ctx, sources } = makeContext({ disposition: "completed" });
		await expect(runWork(`evidence ${ITEM}`, ctx)).rejects.toThrow(
			"pending|accepted|rejected|superseded",
		);
		expect(sources).toHaveLength(0);
	});

	test("evidence requires a work item id", async () => {
		const { ctx } = makeContext();
		await expect(runWork("evidence", ctx)).rejects.toThrow(
			"work evidence requires a work item id",
		);
	});

	test("a board error exits non-zero instead of rendering an empty ledger", async () => {
		const { ctx } = makeContext({}, undefined, () => ({
			defined: true,
			code: "NOT_FOUND",
			status: 404,
			message: "Work Item not found",
		}));
		const result = await capture(`evidence ${ITEM}`, ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!)).toMatchObject({
			error: { code: "NOT_FOUND" },
		});
	});

	test("attempts and events read their own ledger keys", async () => {
		const attemptCtx = makeContext({ limit: 3 }, undefined, () => ({
			data: [
				{
					id: ATTEMPT,
					attemptNumber: 1,
					runtimeState: "finished",
					outcome: "succeeded",
					executorType: "external_agent",
					executorId: "codex-7f3a9b12",
					startedAt: "2026-08-28T18:00:00.000Z",
					heartbeatAt: "2026-08-28T18:40:00.000Z",
				},
			],
			nextCursor: null,
		}));
		expect((await capture(`attempts ${ITEM}`, attemptCtx.ctx)).code).toBe(0);
		expect(attemptCtx.sources[0]).toContain("work.list_work_attempt_cli_rows");
		expect(attemptCtx.sources[0]).toContain('"limit":3');

		// runCode is faked, so the mock returns what the in-sandbox projection
		// would have produced; the `events` row key is asserted on the source.
		const eventCtx = makeContext({}, undefined, () => ({
			data: [
				{
					sequence: 4,
					id: EVIDENCE_A,
					eventType: "evidence_reviewed",
					actorType: "tedi",
					actorId: "cto-9911aabb",
					attemptId: ATTEMPT,
					occurredAt: "2026-08-28T19:30:00.000Z",
				},
			],
			next: null,
		}));
		const events = await capture(`events ${ITEM}`, eventCtx.ctx);
		expect(events.code).toBe(0);
		expect(eventCtx.sources[0]).toContain("work.list_work_event_cli_rows");
		expect(eventCtx.nativeCalls.at(-1)?.name).toContain(
			"list_work_event_cli_rows",
		);
		expect(eventCtx.nativeCalls.at(-1)?.options).toMatchObject({
			retryable: false,
		});
		const payload = JSON.parse(events.out[0]!) as { data: unknown[] };
		expect(payload.data).toHaveLength(1);
	});

	test("--limit is clamped to the board ledger ceiling", async () => {
		const { ctx, sources } = makeContext({ limit: 5_000 }, undefined, () => ({
			data: [],
			nextCursor: null,
		}));
		expect((await capture(`evidence ${ITEM}`, ctx)).code).toBe(0);
		expect(sources[0]).toContain('"limit":100');
	});

	test("filterEvidenceRows narrows on both axes and is a no-op when unset", () => {
		const rows = [
			evidenceRow(EVIDENCE_A, "tests", "accepted"),
			evidenceRow(EVIDENCE_B, "deploy", "pending"),
		];
		expect(filterEvidenceRows(rows, {})).toHaveLength(2);
		expect(filterEvidenceRows(rows, { claimKey: "deploy" })).toEqual([
			rows[1]!,
		]);
		expect(filterEvidenceRows(rows, { disposition: "accepted" })).toEqual([
			rows[0]!,
		]);
		expect(
			filterEvidenceRows(rows, { claimKey: "deploy", disposition: "accepted" }),
		).toEqual([]);
	});

	test("principalLabel abbreviates the principal without losing its type", () => {
		expect(principalLabel("external_agent", "codex-7f3a9b12")).toBe(
			"agent:codex-7f",
		);
		expect(principalLabel("tedi", "cto")).toBe("tedi:cto");
		expect(principalLabel("user", null)).toBe("—");
	});

	test("renders aligned ledger columns and honest empty states", () => {
		const table = renderWorkEvidenceTable(
			[evidenceRow(EVIDENCE_A, "tests", "accepted")],
			{ enabled: false },
		);
		const [header, row] = table.split("\n");
		expect(header).toContain("CLAIM");
		expect(header).toContain("DISPOSITION");
		expect(header).toContain("URI");
		expect(row).toContain(EVIDENCE_A.slice(0, 8));
		expect(row).toContain("artifact://tests");
		// Aligned columns: DISPOSITION starts at the same offset in both rows.
		expect(row!.indexOf("accepted")).toBe(header!.indexOf("DISPOSITION"));

		expect(renderWorkEvidenceTable([], { enabled: false })).toContain(
			"No evidence.",
		);
		expect(renderWorkAttemptsTable([], { enabled: false })).toContain(
			"No attempts.",
		);
		expect(renderWorkEventsTable([], { enabled: false })).toContain(
			"No events.",
		);
	});

	test("the ledger verbs are registered and documented", () => {
		const verbs = workVerbNames();
		for (const verb of ["evidence", "attempts", "events"])
			expect(verbs).toContain(verb);
		const usage = workUsage();
		expect(usage).toContain("evidence <id>");
		expect(usage).toContain("attempts <id>");
		expect(usage).toContain("events <id>");
		expect(usage).toContain("CLIENT-SIDE");
	});
});

describe("accept states the outcome in plain language", () => {
	test("--done-when IS the whole contract", () => {
		expect(
			buildAcceptanceContract("  The ship lane deploys apps/os  "),
		).toEqual({ version: 1, doneLooksLike: "The ship lane deploys apps/os" });
	});

	// The pre-proof shape still PARSES forever so the live rows deserialize;
	// the CLI simply stops authoring one.
	test("writes no claims, evidence kinds, or review requirement", () => {
		const contract = buildAcceptanceContract("Done");
		expect(contract).not.toHaveProperty("claims");
		expect(contract).not.toHaveProperty("requiresIndependentReview");
		expect(JSON.stringify(contract)).not.toContain("evidenceKinds");
	});

	test("refuses an accept that states no outcome at all", () => {
		expect(() => buildAcceptanceContract("   ")).toThrow(/--done-when/);
	});

	test("routes --done-when through the board accept call", async () => {
		const { ctx, sources } = makeContext({ doneWhen: "The gate is gone" });
		expect(await runWork(`accept ${ITEM}`, ctx)).toBe(0);
		expect(sources[0]).toContain("work.accept_work_item");
		expect(sources[0]).toContain('"doneLooksLike":"The gate is gone"');
	});
});

describe("settle carries verified commits", () => {
	let repo: string;
	let head: string;

	function git(args: string[], cwd: string): string {
		const result = Bun.spawnSync(["git", ...args], {
			cwd,
			env: detachedGitEnv(),
		});
		expect(result.exitCode).toBe(0);
		return new TextDecoder().decode(result.stdout).trim();
	}

	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), "work-settle-commit-"));
		git(["init", "--quiet"], repo);
		git(["config", "user.email", "test@example.com"], repo);
		git(["config", "user.name", "Test"], repo);
		writeFileSync(join(repo, "file.txt"), "content\n");
		git(["add", "."], repo);
		git(["commit", "--quiet", "-m", "first"], repo);
		head = git(["rev-parse", "HEAD"], repo);
	});

	afterAll(() => rmSync(repo, { force: true, recursive: true }));

	test("omitting --commit sends no settlement metadata", () => {
		expect(buildSettlementMetadata(undefined, repo)).toBeUndefined();
		expect(buildSettlementMetadata([], repo)).toBeUndefined();
	});

	// The short sha `git push` prints is a legal input, which is exactly what
	// removes the motive to hand-extend one.
	test("expands short shas and repeats the first as commitSha", () => {
		expect(buildSettlementMetadata([head.slice(0, 8), head], repo)).toEqual({
			settlement: { mode: "commit", commitSha: head, commitShas: [head] },
		});
	});

	test("preserves order across several distinct commits", () => {
		git(["commit", "--quiet", "--allow-empty", "-m", "second"], repo);
		const second = git(["rev-parse", "HEAD"], repo);
		expect(buildSettlementMetadata([second, head.slice(0, 9)], repo)).toEqual({
			settlement: {
				mode: "commit",
				commitSha: second,
				commitShas: [second, head],
			},
		});
	});

	// The anti-fabrication property that replaces the digest ceremony: a made-up
	// sha fails at the terminal that typed it, not silently downstream.
	test("refuses a fabricated sha locally, before any board call", () => {
		expect(() =>
			buildSettlementMetadata([`${head.slice(0, 9)}${"0".repeat(31)}`], repo),
		).toThrow(/does not resolve to a commit/);
	});

	test("settle sends nested settlement metadata the contract accepts as-is", async () => {
		const { ctx, sources } = makeContext(
			{ outcome: "succeeded", commit: [head.slice(0, 8)] },
			ATTEMPT,
		);
		const cwd = process.cwd();
		process.chdir(repo);
		try {
			expect(await runWork(`settle ${ITEM}`, ctx)).toBe(0);
		} finally {
			process.chdir(cwd);
		}
		expect(sources[0]).toContain("work.settle_work_item_attempt");
		expect(sources[0]).toContain(
			`"settlement":{"mode":"commit","commitSha":"${head}"`,
		);
		expect(sources[0]).toContain(`"commitShas":["${head}"]`);
	});
});

describe("work context brief surfaces the reviewer lease", () => {
	const item = {
		id: "5eed0029-0000-4000-8000-000000000029",
		title: "Repair the smoke",
		disposition: "accepted",
		reviewerType: "tedi",
		reviewerId: "5eed0042-0000-4000-8000-000000000042",
		reviewerLeaseExpiresAt: "2026-09-05T02:48:05.717Z",
	};

	test("--json carries the lease expiry, not just the reviewer id", () => {
		// The board refuses reviewer reassignment "until the current lease
		// expires". Without the expiry a caller learns only that it cannot act,
		// never when it may retry — a four-hour misestimate in practice.
		const brief = contextBriefJson({ workItem: item }) as Record<
			string,
			unknown
		>;
		expect(brief.reviewerId).toBe(item.reviewerId);
		expect(brief.reviewerType).toBe("tedi");
		expect(brief.reviewerLeaseExpiresAt).toBe("2026-09-05T02:48:05.717Z");
	});

	test("an unassigned reviewer yields nulls rather than missing keys", () => {
		const brief = contextBriefJson({ workItem: { id: "x" } }) as Record<
			string,
			unknown
		>;
		expect(brief.reviewerType).toBeNull();
		expect(brief.reviewerLeaseExpiresAt).toBeNull();
	});
});

describe("work attempts distinguishes sessions sharing one principal", () => {
	test("prefers the human-meaningful external session key", () => {
		expect(
			attemptSessionLabel({
				externalSessionKey: "claude-code:b11270cc-4446-4cb2-888b-7fda6b2c360d",
				executorSessionId: "5eed0022-0000-4000-8000-000000000022",
			}),
		).toBe("claude-code:b11270cc-4446-4cb2-888b-7fda6b2c360d");
	});

	test("falls back to the session uuid when no key is present", () => {
		expect(
			attemptSessionLabel({
				executorSessionId: "5eed0022-0000-4000-8000-000000000022",
			}),
		).toBe("5eed0022");
	});

	test("says nothing rather than guessing when neither is present", () => {
		expect(attemptSessionLabel({})).toBe("—");
		expect(attemptSessionLabel({ externalSessionKey: "   " })).toBe("—");
	});

	test("the rendered table carries the session, not just the shared principal", () => {
		const table = renderWorkAttemptsTable(
			[
				{
					id: "5eed0003-0000-4000-8000-000000000003",
					attemptNumber: 1,
					runtimeState: "running",
					executorType: "external_agent",
					executorId: "5eed0013-0000-4000-8000-000000000013",
					externalSessionKey: "codex:codex-factory-eval-20260904",
				},
			],
			{ enabled: false },
		);
		expect(table).toContain("SESSION");
		// The whole point: two sessions share 5eed0013, so the principal alone
		// cannot answer "who ran this".
		expect(table).toContain("codex:codex-factory");
	});
});

describe("selected chat Work checkpoint", () => {
	const ORG = "44444444-4444-4444-8444-444444444444";
	const PROJECT = "55555555-5555-4555-8555-555555555555";
	const REQUEST = "66666666-6666-4666-8666-666666666666";
	const CHAT = "77777777-7777-4777-8777-777777777777";
	const gateway = "https://tedix.mcp.tedix.dev/mcp";
	const binding = {
		status: "bound" as const,
		workspace: "test",
		mcpUrl: gateway,
		org: "org_test",
		projectId: PROJECT,
		workItemId: ITEM,
		contextSessionId: CHAT,
		contextSource: "chat" as const,
	};
	function fixture(
		options: {
			item?: unknown;
			page?: unknown;
			binding?: typeof binding;
			gateway?: string;
			org?: string;
			runtime?: unknown;
		} = {},
	) {
		const page = options.page ?? {
			data: [
				{
					canRespond: true,
					effectiveState: "open",
					request: {
						id: REQUEST,
						workItemId: ITEM,
						orgId: ORG,
						version: 2,
						kind: "coordination",
						subject: "Guardian finding",
						prompt: "Check contract",
						promptComplete: true,
					},
				},
			],
			nextCursor: null,
			hasMore: false,
			observedAt: "2026-10-03T10:00:00Z",
		};
		const { ctx, sources } = makeContext({}, undefined, (source) =>
			source.includes("codemode.__runtime")
				? (options.runtime ?? {
						mode: "stateless",
						surface: "mcp-gateway",
						organizationId: ORG,
						actor: { authType: "user" },
					})
				: source.includes("list_work_interaction_cli_rows")
					? page
					: (options.item ?? {
							workItem: {
								id: ITEM,
								projectId: PROJECT,
								orgId: ORG,
								disposition: "accepted",
							},
						}),
		);
		ctx.resolveContext = () => options.binding ?? binding;
		ctx.mcpUrl = options.gateway ?? gateway;
		ctx.organizationId = options.org ?? ORG;
		const callTool = ctx.client.callTool.bind(ctx.client);
		ctx.client.callTool = (async (
			name: string,
			args: Record<string, unknown>,
			options: Parameters<TedixHomeClient["callTool"]>[2],
		) => {
			if (name === "get_info") {
				const bootstrap = nativeBootstrapFixture();
				const runtime = optionsRuntime;
				bootstrap.nativeContext.organizationId = ORG;
				if (runtime && typeof runtime === "object") {
					const { mode: _mode, ...nativeRuntime } = runtime as Record<
						string,
						unknown
					>;
					Object.assign(bootstrap.nativeContext, nativeRuntime);
				}
				return bootstrap;
			}
			return callTool(name, args, options);
		}) as TedixHomeClient["callTool"];
		const optionsRuntime = options.runtime;
		return { ctx, sources };
	}
	test("reads exact selected chat Work and directed inbox without writes", async () => {
		const { ctx, sources } = fixture();
		const result = await capture("checkpoint", ctx);
		expect(result.code).toBe(0);
		const data = JSON.parse(result.out[0]!);
		expect(data.chatId).toBe(CHAT);
		expect(data.receipt).toBe("retrieved");
		expect(data.requests[0].version).toBe(2);
		expect(data.guidance).toContain("not acknowledgment or action");
		expect(sources).toHaveLength(2);
		expect(sources.join("\n")).not.toMatch(
			/respond_work|add_comment|start_work|settle_work/,
		);
		expect(sources[1]).toContain(`"workItemId":"${ITEM}"`);
	});
	test("returns a bounded inbox page with its canonical continuation cursor", async () => {
		const cursor = {
			at: "2026-10-03T09:59:00Z",
			id: "66666666-6666-4666-8666-666666666664",
		};
		const { ctx, sources } = fixture({
			page: {
				data: Array.from({ length: 5 }, (_, index) => ({
					canRespond: true,
					effectiveState: "open",
					request: {
						id: `66666666-6666-4666-8666-66666666666${index}`,
						workItemId: ITEM,
						orgId: ORG,
						version: 1,
						subject: "Guardian finding",
						prompt: "Check contract",
						promptComplete: true,
					},
				})),
				nextCursor: cursor,
				hasMore: true,
				observedAt: "2026-10-03T10:00:00Z",
			},
		});
		const result = await capture("checkpoint", ctx);
		expect(result.code).toBe(0);
		const data = JSON.parse(result.out[0]!);
		expect(data.requests).toHaveLength(5);
		expect(data.nextCursor).toEqual(cursor);
		expect(data.hasMore).toBe(true);
		expect(sources).toHaveLength(2);
	});
	test("rejects malformed inbox continuation cursors", async () => {
		for (const nextCursor of ["opaque", { at: "invalid", id: REQUEST }]) {
			const { ctx } = fixture({
				page: {
					data: [],
					nextCursor,
					hasMore: true,
					observedAt: "2026-10-03T10:00:00Z",
				},
			});
			expect((await capture("checkpoint", ctx)).code).toBe(WORK_EXIT_FAIL);
		}
	});
	test("verifies stored-login organization from authenticated bootstrap", async () => {
		const { ctx } = fixture();
		delete ctx.organizationId;
		ctx.authSource = "stored-login:test";
		expect((await capture("checkpoint", ctx)).code).toBe(0);
	});
	test("runtime failure or missing tenant fails closed before Work reads", async () => {
		for (const runtime of [
			{
				mode: "stateless",
				surface: "mcp-gateway",
				organizationId: null,
				actor: { authType: "user" },
			},
			{
				mode: "stateless",
				surface: "mcp-gateway",
				organizationId: REQUEST,
				actor: { authType: "user" },
			},
		]) {
			const { ctx, sources } = fixture({ runtime });
			await expect(runWork("checkpoint", ctx)).rejects.toThrow();
			expect(sources).toHaveLength(0);
		}
		const { ctx, sources } = fixture({
			runtime: {
				defined: true,
				code: "FORBIDDEN",
				status: 403,
				message: "Denied",
			},
		});
		await expect(runWork("checkpoint", ctx)).rejects.toThrow();
		expect(sources).toHaveLength(0);
	});
	test("separate chat selection queries its own Work only", async () => {
		const { ctx, sources } = fixture({
			binding: { ...binding, workItemId: ATTEMPT, contextSessionId: REQUEST },
			item: { workItem: { id: ATTEMPT, projectId: PROJECT, orgId: ORG } },
			page: {
				data: [],
				nextCursor: null,
				hasMore: false,
				observedAt: "2026-10-03T10:00:00Z",
			},
		});
		const result = await capture("checkpoint", ctx);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out[0]!).chatId).toBe(REQUEST);
		expect(sources.join("\n")).not.toContain(ITEM);
	});
	test("rejects absent chat identity before network", async () => {
		const { ctx, sources } = fixture();
		ctx.resolveContext = () => ({ ...binding, contextSessionId: undefined });
		await expect(runWork("checkpoint", ctx)).rejects.toThrow("chat-scoped");
		expect(sources).toHaveLength(0);
	});
	test("does not inherit a governed worktree marker just because chat identity is present", async () => {
		const { ctx, sources } = fixture();
		ctx.resolveContext = () => ({ ...binding, contextSource: "worktree" });
		await expect(runWork("checkpoint", ctx)).rejects.toThrow("chat-scoped");
		expect(sources).toHaveLength(0);
	});
	test("guidance interaction-get id syntax reads the canonical request without writes", async () => {
		const { ctx, sources } = makeContext();
		expect((await capture(`interaction-get ${REQUEST}`, ctx)).code).toBe(0);
		expect(sources).toHaveLength(1);
		expect(sources[0]).toContain("get_work_interaction");
		expect(sources[0]).toContain(`"requestId":"${REQUEST}"`);
	});
	test("rejects wrong or unavailable effective gateway and organization", async () => {
		for (const field of ["mcpUrl"] as const) {
			const { ctx, sources } = fixture();
			ctx[field] = undefined;
			await expect(runWork("checkpoint", ctx)).rejects.toThrow("correlate");
			expect(sources).toHaveLength(0);
		}
		const { ctx, sources } = fixture({
			gateway: "https://other.mcp.tedix.dev/mcp",
		});
		await expect(runWork("checkpoint", ctx)).rejects.toThrow("correlate");
		expect(sources).toHaveLength(0);
	});
	test("rejects canonical Work project or tenant mismatch before inbox", async () => {
		for (const item of [
			{ id: ITEM, projectId: REQUEST, orgId: ORG },
			{ id: ITEM, projectId: PROJECT, orgId: REQUEST },
		]) {
			const { ctx, sources } = fixture({ item: { workItem: item } });
			await expect(runWork("checkpoint", ctx)).rejects.toThrow("mismatch");
			expect(sources).toHaveLength(1);
		}
	});
	test("never renders errors or malformed pages as an empty successful inbox", async () => {
		const { ctx } = fixture({
			page: {
				defined: true,
				code: "FORBIDDEN",
				status: 403,
				message: "Denied",
			},
		});
		const result = await capture("checkpoint", ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		const malformed = fixture({ page: { data: [] } });
		expect((await capture("checkpoint", malformed.ctx)).code).toBe(
			WORK_EXIT_FAIL,
		);
	});
	test("does not make audit-only rows actionable and rejects cross-Work rows", async () => {
		const row = {
			canRespond: false,
			effectiveState: "open",
			request: { id: REQUEST, workItemId: ITEM, orgId: ORG },
		};
		const page = {
			data: [row],
			nextCursor: { at: "2026-10-03T09:59:00Z", id: REQUEST },
			hasMore: true,
			observedAt: "2026-10-03T10:00:00Z",
		};
		const { ctx } = fixture({ page });
		const result = await capture("checkpoint", ctx);
		const data = JSON.parse(result.out[0]!);
		expect(data.requests).toEqual([]);
		expect(data.hasMore).toBe(true);
		expect(data.nextCursor).toEqual(page.nextCursor);
		const wrong = fixture({
			page: {
				...page,
				data: [{ ...row, request: { ...row.request, workItemId: ATTEMPT } }],
			},
		});
		await expect(runWork("checkpoint", wrong.ctx)).rejects.toThrow(
			"another Work",
		);
	});
	test("bounds prompt output and explicitly preserves incompleteness", async () => {
		const { ctx } = fixture({
			page: {
				data: [
					{
						canRespond: true,
						effectiveState: "open",
						request: {
							id: REQUEST,
							workItemId: ITEM,
							orgId: ORG,
							version: 1,
							subject: "Finding",
							prompt: "x".repeat(1200),
							promptComplete: true,
						},
					},
				],
				nextCursor: null,
				hasMore: false,
				observedAt: "2026-10-03T10:00:00Z",
			},
		});
		const data = JSON.parse((await capture("checkpoint", ctx)).out[0]!);
		expect(data.requests[0].prompt.length).toBe(800);
		expect(data.requests[0].promptComplete).toBe(false);
	});
});

describe("heartbeat watch rate-pressure recovery", () => {
	function rate(status = 429, retryAfter?: number) {
		return {
			code: "TOO_MANY_REQUESTS",
			status,
			message: "Rate limit exceeded",
			...(retryAfter !== undefined ? { retryAfter } : {}),
		};
	}
	test("recovers after explicit denial using the original fence and server retry hint", async () => {
		let now = 0,
			calls = 0;
		const waits: number[] = [];
		const { ctx, sources } = makeContext({ watch: 100 }, ATTEMPT, () =>
			++calls === 2
				? rate(429, 60)
				: { expiresAt: new Date(now + 300_000).toISOString() },
		);
		ctx.heartbeatClock = {
			now: () => now,
			wait: async (ms) => {
				waits.push(ms);
				now += ms;
			},
		};
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(0);
		expect(waits).toEqual([30_000, 60_000, 10_000]);
		expect(sources).toHaveLength(3);
		for (const source of sources) {
			expect(source).toContain(ATTEMPT);
			expect(source).not.toContain("start_work_item_attempt");
		}
	});
	test("thrown tool denials cool down progressively without extending the horizon", async () => {
		let now = 0,
			calls = 0;
		const waits: number[] = [];
		const { ctx, sources } = makeContext({ watch: 90 }, ATTEMPT, () => {
			if (++calls > 1)
				throw new Error(
					"Tool rate limit exceeded. No side effect was executed.",
				);
			return { expiresAt: new Date(300_000).toISOString() };
		});
		ctx.heartbeatClock = {
			now: () => now,
			wait: async (ms) => {
				waits.push(ms);
				now += ms;
			},
		};
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(waits).toEqual([30_000, 5_000, 10_000, 20_000]);
		expect(now).toBe(65_000);
		expect(sources).toHaveLength(5);
	});
	test.each(["horizon", "lease"])(
		"refuses a retry hint beyond the confirmed %s boundary",
		async (boundary) => {
			let now = 0,
				calls = 0;
			const { ctx, sources } = makeContext(
				{ watch: boundary === "horizon" ? 60 : 600 },
				ATTEMPT,
				() =>
					++calls === 1
						? {
								expiresAt: new Date(
									boundary === "lease" ? 60_000 : 300_000,
								).toISOString(),
							}
						: rate(429, 120),
			);
			ctx.heartbeatClock = {
				now: () => now,
				wait: async (ms) => {
					now += ms;
				},
			};
			expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(
				WORK_EXIT_FAIL,
			);
			expect(sources).toHaveLength(2);
			expect(now).toBeLessThan(60_000);
		},
	);
	test("does not guess a lease or retry one-shot heartbeats", async () => {
		for (const watch of [undefined, 60]) {
			const { ctx, sources } = makeContext({ watch }, ATTEMPT, () =>
				rate(429, 5),
			);
			expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(
				WORK_EXIT_FAIL,
			);
			expect(sources).toHaveLength(1);
		}
	});
	test("stops if the cached fence changes during a rate cooldown", async () => {
		let now = 0,
			calls = 0;
		const { ctx, sources, attemptStore } = makeContext(
			{ watch: 90 },
			ATTEMPT,
			() =>
				++calls === 1 ? { expiresAt: new Date(300_000).toISOString() } : rate(),
		);
		const key = {
			workspace: "test",
			actor: "credential",
			agentSession: ctx.work.session!,
			workItemId: ITEM,
		};
		ctx.heartbeatClock = {
			now: () => now,
			wait: async (ms) => {
				now += ms;
				if (calls === 2) attemptStore.set(key, "replacement");
			},
		};
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(sources).toHaveLength(2);
		expect(attemptStore.get(key)).toBe("replacement");
	});
	test.each([403, 409, 503])(
		"does not retry non-rate HTTP%s after a confirmed renewal",
		async (status) => {
			let now = 0,
				calls = 0;
			const { ctx, sources } = makeContext({ watch: 90 }, ATTEMPT, () =>
				++calls === 1
					? { expiresAt: new Date(300_000).toISOString() }
					: { code: "REJECTED", status, message: "failure" },
			);
			ctx.heartbeatClock = {
				now: () => now,
				wait: async (ms) => {
					now += ms;
				},
			};
			expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(
				WORK_EXIT_FAIL,
			);
			expect(sources).toHaveLength(2);
		},
	);
	test("rechecks confirmed lease after a delayed cooldown and preserves structured hint", async () => {
		let now = 0,
			calls = 0;
		const { ctx, sources } = makeContext({ watch: 600 }, ATTEMPT, () =>
			++calls === 1
				? { expiresAt: new Date(300_000).toISOString() }
				: rate(429, 5),
		);
		ctx.heartbeatClock = {
			now: () => now,
			wait: async (ms) => {
				now += calls === 2 ? 300_000 : ms;
			},
		};
		expect((await capture(`heartbeat ${ITEM}`, ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(sources).toHaveLength(2);
		expect(
			boardErrorFromValue({
				ok: false,
				error: "Rate limit exceeded",
				status: 429,
				retryAfter: 600,
			}),
		).toMatchObject({ status: 429, retryAfter: 600 });
	});
});

/** Exercise the command dispatcher through the real modern JSON-RPC transport. */
function modernContext(
	work: WorkOptions = {},
	response?: (source: string) => unknown,
) {
	const fixture = makeContext(work, ATTEMPT, response);
	const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
	const wire: Array<{
		method: string;
		name?: string;
		args?: Record<string, unknown>;
	}> = [];
	const client = new TedixHomeClient({
		url: fixture.ctx.mcpUrl!,
		headers: { Authorization: "Bearer fictional-fixture" },
		timeoutMs: 60_000,
		fetch: async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			wire.push({
				method: request.method,
				name: request.params?.name,
				args: request.params?.arguments,
			});
			const result =
				request.method === "server/discover"
					? { supportedVersions: ["2026-07-28"], capabilities: {} }
					: {
							resultType: "complete",
							content: [],
							structuredContent: await invoke(
								request.params.name,
								request.params.arguments,
								{},
							),
						};
			return Response.json({ jsonrpc: "2.0", id: request.id, result });
		},
	});
	fixture.ctx.client = client;
	return { ...fixture, wire, client };
}

describe("native Work transport", () => {
	test("uses returned configured names on the modern protocol and preserves full interaction delivery", async () => {
		for (const delivery of ["auto", "review"]) {
			const complete = {
				request: { id: ITEM },
				draft: {
					delivery,
					body: "complete draft",
					metadata: { nested: { kept: true } },
				},
				responses: { data: [] },
			};
			const fixture = modernContext({}, () => complete);
			const result = await capture(`interaction-get ${ITEM}`, fixture.ctx);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.out[0]!)).toEqual(complete);
			expect(fixture.wire.map((r) => r.method)).toEqual([
				"server/discover",
				"tools/call",
				"tools/call",
				"tools/call",
				"tools/call",
			]);
			expect(fixture.wire.filter((r) => r.name).map((r) => r.name)).toEqual([
				"get_info",
				"catalog_search",
				"catalog_describe",
				"configured_work__get_work_interaction",
			]);
			expect(fixture.wire.some((r) => r.name === "code")).toBe(false);
			const before = fixture.wire.length;
			const next = await capture(`interaction-get ${ITEM}`, fixture.ctx);
			expect(next.code).toBe(0);
			expect(fixture.wire.slice(before).map((r) => r.method)).toEqual([
				"server/discover",
				"tools/call",
				"tools/call",
				"tools/call",
				"tools/call",
			]);
			await fixture.client.close();
		}
	});
	test("rejects missing, denied, ambiguous, stale and redirected descriptors before writes", async () => {
		for (const scenario of [
			"missing",
			"denied",
			"ambiguous",
			"stale",
			"redirect",
			"schema-change",
			"unsupported-input",
			"unsupported-output",
			"description-denied",
			"description-missing-authorization",
		]) {
			const fixture = makeContext({ doneWhen: "An exact result" });
			const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
			fixture.ctx.client.callTool = (async (
				name: string,
				args: Record<string, unknown>,
				options: unknown,
			) => {
				const result = (await invoke(name, args, options as never)) as Record<
					string,
					unknown
				>;
				if (name === "catalog_search") {
					const rows = result.results as Array<Record<string, unknown>>;
					const native = rows[0]!.native as Record<string, unknown>;
					if (scenario === "missing") result.results = [];
					if (scenario === "ambiguous") result.results = [rows[0], rows[0]];
					if (scenario === "denied") native.authorized = false;
					if (scenario === "stale")
						(native.schemaFreshness as Record<string, unknown>).sourceHash =
							null;
					if (scenario === "redirect") native.endpoint = "workItems/create";
				}
				if (name === "catalog_describe") {
					if (scenario === "schema-change")
						(result.native as Record<string, unknown>).toolRowId = "changed";
					if (scenario === "unsupported-input")
						result.parameters = {
							type: "object",
							properties: { id: { type: "number" } },
							required: ["id"],
						};
					if (scenario === "unsupported-output") delete result.outputSchema;
					if (scenario === "description-denied") result.authorized = false;
					if (scenario === "description-missing-authorization")
						delete result.authorized;
				}
				return result;
			}) as TedixHomeClient["callTool"];
			expect((await capture(`accept ${ITEM}`, fixture.ctx)).code).toBe(
				WORK_EXIT_FAIL,
			);
			expect(fixture.sources).toEqual([]);
		}
	});
	test("fails closed for absent bootstrap, force-CodeMode, wrong org and anonymous actor", async () => {
		for (const scenario of [
			"null",
			"force",
			"org",
			"anonymous",
			"catalog-endpoint",
		]) {
			const fixture = makeContext({ doneWhen: "An exact result" });
			const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
			fixture.ctx.client.callTool = (async (
				name: string,
				args: Record<string, unknown>,
				options: unknown,
			) => {
				if (name !== "get_info") return invoke(name, args, options as never);
				const bootstrap = nativeBootstrapFixture();
				if (scenario === "null") return { ...bootstrap, nativeContext: null };
				if (scenario === "force")
					bootstrap.nativeContext.nativeTransportAvailable = false;
				if (scenario === "org") bootstrap.nativeContext.organizationId = ITEM;
				if (scenario === "anonymous")
					bootstrap.nativeContext.actor.authType = "anonymous";
				if (scenario === "catalog-endpoint")
					bootstrap.nativeCatalog.search.endpoint = "workItems/create";
				return bootstrap;
			}) as TedixHomeClient["callTool"];
			expect((await capture(`accept ${ITEM}`, fixture.ctx)).code).toBe(
				WORK_EXIT_FAIL,
			);
			expect(fixture.nativeCalls.map((c) => c.name)).not.toContain(
				"catalog_search",
			);
			expect(fixture.sources).toEqual([]);
		}
	});
	test("captures the carrier before bootstrap awaits and binds one nonrenewing deadline", async () => {
		const fixture = makeContext({ doneWhen: "Original result" });
		const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
		fixture.ctx.client.callTool = (async (
			name: string,
			args: Record<string, unknown>,
			options: unknown,
		) => {
			if (name === "get_info") {
				fixture.ctx.work.doneWhen = "Changed";
				fixture.ctx.work.as = "another_actor";
				fixture.ctx.organizationId = ITEM;
				fixture.ctx.client.callTool = (() => {
					throw new Error("mutated carrier");
				}) as TedixHomeClient["callTool"];
			}
			return invoke(name, args, options as never);
		}) as TedixHomeClient["callTool"];
		expect((await capture(`accept ${ITEM}`, fixture.ctx)).code).toBe(0);
		expect(fixture.sources[0]).toContain("Original result");
		expect(fixture.sources[0]).not.toContain("Changed");
		const deadlines = fixture.nativeCalls.map(
			(c) => (c.options as { deadlineAt: number }).deadlineAt,
		);
		expect(new Set(deadlines).size).toBe(1);
	});
	test("does not replay a read-shaped mutation on ambiguous connection loss", async () => {
		const fixture = modernContext({ input: "{}" });
		let calls = 0;
		const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
		fixture.ctx.client.callTool = (async (
			name: string,
			args: Record<string, unknown>,
			options: unknown,
		) => {
			if (name === "configured_work__plan_work_execution_clusters") {
				calls++;
				throw new Error("connection closed after execution");
			}
			return invoke(name, args, options as never);
		}) as TedixHomeClient["callTool"];
		expect((await capture("clusters", fixture.ctx)).code).toBe(WORK_EXIT_FAIL);
		expect(calls).toBe(1);
		await fixture.client.close();
	});
	test("rejects namespace selectors for corroboration mutations", async () => {
		const fixture = makeContext({
			as: "research-lead",
			evidence: "artifact://reproduction",
		});
		await expect(runWork(`confirm ${ITEM}`, fixture.ctx)).rejects.toThrow(
			"read-only",
		);
		expect(fixture.nativeCalls).toEqual([]);
	});
});

describe("native dispatcher coverage", () => {
	test("covers every current dispatcher key through modern native transport or its local-only path", async () => {
		const direct: Record<
			string,
			{ args?: string; work?: WorkOptions; expected?: number }
		> = {
			checkpoint: { args: "" },
			"agent-turn-triage": {
				args: "",
				work: { input: JSON.stringify({ text: "Fictional turn" }) },
			},
			"agent-reply-label": {
				args: "",
				work: {
					input: JSON.stringify({
						turnText: "Fictional turn",
						replyText: "yes",
					}),
				},
			},
			"agent-reply-draft-request": {
				args: "",
				work: { input: JSON.stringify({ requestId: ITEM }) },
			},
			"agent-session-report": {
				args: "",
				work: {
					input: JSON.stringify({
						harness: "codex",
						sessionKey: "fixture",
						state: "working",
					}),
				},
			},
			"claim-files": {
				work: { repoKey: "example", paths: ["src/example.ts"] },
			},
			list: { args: "" },
			find: { args: "Example" },
			create: { args: "Example result", work: { objective: ITEM } },
			accept: { work: { doneWhen: "Example result" } },
			readiness: {},
			start: {},
			handoff: { work: { host: "codex" } },
			comment: { args: `${ITEM} An observed result` },
			"authorize-blog": {
				work: {
					campaign: "example",
					contentIds: ITEM,
					validUntil: "2026-10-09T12:00:00Z",
				},
			},
			"revoke-blog": {
				work: { campaign: "example", reason: "Example revocation" },
			},
			heartbeat: {},
			confirm: { work: { evidence: "artifact://example" } },
			settle: { work: { outcome: "succeeded" } },
			"submit-evidence": {
				work: {
					claimKey: "example",
					evidenceKind: "test_report",
					evidence: "artifact://example",
				},
			},
			complete: {},
			cancel: {},
			context: {},
			evidence: {},
			attempts: {},
			events: {},
			trailers: {},
		};
		const pathVerbs = new Set([
			"case-get",
			"case-stage",
			"case-close",
			"case-attach",
			"milestone-list",
			"milestone-create",
			"milestone-update",
			"milestone-attach",
			"milestone-dependency-add",
			"health-list",
			"health-record",
			"approval-decide",
			"interaction-get",
			"interaction-respond",
			"interaction-cancel",
			"admission-get",
			"admission-replace",
		]);
		const covered: string[] = [];
		for (const verb of workVerbNames()) {
			const spec = direct[verb];
			const fixture = modernContext(
				spec?.work ?? (spec ? {} : { input: "{}" }),
				(source) => {
					if (source.includes("triage_agent_turn"))
						return {
							status: "ok",
							urgency: "later",
							labels: {},
							urgentLabels: [],
							model: "fixture",
							policyVersion: 1,
							latencyMs: 1,
						};
					if (source.includes("label_agent_reply"))
						return { status: "ok", label: "approve", p: 0.9, model: "fixture" };
					if (source.includes("request_agent_reply_draft"))
						return { status: "queued" };
					if (source.includes("get_work_admission_specification"))
						return {
							workItemId: ITEM,
							workItemVersion: 1,
							admissionSpecRevision: "fixture-revision",
							resources: [
								{ resourceKey: "file:example:src/example.ts", quantity: 1 },
							],
							budget: null,
						};
					if (source.includes("list_work_resource_pools"))
						return {
							data: [
								{
									pool: {
										id: ITEM,
										orgId: TEST_ORG,
										resourceKey: "file:example:src/example.ts",
										allocationMode: "exclusive",
										capacity: 1,
										ownerRef: null,
										createdAt: "2026-10-07T12:00:00Z",
										updatedAt: null,
										version: 1,
									},
									activeReserved: 0,
									effectiveAvailable: 1,
								},
							],
							nextCursor: null,
						};
					if (source.includes("get_work_item_checkpoint"))
						return {
							id: ITEM,
							projectId: ATTEMPT,
							orgId: TEST_ORG,
							disposition: "accepted",
						};
					if (source.includes("list_work_interaction_cli_rows"))
						return {
							data: [],
							nextCursor: null,
							hasMore: false,
							observedAt: "2026-10-07T12:00:00Z",
						};
					if (source.includes("get_work_items_by_id"))
						return {
							workItem: { id: ITEM, disposition: "accepted", title: "Example" },
						};
					if (source.includes("start_work_item_attempt"))
						return {
							attempt: {
								id: ATTEMPT,
								externalSessionKey:
									"codex:33333333-3333-4333-8333-333333333333",
							},
						};
					if (source.includes("list_work_event_cli_rows"))
						return { events: [], nextSequence: null };
					if (/list_work_(attempt|evidence)_cli_rows/.test(source))
						return { data: [], nextCursor: null };
					return { id: ITEM };
				},
			);
			if (verb === "checkpoint")
				fixture.ctx.resolveContext = () => ({
					status: "bound",
					workspace: "test",
					mcpUrl: fixture.ctx.mcpUrl!,
					projectId: ATTEMPT,
					workItemId: ITEM,
					contextSessionId: ITEM,
					contextSource: "chat",
				});
			const tail = spec ? (spec.args ?? ITEM) : pathVerbs.has(verb) ? ITEM : "";
			const result = await capture(`${verb} ${tail}`, fixture.ctx);
			expect({ verb, code: result.code }).toEqual({
				verb,
				code: spec?.expected ?? 0,
			});
			if (verb === "trailers") expect(fixture.wire).toEqual([]);
			else {
				expect(
					fixture.wire.filter((r) => r.name).length,
				).toBeGreaterThanOrEqual(4);
				expect(
					fixture.wire
						.filter((r) => r.name)
						.every(
							(r) =>
								r.name === "get_info" ||
								r.name === "catalog_search" ||
								r.name === "catalog_describe" ||
								r.name!.startsWith("configured_"),
						),
				).toBe(true);
				expect(fixture.wire.some((r) => r.name === "code")).toBe(false);
			}
			covered.push(verb);
			await fixture.client.close();
		}
		expect(covered).toEqual(workVerbNames());
		expect(covered).toHaveLength(61);
	});
});

describe("native Work publication boundary", () => {
	test("refuses an output after caller cancellation even when an injected client ignores abort", async () => {
		const fixture = makeContext({ doneWhen: "Example result" });
		const controller = new AbortController();
		fixture.ctx.signal = controller.signal;
		const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
		fixture.ctx.client.callTool = (async (
			name: string,
			args: Record<string, unknown>,
			options: unknown,
		) => {
			const value = await invoke(name, args, options as never);
			if (name.startsWith("configured_"))
				controller.abort(new Error("Caller stopped"));
			return value;
		}) as TedixHomeClient["callTool"];
		const result = await capture(`accept ${ITEM}`, fixture.ctx);
		expect(result.code).toBe(WORK_EXIT_FAIL);
		expect(JSON.parse(result.out[0]!).error.message).toContain(
			"Caller stopped",
		);
		expect(fixture.sources).toHaveLength(1);
	});
});

describe("native agent hook factory operations", () => {
	const cases = [
		[
			"agent-turn-triage",
			"triage_agent_turn",
			{ text: "Fictional turn" },
			{
				status: "ok",
				urgency: "later",
				labels: {},
				urgentLabels: [],
				model: "fixture",
				policyVersion: 1,
				latencyMs: 1,
			},
		],
		[
			"agent-reply-label",
			"label_agent_reply",
			{ turnText: "Fictional turn", replyText: "yes" },
			{ status: "ok", label: "approve", p: 0.9, model: "fixture" },
		],
		[
			"agent-reply-draft-request",
			"request_agent_reply_draft",
			{ requestId: ITEM },
			{ status: "queued" },
		],
	] as const;
	test("calls literal configured agent descriptors once with current schemas and no code executor", async () => {
		for (const [verb, tool, input, output] of cases) {
			const { ctx, sources, nativeCalls } = modernContext(
				{ input: JSON.stringify(input) },
				() => output,
			);
			const result = await capture(verb, ctx);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.out[0]!)).toEqual(output);
			expect(sources).toHaveLength(1);
			expect(sources[0]).toContain(`agent.${tool}`);
			expect(
				nativeCalls.filter((x) => x.name === `configured_agent__${tool}`),
			).toHaveLength(1);
			expect(nativeCalls.some((x) => x.name === "code")).toBe(false);
		}
	});
	test("refuses invalid owning input before bootstrap and invalid output without publishing", async () => {
		for (const [verb] of cases) {
			const bad = modernContext({ input: "{}" });
			const inputResult = await capture(verb, bad.ctx);
			expect(inputResult.code).not.toBe(0);
			expect(bad.nativeCalls).toHaveLength(0);
			const [, , input] = cases.find((x) => x[0] === verb)!;
			const badOutput = modernContext({ input: JSON.stringify(input) }, () => ({
				status: "invented",
			}));
			const outputResult = await capture(verb, badOutput.ctx);
			expect(outputResult.code).not.toBe(0);
			expect(outputResult.out.join(" ")).not.toContain('"status":"invented"');
			expect(badOutput.sources).toHaveLength(1);
		}
	});
	test("refuses ineligible or unauthorized configured routes before each purpose call", async () => {
		for (const [verb, , input, output] of cases)
			for (const field of ["eligible", "authorized"]) {
				const fixture = modernContext(
					{ input: JSON.stringify(input) },
					() => output,
				);
				const invoke = fixture.ctx.client.callTool.bind(fixture.ctx.client);
				fixture.ctx.client.callTool = (async (name, args, options) => {
					const result = (await invoke(name, args, options)) as any;
					if (name === "catalog_search")
						result.results[0].native[field] = false;
					return result;
				}) as TedixHomeClient["callTool"];
				expect((await capture(verb, fixture.ctx)).code).not.toBe(0);
				expect(fixture.sources).toEqual([]);
				expect(fixture.wire.some((x) => x.name === "code")).toBe(false);
				await fixture.client.close();
			}
	});

	test("ambiguous draft mutation failure never repeats or falls back", async () => {
		const { ctx, sources, nativeCalls } = modernContext(
			{ input: JSON.stringify({ requestId: ITEM }) },
			() => {
				throw new Error("Connection dropped after dispatch");
			},
		);
		const result = await capture("agent-reply-draft-request", ctx);
		expect(result.code).not.toBe(0);
		expect(sources).toHaveLength(1);
		expect(
			nativeCalls.filter(
				(x) => x.name === "configured_agent__request_agent_reply_draft",
			),
		).toHaveLength(1);
		expect(nativeCalls.some((x) => x.name === "code")).toBe(false);
	});
});
