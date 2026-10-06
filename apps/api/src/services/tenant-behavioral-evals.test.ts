import { DatabaseSync } from "node:sqlite";
import type { TenantBehavioralEvalRunManifest } from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { createDbClient } from "@tedix/db/client";
import type { DbClient } from "@tedix/db/client";
import {
	kernelRuntimeEvents,
	organizations,
	runtimeSubmissions,
} from "@tedix/db/schema";
import {
	createTenantBehavioralEval,
	getTenantBehavioralEvalRunDetail,
	startTenantBehavioralEvalRun,
} from "@tedix/db/queries/tenant-behavioral-evals";
import {
	tenantBehavioralEvalAssertionResults,
	tenantBehavioralEvalCaseAttempts,
	tenantBehavioralEvalCaseRuns,
	tenantBehavioralEvalDefinitions,
	tenantBehavioralEvalRevisions,
	tenantBehavioralEvalRuns,
} from "@tedix/db/schema/tenant-behavioral-evals";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import {
	gradeTenantBehavioralEvalCase,
	advanceTenantBehavioralEvalRun,
	assertTenantBehavioralEvalStreamPage,
	ensureTenantBehavioralEvalHomeRun,
	isTenantBehavioralEvalStreamDrained,
	isTenantBehavioralEvalStalledHomeRun,
	tenantBehavioralEvalRetryableHomeFailure,
	mergeTenantBehavioralEvalEffectsSuppressed,
	tenantBehavioralEvalExecutionReceipt,
	tenantBehavioralEvalEventObservations,
	tenantBehavioralEvalMetadataObservation,
} from "./tenant-behavioral-evals";
const provenance = {
	manifest: {
		schemaVersion: 1,
		definitionId: "def",
		revisionId: "rev",
		revisionNumber: 1,
		specDigest: "spec-sha",
		caseIds: ["case"],
		assetTediId: "tedi",
		lane: "kernel_route_observe_v1",
		executionPolicy: "observe_only",
		modelSelection: "kernel_runtime_default",
		requestedModelRef: null,
		capturedAt: "2026-09-25T00:00:00.000Z",
	} satisfies TenantBehavioralEvalRunManifest,
	manifestDigest: "manifest-sha",
};
function stateDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const table of [
		tenantBehavioralEvalDefinitions,
		tenantBehavioralEvalRevisions,
		tenantBehavioralEvalRuns,
		tenantBehavioralEvalCaseRuns,
		tenantBehavioralEvalCaseAttempts,
		tenantBehavioralEvalAssertionResults,
		organizations,
		runtimeSubmissions,
		kernelRuntimeEvents,
	])
		sqlite.exec(schemaDdl(table));
	return createDbClient(createD1Facade(sqlite));
}
async function seedHomeEvidence(
	db: DbClient,
	input: {
		runId: string;
		organizationId?: string;
		conversationId?: string;
		content?: string;
	},
) {
	const organizationId = input.organizationId ?? "org";
	const conversationId = input.conversationId ?? "eval:run:case";
	const content = input.content ?? "hello";
	await db
		.insert(organizations)
		.values({ id: organizationId, name: organizationId, slug: organizationId })
		.onConflictDoNothing();
	await db.insert(runtimeSubmissions).values({
		id: `sub:${input.runId}`,
		organizationId,
		subjectKind: "kernel",
		subjectId: `kernel:${organizationId}`,
		sourceKind: "home",
		conversationId,
		runId: input.runId,
		idempotencyKey: input.runId,
		metadata: { executionPolicy: "observe_only" },
	});
	const messageId = `${input.runId}:input`;
	await db.insert(kernelRuntimeEvents).values({
		id: homeRuntimeEventId({
			organizationId,
			kind: "message.received",
			conversationId,
			runId: input.runId,
			messageId,
		}),
		organizationId,
		kind: "message.received",
		conversationId,
		runId: input.runId,
		messageId,
		payload: { role: "user", content },
	});
}
describe("tenant behavioral evaluation grading", () => {
	it("recognizes only the canonical terminal mark_stalled marker", () => {
		const base = {
			id: "home",
			organizationId: "org",
			conversationId: "eval:run:case",
			status: "failed",
		};
		expect(
			isTenantBehavioralEvalStalledHomeRun({
				...base,
				metadata: { kernelReconciliation: { action: "mark_stalled" } },
			}),
		).toBe(true);
		for (const metadata of [
			{},
			{ kernelReconciliation: { action: "mark_expired" } },
			{ error: "mark_stalled" },
		])
			expect(isTenantBehavioralEvalStalledHomeRun({ ...base, metadata })).toBe(
				false,
			);
		expect(
			isTenantBehavioralEvalStalledHomeRun({
				...base,
				status: "completed",
				metadata: { kernelReconciliation: { action: "mark_stalled" } },
			}),
		).toBe(false);
		expect(
			tenantBehavioralEvalRetryableHomeFailure({
				...base,
				metadata: {
					bodyExecutionResult: {
						status: "failed",
						error: { kind: "model", retryable: true },
					},
				},
			}),
		).toBe("model_unavailable");
		expect(
			tenantBehavioralEvalRetryableHomeFailure({
				...base,
				metadata: {
					bodyExecutionResult: {
						status: "failed",
						error: { kind: "policy", retryable: false },
					},
				},
			}),
		).toBeNull();
	});
	it("retries a typed model outage while preserving successful, semantic, and policy cases", async () => {
		const db = stateDb();
		const spec = {
			lane: "kernel_route_observe_v1" as const,
			cases: ["good", "retry", "semantic", "policy"].map((id) => ({
				id,
				input: id,
				assertions: [{ type: "route_is" as const, expected: "answer" }],
			})),
		};
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		const homeRuns = new Map<
			string,
			{
				id: string;
				organizationId: string;
				conversationId: string;
				inputMessageId: string;
				status: string;
				metadata: Record<string, unknown>;
			}
		>();
		const enqueued: string[] = [];
		const conversations: string[] = [];
		for (let step = 0; step < 20; step++) {
			const before = (await getTenantBehavioralEvalRunDetail(
				db,
				"org",
				"run",
			))!;
			if (before.run.status === "completed") break;
			await advanceTenantBehavioralEvalRun({
				db,
				organizationId: "org",
				runId: "run",
				expectedVersion: before.run.version,
				readRun: async (id) => homeRuns.get(id) ?? null,
				enqueue: async (args) => {
					enqueued.push(args.idempotencyKey);
					conversations.push(args.conversationId);
					const caseId = args.conversationId.split(":")[2]!;
					await seedHomeEvidence(db, {
						runId: args.idempotencyKey,
						conversationId: args.conversationId,
						content: caseId,
					});
					const modelOutage = args.idempotencyKey === "eval-run-retry";
					const policyDenial = caseId === "policy";
					const home = {
						id: args.idempotencyKey,
						organizationId: "org",
						conversationId: args.conversationId,
						inputMessageId: `${args.idempotencyKey}:input`,
						status: modelOutage || policyDenial ? "failed" : "completed",
						metadata: {
							executionPolicy: "observe_only",
							effectsSuppressed: true,
							kernelObservation: {
								selectedRoute:
									caseId === "policy"
										? {}
										: {
												routeKind: caseId === "semantic" ? "tool" : "answer",
											},
								outcome: "effects_suppressed",
							},
							...(modelOutage || policyDenial
								? {
										bodyExecutionResult: {
											status: "failed",
											error: {
												kind: modelOutage ? "model" : "policy",
												retryable: modelOutage,
											},
										},
									}
								: {}),
						},
					};
					homeRuns.set(home.id, home);
					return home;
				},
				readEvents: async ({ runId, offset }) => ({
					events:
						offset === 0
							? [
									{
										id: `${runId}:terminal`,
										kind:
											homeRuns.get(runId)?.status === "failed"
												? "run.failed"
												: "run.completed",
										createdAt: "now",
									},
								]
							: [],
					stream: {
						streamId: `home:${runId}`,
						offset,
						nextOffset: offset === 0 ? 1 : offset,
						closed: true,
					},
				}),
			});
		}
		const detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.run).toMatchObject({ status: "completed", passed: false });
		expect(enqueued).toHaveLength(5);
		const retriedHomeId = enqueued.find((id) =>
			/^eval-[0-9a-f-]{36}$/.test(id),
		);
		expect(retriedHomeId).toBeDefined();
		expect(new Set(enqueued)).toEqual(
			new Set([
				"eval-run-good",
				"eval-run-retry",
				retriedHomeId!,
				"eval-run-semantic",
				"eval-run-policy",
			]),
		);
		expect(new Set(conversations)).toEqual(
			new Set([
				"eval:run:good",
				"eval:run:retry",
				"eval:run:retry:attempt-2",
				"eval:run:semantic",
				"eval:run:policy",
			]),
		);
		expect(
			detail.caseAttempts
				.map((row) => [row.homeRunId, row.disposition])
				.sort((a, b) => a[0]!.localeCompare(b[0]!)),
		).toEqual(
			[
				["eval-run-good", "passed"],
				["eval-run-retry", "unresolved"],
				[retriedHomeId!, "passed"],
				["eval-run-semantic", "failed"],
				["eval-run-policy", "unresolved"],
			].sort((a, b) => a[0]!.localeCompare(b[0]!)),
		);
		expect(
			detail.caseRuns.find((row) => row.caseId === "good")?.homeRunId,
		).toBe("eval-run-good");
		expect(
			detail.caseRuns.find((row) => row.caseId === "retry")?.attemptNumber,
		).toBe(2);
		expect(
			detail.caseRuns.find((row) => row.caseId === "policy")?.attemptNumber,
		).toBe(1);
		expect(detail.assertionResults).toHaveLength(4);
	});
	it("stops after three stalled attempts with an unresolved gate", async () => {
		const db = stateDb();
		const spec = {
			lane: "kernel_route_observe_v1" as const,
			cases: [
				{
					id: "case",
					input: "x",
					assertions: [{ type: "route_is" as const, expected: "answer" }],
				},
			],
		};
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		const homes = new Map<
			string,
			{
				id: string;
				organizationId: string;
				conversationId: string;
				inputMessageId: string;
				status: string;
				metadata: Record<string, unknown>;
			}
		>();
		const enqueued: string[] = [];
		for (let step = 0; step < 20; step++) {
			const before = (await getTenantBehavioralEvalRunDetail(
				db,
				"org",
				"run",
			))!;
			if (before.run.status === "completed") break;
			await advanceTenantBehavioralEvalRun({
				db,
				organizationId: "org",
				runId: "run",
				expectedVersion: before.run.version,
				readRun: async (id) => homes.get(id) ?? null,
				enqueue: async (args) => {
					enqueued.push(args.idempotencyKey);
					await seedHomeEvidence(db, {
						runId: args.idempotencyKey,
						conversationId: args.conversationId,
						content: "x",
					});
					const home = {
						id: args.idempotencyKey,
						organizationId: "org",
						conversationId: args.conversationId,
						inputMessageId: `${args.idempotencyKey}:input`,
						status: "failed",
						metadata: {
							executionPolicy: "observe_only",
							kernelReconciliation: { action: "mark_stalled" },
						},
					};
					homes.set(home.id, home);
					return home;
				},
				readEvents: async ({ runId, offset }) => ({
					events:
						offset === 0
							? [
									{
										id: `${runId}:failed`,
										kind: "run.failed",
										createdAt: "now",
									},
								]
							: [],
					stream: {
						streamId: `home:${runId}`,
						offset,
						nextOffset: offset === 0 ? 1 : offset,
						closed: true,
					},
				}),
			});
		}
		const detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.run).toMatchObject({ status: "completed", passed: false });
		expect(enqueued).toHaveLength(3);
		expect(new Set(enqueued).size).toBe(3);
		expect(detail.caseAttempts.map((row) => row.homeRunId).sort()).toEqual(
			[...enqueued].sort(),
		);
		expect(
			detail.caseAttempts.every((row) => row.disposition === "unresolved"),
		).toBe(true);
		expect(detail.caseRuns[0]).toMatchObject({
			attemptNumber: 3,
			status: "failed",
			disposition: "unresolved",
			error: "mark_stalled",
		});
		expect(detail.assertionResults).toMatchObject([
			{ disposition: "unresolved", passed: false },
		]);
		// Historical completed runs have no snapshots and remain readable.
		await db.delete(tenantBehavioralEvalCaseAttempts);
		const historical = (await getTenantBehavioralEvalRunDetail(
			db,
			"org",
			"run",
		))!;
		expect(historical.run.status).toBe("completed");
		expect(historical.caseAttempts).toEqual([]);
	});
	it("grades only curated durable observations", () => {
		const rows = gradeTenantBehavioralEvalCase(
			{
				id: "c",
				input: "x",
				assertions: [
					{ type: "route_is", expected: "answer" },
					{ type: "terminal_status_is", expected: "completed" },
					{ type: "no_effects" },
				],
			},
			{
				selectedRoute: "answer",
				terminalStatus: "completed",
				effectsSuppressed: true,
			},
		);
		expect(rows.map((row) => row.passed)).toEqual([true, true, true]);
	});
	it("does not infer missing no-effect evidence", () => {
		expect(
			gradeTenantBehavioralEvalCase(
				{ id: "c", input: "x", assertions: [{ type: "no_effects" }] },
				{ selectedRoute: null, terminalStatus: null, effectsSuppressed: null },
			)[0],
		).toMatchObject({
			passed: false,
			severity: "gate",
			disposition: "unresolved",
		});
	});
	it("distinguishes observed failure from unresolved evidence and preserves soft severity", () => {
		expect(
			gradeTenantBehavioralEvalCase(
				{
					id: "c",
					input: "x",
					assertions: [
						{ type: "route_is", expected: "answer" },
						{
							type: "terminal_status_is",
							expected: "completed",
							severity: "soft",
						},
					],
				},
				{
					selectedRoute: "tool",
					terminalStatus: null,
					effectsSuppressed: true,
				},
			).map((row) => [row.severity, row.disposition]),
		).toEqual([
			["gate", "failed"],
			["soft", "unresolved"],
		]);
	});
	it("reads the canonical observe-only run metadata", () => {
		expect(
			tenantBehavioralEvalMetadataObservation({
				executionPolicy: "observe_only",
				effectsSuppressed: true,
				kernelObservation: {
					selectedRoute: { routeKind: "delegate_tedi" },
					outcome: "effects_suppressed",
				},
			}),
		).toEqual({ selectedRoute: "delegate_tedi", effectsSuppressed: true });
		expect(tenantBehavioralEvalMetadataObservation({})).toEqual({
			selectedRoute: null,
			effectsSuppressed: null,
		});
	});
	it("records observed Home model provenance without inventing missing fields", () => {
		expect(
			tenantBehavioralEvalExecutionReceipt({
				routerVersion: "router-v1",
				bodyExecutionResult: {
					usage: {
						provider: "workers-ai",
						model: "@cf/model",
						inputTokens: 9,
						outputTokens: 0,
					},
					harnessVersionId: "harness-v1",
					traceBundleId: "trace-v1",
					durationMs: 21,
				},
			}),
		).toEqual({
			schemaVersion: 1,
			source: "home_terminal_metadata",
			observedProvider: "workers-ai",
			observedModel: "@cf/model",
			inputTokens: 9,
			outputTokens: 0,
			reasoningTokens: null,
			harnessVersionId: "harness-v1",
			traceBundleId: "trace-v1",
			routerVersion: "router-v1",
			durationMs: 21,
		});
		expect(
			tenantBehavioralEvalExecutionReceipt({
				bodyExecutionResult: {
					usage: { provider: null, model: null, inputTokens: -1 },
				},
			}),
		).toMatchObject({
			observedProvider: null,
			observedModel: null,
			inputTokens: null,
		});
		expect(tenantBehavioralEvalExecutionReceipt(undefined)).toMatchObject({
			observedProvider: null,
			observedModel: null,
		});
	});
	it("invalidates no-effects evidence when an effect event appears", () => {
		expect(
			tenantBehavioralEvalEventObservations([
				{ id: "event", kind: "tool.completed", createdAt: "now" },
			]).effectObserved,
		).toBe(true);
		expect(
			tenantBehavioralEvalEventObservations([
				{ id: "child", kind: "subagent.started", createdAt: "now" },
			]).effectObserved,
		).toBe(true);
	});
	it("grades only after a second closed empty page with a stable cursor", () => {
		expect(
			isTenantBehavioralEvalStreamDrained({
				previouslyClosed: true,
				currentClosed: true,
				eventCount: 0,
				storedCursor: 4,
				nextOffset: 4,
			}),
		).toBe(true);
		expect(
			isTenantBehavioralEvalStreamDrained({
				previouslyClosed: false,
				currentClosed: true,
				eventCount: 0,
				storedCursor: 4,
				nextOffset: 4,
			}),
		).toBe(false);
		expect(
			isTenantBehavioralEvalStreamDrained({
				previouslyClosed: true,
				currentClosed: true,
				eventCount: 0,
				storedCursor: 4,
				nextOffset: 5,
			}),
		).toBe(false);
	});
	it("keeps an earlier effect observation sticky across a clean terminal page", () => {
		expect(
			mergeTenantBehavioralEvalEffectsSuppressed({
				previous: false,
				effectObserved: false,
				terminalMetadata: true,
			}),
		).toBe(false);
	});
	it("reads before enqueue and reuses the same Home idempotency key", async () => {
		const db = stateDb();
		let enqueues = 0;
		let home: {
			id: string;
			organizationId: string;
			conversationId: string;
			inputMessageId: string;
			metadata: { executionPolicy: "observe_only" };
		} | null = null;
		const result = await ensureTenantBehavioralEvalHomeRun({
			db,
			runId: "home-1",
			organizationId: "org",
			conversationId: "eval:run:case",
			content: "hello",
			readRun: async () => home,
			enqueue: async (args) => {
				enqueues++;
				expect(args).toMatchObject({
					idempotencyKey: "home-1",
					executionPolicy: "observe_only",
				});
				await seedHomeEvidence(db, { runId: "home-1" });
				home = {
					id: "home-1",
					organizationId: "org",
					conversationId: "eval:run:case",
					inputMessageId: "home-1:input",
					metadata: { executionPolicy: "observe_only" },
				};
				return home;
			},
		});
		expect(result).toBe(home);
		expect(enqueues).toBe(1);
		await ensureTenantBehavioralEvalHomeRun({
			db,
			runId: "home-1",
			organizationId: "org",
			conversationId: "eval:run:case",
			content: "hello",
			readRun: async () => home,
			enqueue: async () => {
				enqueues++;
				return {};
			},
		});
		expect(enqueues).toBe(1);
	});
	it("fails closed on Home identity and pinned-input collisions", async () => {
		const db = stateDb();
		await seedHomeEvidence(db, { runId: "home-collision", content: "other" });
		const canonical = {
			id: "home-collision",
			organizationId: "org",
			conversationId: "eval:run:case",
			inputMessageId: "home-collision:input",
			metadata: { executionPolicy: "observe_only" as const },
		};
		await expect(
			ensureTenantBehavioralEvalHomeRun({
				db,
				runId: "home-collision",
				organizationId: "org",
				conversationId: "eval:run:case",
				content: "expected",
				readRun: async () => canonical,
				enqueue: async () => canonical,
			}),
		).rejects.toThrow("input evidence");
		await expect(
			ensureTenantBehavioralEvalHomeRun({
				db,
				runId: "home-collision",
				organizationId: "org",
				conversationId: "eval:run:case",
				content: "other",
				readRun: async () => ({ ...canonical, conversationId: "foreign" }),
				enqueue: async () => canonical,
			}),
		).rejects.toThrow("identity");
	});
	it("does not adopt a Home row without its immutable policy claim", async () => {
		const db = stateDb();
		await expect(
			ensureTenantBehavioralEvalHomeRun({
				db,
				runId: "unclaimed",
				organizationId: "org",
				conversationId: "eval:run:case",
				content: "hello",
				readRun: async () => ({
					id: "unclaimed",
					organizationId: "org",
					conversationId: "eval:run:case",
					inputMessageId: "unclaimed:input",
					metadata: { executionPolicy: "observe_only" },
				}),
				enqueue: async () => {
					throw new Error("not reached");
				},
			}),
		).rejects.toThrow("policy claim");
	});
	it("recovers a matching Home run after an unknown enqueue outcome", async () => {
		const db = stateDb();
		const home = {
			id: "home-unknown",
			organizationId: "org",
			conversationId: "eval:run:case",
			inputMessageId: "home-unknown:input",
			metadata: { executionPolicy: "observe_only" as const },
		};
		let visible = false;
		const request = () =>
			ensureTenantBehavioralEvalHomeRun({
				db,
				runId: home.id,
				organizationId: home.organizationId,
				conversationId: home.conversationId,
				content: "hello",
				readRun: async () => (visible ? home : null),
				enqueue: async () => {
					await seedHomeEvidence(db, { runId: home.id });
					visible = true;
					throw new Error("transport outcome unknown");
				},
			});
		await expect(request()).rejects.toThrow("outcome unknown");
		await expect(request()).resolves.toEqual(home);
	});
	it("rejects mismatched or discontinuous Home stream receipts", () => {
		const page = {
			events: [{ id: "e", kind: "run.started" as const, createdAt: "now" }],
			stream: {
				streamId: "home:home-1",
				offset: 2,
				nextOffset: 3,
				closed: false,
			},
		};
		expect(() =>
			assertTenantBehavioralEvalStreamPage({
				runId: "home-1",
				conversationId: "eval:run:case",
				offset: 2,
				page,
			}),
		).not.toThrow();
		for (const invalid of [
			{ ...page, stream: { ...page.stream, streamId: "home:other" } },
			{ ...page, stream: { ...page.stream, offset: 1 } },
			{ ...page, stream: { ...page.stream, nextOffset: 4 } },
		])
			expect(() =>
				assertTenantBehavioralEvalStreamPage({
					runId: "home-1",
					conversationId: "eval:run:case",
					offset: 2,
					page: invalid,
				}),
			).toThrow("stream");
	});
	it("drives the durable state machine and repairs interrupted assertion persistence", async () => {
		const db = stateDb();
		const spec = {
			lane: "kernel_route_observe_v1" as const,
			cases: [
				{
					id: "case",
					input: "route",
					assertions: [
						{ type: "route_is" as const, expected: "answer" },
						{ type: "terminal_status_is" as const, expected: "completed" },
						{ type: "no_effects" as const, severity: "soft" as const },
					],
				},
			],
		};
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		let enqueues = 0,
			page = 0;
		const metadata = {
			executionPolicy: "observe_only",
			effectsSuppressed: true,
			kernelObservation: {
				selectedRoute: { routeKind: "answer" },
				outcome: "effects_suppressed",
			},
			bodyExecutionResult: {
				usage: { provider: "workers-ai", model: "@cf/model" },
			},
		};
		let homeCreated = false;
		const homeRun = {
			id: "eval-run-case",
			organizationId: "org",
			conversationId: "eval:run:case",
			inputMessageId: "eval-run-case:input",
			metadata,
		};
		const advance = (expectedVersion: number) =>
			advanceTenantBehavioralEvalRun({
				db,
				organizationId: "org",
				runId: "run",
				expectedVersion,
				readRun: async () => (homeCreated ? homeRun : null),
				enqueue: async (args) => {
					enqueues++;
					expect(args).not.toHaveProperty("attachments");
					await seedHomeEvidence(db, {
						runId: "eval-run-case",
						content: "route",
					});
					homeCreated = true;
					return { ...homeRun, metadata: { executionPolicy: "observe_only" } };
				},
				readEvents: async () =>
					page++ === 0
						? {
								events: [
									{ id: "effect", kind: "tool.completed", createdAt: "now" },
									{ id: "terminal", kind: "run.completed", createdAt: "now" },
								],
								stream: {
									streamId: "home:eval-run-case",
									offset: 0,
									nextOffset: 2,
									closed: true,
								},
							}
						: {
								events: [],
								stream: {
									streamId: "home:eval-run-case",
									offset: 2,
									nextOffset: 2,
									closed: true,
								},
							},
			});
		await advance(0);
		await advance(1);
		expect(
			(await getTenantBehavioralEvalRunDetail(db, "org", "run"))?.caseRuns[0]
				?.executionReceipt,
		).toBeNull();
		await advance(2);
		expect(enqueues).toBe(1);
		let detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.caseRuns[0]).toMatchObject({
			drained: true,
			effectsSuppressed: false,
			executionReceipt: {
				observedProvider: "workers-ai",
				observedModel: "@cf/model",
			},
		});
		expect(detail.assertionResults).toHaveLength(3);
		expect(detail.caseAttempts).toHaveLength(1);
		// Simulate a crash after the assertion rows and case grade committed but
		// before the immutable attempt snapshot was sealed.
		await db.delete(tenantBehavioralEvalCaseAttempts);
		await advance(3);
		detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.assertionResults).toHaveLength(3);
		expect(detail.caseAttempts).toHaveLength(1);
		await db
			.delete(tenantBehavioralEvalAssertionResults)
			.where(eq(tenantBehavioralEvalAssertionResults.assertionIndex, 1));
		await advance(4);
		detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.assertionResults).toHaveLength(3);
		await advance(5);
		detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.run).toMatchObject({
			status: "completed",
			passed: true,
			version: 7,
		});
		expect(detail.caseRuns[0]?.disposition).toBe("failed");
		expect(
			detail.assertionResults.find((row) => row.type === "no_effects"),
		).toMatchObject({ severity: "soft", disposition: "failed" });
	});
	it("does not enqueue missing or terminal evaluation runs", async () => {
		const db = stateDb();
		let enqueues = 0;
		const deps = {
			db,
			organizationId: "org",
			expectedVersion: 0,
			readRun: async () => null,
			enqueue: async () => {
				enqueues++;
				return {};
			},
			readEvents: async () => {
				throw new Error("not reached");
			},
		};
		await expect(
			advanceTenantBehavioralEvalRun({ ...deps, runId: "missing" }),
		).rejects.toThrow();
		const spec = {
			lane: "kernel_route_observe_v1" as const,
			cases: [
				{
					id: "case",
					input: "x",
					assertions: [{ type: "no_effects" as const }],
				},
			],
		};
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "failed",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "failed",
			payloadDigest: "failed",
			...provenance,
			cases: spec.cases,
		});
		await db
			.update(tenantBehavioralEvalRuns)
			.set({ status: "failed" })
			.where(eq(tenantBehavioralEvalRuns.id, "failed"));
		await expect(
			advanceTenantBehavioralEvalRun({ ...deps, runId: "failed" }),
		).rejects.toThrow();
		expect(enqueues).toBe(0);
	});
	it("records a bounded advance failure without consuming the case", async () => {
		const db = stateDb();
		const spec = {
			lane: "kernel_route_observe_v1" as const,
			cases: [
				{
					id: "case",
					input: "x",
					assertions: [{ type: "no_effects" as const }],
				},
			],
		};
		await createTenantBehavioralEval(db, {
			id: "def",
			revisionId: "rev",
			organizationId: "org",
			tediId: "tedi",
			name: "Eval",
			spec,
		});
		await startTenantBehavioralEvalRun(db, {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			idempotencyKey: "key",
			payloadDigest: "digest",
			...provenance,
			cases: spec.cases,
		});
		let accepted = false;
		let enqueues = 0;
		const home = {
			id: "eval-run-case",
			organizationId: "org",
			conversationId: "eval:run:case",
			inputMessageId: "eval-run-case:input",
			metadata: { executionPolicy: "observe_only" },
		};
		await expect(
			advanceTenantBehavioralEvalRun({
				db,
				organizationId: "org",
				runId: "run",
				expectedVersion: 0,
				readRun: async () => (accepted ? home : null),
				enqueue: async () => {
					enqueues++;
					await seedHomeEvidence(db, { runId: home.id, content: "x" });
					accepted = true;
					throw new Error("Evaluation service step timed out");
				},
				readEvents: async () => {
					throw new Error("not reached");
				},
			}),
		).rejects.toThrow("timed out");
		const detail = (await getTenantBehavioralEvalRunDetail(db, "org", "run"))!;
		expect(detail.run).toMatchObject({
			status: "running",
			passed: null,
			lastAdvanceError: "timeout",
			lastAdvanceErrorPhase: "dispatch",
			lastAdvanceErrorRetryable: true,
		});
		expect(detail.caseRuns[0]).toMatchObject({
			status: "pending",
			attemptNumber: 1,
			disposition: "unresolved",
			error: "timeout",
		});
		await advanceTenantBehavioralEvalRun({
			db,
			organizationId: "org",
			runId: "run",
			expectedVersion: detail.run.version,
			readRun: async () => home,
			enqueue: async () => {
				enqueues++;
				return home;
			},
			readEvents: async () => {
				throw new Error("not reached");
			},
		});
		const recovered = (await getTenantBehavioralEvalRunDetail(
			db,
			"org",
			"run",
		))!;
		expect(enqueues).toBe(1);
		expect(recovered.caseRuns[0]).toMatchObject({
			attemptNumber: 1,
			homeRunId: home.id,
			status: "enqueued",
		});
		expect(recovered.caseAttempts).toHaveLength(0);
	});
});
