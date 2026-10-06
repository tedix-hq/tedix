import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { mineHomeOperatorDecisions } from "./home-reflection-producer";

// ────────────────────────────────────────────────────────────────────────────
// Minimal in-memory stubs for D1 / Drizzle patterns
// ────────────────────────────────────────────────────────────────────────────

type AuditRow = {
	id: string;
	organizationId: string;
	actorId: string;
	actorType: string;
	action: string;
	resourceType: string;
	resourceId: string | null;
	metadata: Record<string, unknown> | null;
	ipAddress: string | null;
	userAgent: string | null;
	timestamp: Date;
};

type KernelRuntimeEventRow = {
	id: string;
	organizationId: string;
	kind: string;
	conversationId: string;
	runId: string | null;
	payload: Record<string, unknown> | null;
	runtimeMetadata: Record<string, unknown> | null;
	createdAt: string;
};

type MemoryFactRow = {
	id: string;
	organizationId: string;
	source: string;
	archivedAt: string | null;
};

// ────────────────────────────────────────────────────────────────────────────
// Mock the heavy boundary functions so unit tests don't need real D1
// ────────────────────────────────────────────────────────────────────────────

vi.mock("@tedix/db/queries/memory-graph/domains", () => ({
	getOrCreateDomain: vi.fn().mockResolvedValue({ id: "domain-ops-1" }),
}));

vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	createFact: vi.fn().mockResolvedValue({ id: "fact-new-1" }),
	findFactBySourceHash: vi.fn().mockResolvedValue(null),
	recordFactVerification: vi.fn().mockResolvedValue(undefined),
}));

import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import {
	createFact,
	findFactBySourceHash,
	recordFactVerification,
} from "@tedix/db/queries/memory-graph/facts";

const mockCreateFact = vi.mocked(createFact);
const mockFindFactBySourceHash = vi.mocked(findFactBySourceHash);
const mockGetOrCreateDomain = vi.mocked(getOrCreateDomain);
const mockRecordFactVerification = vi.mocked(recordFactVerification);

// Also mock the source-dedup query (hasFact) — we mock the DB select response
// to control whether a source-duplicate exists.

beforeEach(() => {
	vi.clearAllMocks();
	mockFindFactBySourceHash.mockResolvedValue(null);
	mockGetOrCreateDomain.mockResolvedValue({ id: "domain-ops-1" } as ReturnType<
		typeof getOrCreateDomain
	> extends Promise<infer T>
		? T
		: never);
	mockCreateFact.mockResolvedValue({ id: "fact-new-1" } as ReturnType<
		typeof createFact
	> extends Promise<infer T>
		? T
		: never);
	mockRecordFactVerification.mockResolvedValue(undefined);
});

const ORG = "org-test-1";

function makeAuditEvent(
	overrides: Partial<AuditRow> & { action: AuditRow["action"] },
): AuditRow {
	return {
		id: crypto.randomUUID(),
		organizationId: ORG,
		actorId: "user-123",
		actorType: "user",
		action: overrides.action,
		resourceType: "approval_request",
		resourceId: null,
		metadata: overrides.metadata ?? null,
		ipAddress: null,
		userAgent: null,
		timestamp: new Date(),
		...overrides,
	};
}

function makePlanEvent(
	overrides: Partial<KernelRuntimeEventRow> & {
		payload: KernelRuntimeEventRow["payload"];
	},
): KernelRuntimeEventRow {
	return {
		id: crypto.randomUUID(),
		organizationId: ORG,
		kind: "decision.recorded",
		conversationId: "conv-plan-1",
		runId: "run-plan-1",
		payload: overrides.payload,
		runtimeMetadata: null,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: build a DB stub with controlled select responses
// ────────────────────────────────────────────────────────────────────────────

const DRIZZLE_NAME_SYM = Symbol.for("drizzle:Name");

function getDrizzleTableName(table: unknown): string | null {
	if (table == null || typeof table !== "object") return null;
	return (
		((table as Record<symbol, unknown>)[DRIZZLE_NAME_SYM] as string | null) ??
		null
	);
}

/**
 * Build a minimal DB stub that distinguishes queries by drizzle table name.
 *   - audit_events:           .select().from().where().orderBy().limit()
 *   - kernel_runtime_events:  .select().from().where().orderBy().limit()
 *   - memory_facts:           .select().from().where().limit()
 */

function stubDb(
	auditRows: AuditRow[],
	memFactRows: MemoryFactRow[] = [],
	planEventRows: KernelRuntimeEventRow[] = [],
) {
	const db = {
		select() {
			return {
				from(table: unknown) {
					const tableName = getDrizzleTableName(table);
					const isAudit = tableName === "audit_events";
					const isPlanEvents = tableName === "kernel_runtime_events";
					return {
						where(_cond: unknown) {
							if (isAudit) {
								return {
									orderBy(_ord: unknown) {
										return {
											limit(_n: number) {
												return Promise.resolve(auditRows);
											},
										};
									},
								};
							}
							if (isPlanEvents) {
								return {
									orderBy(_ord: unknown) {
										return {
											limit(_n: number) {
												return Promise.resolve(planEventRows);
											},
										};
									},
								};
							}
							// memory_facts path: per-event source dedup → .limit()
							return {
								limit(n: number) {
									return Promise.resolve(memFactRows.slice(0, n));
								},
							};
						},
					};
				},
			};
		},
		query: {
			memoryDomains: {
				findFirst: () => Promise.resolve(undefined),
			},
		},
		insert: (_t: unknown) => ({
			values: (_v: unknown) => Promise.resolve(),
		}),
	};
	return db as unknown as Parameters<typeof mineHomeOperatorDecisions>[0];
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("mineHomeOperatorDecisions", () => {
	describe("explicit approve decision → one gated fact", () => {
		it("writes one fact for approval.approved with tediId", async () => {
			const event = makeAuditEvent({
				action: "approval.approved",
				metadata: {
					tediId: "tedi-cto-1",
					actionType: "write_artifact",
					source: "kernelRuntime.respondApproval",
					homeRunId: "run-abc123",
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			expect(result.factsSkipped).toBe(0);
			expect(mockCreateFact).toHaveBeenCalledOnce();

			const call = mockCreateFact.mock.calls[0][1];
			expect(call.organizationId).toBe(ORG);
			expect(call.tediId).toBe("tedi-cto-1");
			expect(call.visibility).toBe("org");
			expect(call.factType).toBe("decision");
			expect(call.status).toBe("probation");
			expect(call.confidence).toBeLessThanOrEqual(0.7);
			expect(call.source).toMatch(/^home:reflection:org-test-1:/);
			expect(call.content).toContain("Operator approved");
		});
		it("writes one fact for approval.rejected, reading the note from `resolution`", async () => {
			// The respondApproval audit path records the operator note as
			// `resolution` (kernel-runtime.ts ~5310), NOT `reason`. The producer
			// must read `resolution` so the operator's note survives.
			const event = makeAuditEvent({
				action: "approval.rejected",
				metadata: {
					tediId: "tedi-cto-1",
					actionType: "write_code",
					resolution: "Code modifies prod DB directly",
					source: "kernelRuntime.respondApproval",
					homeRunId: "run-xyz",
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			expect(call.content).toContain("rejected");
			expect(call.content).toContain("Code modifies prod DB directly");
			expect(call.confidence).toBeLessThanOrEqual(0.7);
		});
	});

	describe("smoke / CLI / answerless turn → 0 writes", () => {
		it("skips an approval.approved event with no actionType metadata", async () => {
			const event = makeAuditEvent({
				action: "approval.approved",
				// actionType missing — this is the smoke/CLI signal gate
				metadata: { source: "kernelRuntime.respondApproval" },
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(0);
			expect(result.factsSkipped).toBe(1);
			expect(mockCreateFact).not.toHaveBeenCalled();
		});

		it("skips a service/automated actor (only human operator decisions count)", async () => {
			// Verified live: 5/6 mined cancels were actor_type=service (smoke cleanup).
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				actorType: "service",
				metadata: {
					reason: "kernel-steering-live-smoke cleanup",
					delegatedTediId: "tedi-x",
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(0);
			expect(result.factsSkipped).toBe(1);
			expect(mockCreateFact).not.toHaveBeenCalled();
		});

		it("writes 0 facts when audit log is empty", async () => {
			const db = stubDb([]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(0);
			expect(result.eventsScanned).toBe(0);
			expect(mockCreateFact).not.toHaveBeenCalled();
		});
	});

	describe("source-level dedup: existing fact for same event → skipped", () => {
		it("skips when a fact with the same source URI already exists in memory_facts", async () => {
			const event = makeAuditEvent({
				id: "evt-already-bridged",
				action: "kernel.run.canceled",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					reason: "pivot",
					conversationId: "conv-1",
					homeRunId: "run-abc123",
				},
			});
			// Simulate existing fact with same source as what we'd write
			const existingFact: MemoryFactRow = {
				id: "fact-prior-1",
				organizationId: ORG,
				source: `home:reflection:${ORG}:evt-already-bridged`,
				archivedAt: null,
			};
			const db = stubDb([event], [existingFact]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			// hasFact returns truthy → skipped, no createFact
			expect(result.factsWritten).toBe(0);
			expect(result.factsSkipped).toBe(1);
			expect(mockCreateFact).not.toHaveBeenCalled();
		});
	});

	describe("content-hash dedup: duplicate content boosts existing fact", () => {
		it("calls recordFactVerification instead of createFact when content hash matches", async () => {
			mockFindFactBySourceHash.mockResolvedValueOnce({
				id: "fact-existing-hash",
			} as Awaited<ReturnType<typeof findFactBySourceHash>>);

			const event = makeAuditEvent({
				action: "kernel.run.retried",
				metadata: {
					delegatedTediId: "tedi-cto-1",
					homeRunId: "run-retry-1",
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(0);
			expect(result.factsSkipped).toBe(1);
			expect(mockCreateFact).not.toHaveBeenCalled();
			expect(mockRecordFactVerification).toHaveBeenCalledWith(
				expect.anything(),
				"fact-existing-hash",
				1.01,
			);
		});
	});

	describe("budget cap", () => {
		it("stops writing after MAX_FACTS_PER_CYCLE (50) and sets budgetHit=true", async () => {
			// Create 60 distinct approval events — all should be writable
			const events = Array.from({ length: 60 }, (_, i) =>
				makeAuditEvent({
					id: `evt-${i}`,
					action: "approval.approved",
					metadata: {
						tediId: `tedi-${i}`,
						actionType: `write_type_${i}`,
						source: "kernelRuntime.respondApproval",
					},
				}),
			);
			const db = stubDb(events);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(50);
			expect(result.budgetHit).toBe(true);
			expect(mockCreateFact).toHaveBeenCalledTimes(50);
		});
	});

	describe("cancel and retry decision signals", () => {
		it("writes a fact for kernel.run.canceled with delegatedTediId", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					childRunId: "run-child-abc",
					reason: "strategy changed",
					homeRunId: "run-parent-xyz",
					conversationId: "conv-1",
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			expect(call.tediId).toBe("tedi-cfo-1");
			expect(call.content).toContain("canceled");
			expect(call.content).toContain("strategy changed");
			expect((call.metadata as Record<string, unknown>).homeChildRunId).toBe(
				"run-child-abc",
			);
		});

		it("writes a fact for kernel.run.retried", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.retried",
				metadata: {
					delegatedTediId: "tedi-ceo-1",
					homeRunId: "run-failed-1",
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			expect(call.content).toContain("retried");
		});

		it("uses resourceId as the run reference when metadata has no homeRunId", async () => {
			// The real cancel/retry audit rows (kernel-runtime.ts ~6363/6193) put
			// the run id in resourceId, NOT metadata.homeRunId.
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				resourceId: "home-run-12345678abcdef",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					reason: "pivot",
					// no homeRunId in metadata
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			// run suffix derives from resourceId's first 8 chars
			expect(call.content).toContain("[run home-run");
		});
	});

	describe("tediId scoping", () => {
		it("sets tediId on facts where a specific tedi was named", async () => {
			const event = makeAuditEvent({
				action: "approval.approved",
				metadata: { tediId: "tedi-cto-1", actionType: "delegate_task" },
			});
			const db = stubDb([event]);

			await mineHomeOperatorDecisions(db, { orgId: ORG });

			const call = mockCreateFact.mock.calls[0][1];
			expect(call.tediId).toBe("tedi-cto-1");
		});

		it("sets tediId=null for org-scoped facts (no tedi named)", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				metadata: {
					// no delegatedTediId
					reason: "no tedi needed",
					homeRunId: "run-1",
				},
			});
			const db = stubDb([event]);

			await mineHomeOperatorDecisions(db, { orgId: ORG });

			const call = mockCreateFact.mock.calls[0][1];
			expect(call.tediId).toBeNull();
		});
	});

	describe("kernel route rationale folded into delegation facts", () => {
		it("a canceled delegation run with kernelRoute.rationale → fact carries BOTH the tediId AND a 'because:' clause", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					reason: "strategy changed",
					homeRunId: "run-parent-xyz",
					kernelRoute: {
						routeKind: "delegate_tedi",
						rationale:
							"cfo owns finance reconciliation and the request is a quarterly close review",
						confidence: 0.82,
						effortClass: "multi_hop_read",
					},
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			// Carries the delegated tediId
			expect(call.content).toContain("tedi-cfo-1");
			// AND the kernel's WHY (decision plus rationale)
			expect(call.content).toContain("because:");
			expect(call.content).toContain("Kernel delegated to tedi tedi-cfo-1");
			expect(call.content).toContain("cfo owns finance reconciliation");
			// Still probationary, operator-reversible memory
			expect(call.confidence).toBeLessThanOrEqual(0.7);
		});

		it("a retried delegation run with kernelRoute.rationale → fact carries the 'because:' clause", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.retried",
				metadata: {
					delegatedTediId: "tedi-ceo-1",
					homeRunId: "run-failed-1",
					kernelRoute: {
						routeKind: "delegate_tedi",
						rationale: "ceo is the only roster member with the board context",
						confidence: 0.7,
						effortClass: null,
					},
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			expect(call.content).toContain("Kernel delegated to tedi tedi-ceo-1");
			expect(call.content).toContain(
				"ceo is the only roster member with the board context",
			);
		});

		it("FAIL-SOFT: no kernelRoute → EXACTLY the pre-existing bare fact text (regression guard)", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					reason: "strategy changed",
					homeRunId: "run-parent-xyz",
					// no kernelRoute
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			// Exact pre-existing text shape — no enrichment, no "because:" clause.
			expect(call.content).toBe(
				"Operator canceled a Home run delegated to tedi tedi-cfo-1 (reason: strategy changed) [run run-pare]",
			);
			expect(call.content).not.toContain("because:");
		});

		it("FAIL-SOFT: non-string kernelRoute.rationale → bare fact text, no clause", async () => {
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					reason: "pivot",
					homeRunId: "run-abc12345",
					kernelRoute: {
						routeKind: "delegate_tedi",
						rationale: { not: "a string" },
						confidence: 0.5,
						effortClass: null,
					},
				},
			});
			const db = stubDb([event]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			expect(call.content).not.toContain("because:");
			expect(call.content).toContain("Operator canceled a Home run");
		});

		it("clamps the rationale to the bound and strips newlines", async () => {
			// 400-char rationale with embedded newlines/tabs — must be flattened to a
			// single line and hard-clamped to <=200 chars in the folded clause.
			const longRationale = `${"finance-context ".repeat(40)}\n\twith\nnewlines`;
			const event = makeAuditEvent({
				action: "kernel.run.canceled",
				metadata: {
					delegatedTediId: "tedi-cfo-1",
					homeRunId: "run-clamp-1",
					kernelRoute: {
						routeKind: "delegate_tedi",
						rationale: longRationale,
						confidence: 0.6,
						effortClass: null,
					},
				},
			});
			const db = stubDb([event]);

			await mineHomeOperatorDecisions(db, { orgId: ORG });

			const call = mockCreateFact.mock.calls[0][1];
			const content = call.content as string;
			// No raw newlines or tabs survive into the stored fact.
			expect(content).not.toMatch(/[\n\t]/);
			// The folded rationale portion (after "because: ") is bounded to <=200.
			const marker = "because: ";
			const idx = content.indexOf(marker);
			expect(idx).toBeGreaterThan(-1);
			const rationalePortion = content.slice(idx + marker.length);
			expect(rationalePortion.length).toBeLessThanOrEqual(200);
		});
	});

	describe("plan-decision mining from kernel_runtime_events", () => {
		it("home.plan.approved event → one fact", async () => {
			const planEvent = makePlanEvent({
				payload: {
					action: "home.plan.approved",
					assignments: [
						{ ownerTediId: "tedi-cto-1", status: "approved" },
						{ ownerTediId: "tedi-cfo-1", status: "approved" },
					],
					homePlan: {
						assignments: [
							{ ownerTediId: "tedi-cto-1", objective: "Audit the codebase" },
							{ ownerTediId: "tedi-cfo-1", objective: "Review financials" },
						],
					},
					status: "approved",
				},
			});
			const db = stubDb([], [], [planEvent]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			expect(mockCreateFact).toHaveBeenCalledOnce();

			const call = mockCreateFact.mock.calls[0][1];
			expect(call.factType).toBe("decision");
			expect(call.status).toBe("probation");
			expect(call.confidence).toBeLessThanOrEqual(0.7);
			expect(call.visibility).toBe("org");
			expect(call.source).toMatch(/^home:reflection:org-test-1:/);
			expect(call.content).toContain(
				"Operator approved a plan delegating to 2 tedis",
			);
			expect(call.content).toContain("tedi-cto-1");
			expect(call.content).toContain("tedi-cfo-1");
		});

		it("single-owner plan → tediId-scoped fact", async () => {
			const planEvent = makePlanEvent({
				payload: {
					action: "home.plan.approved",
					assignments: [{ ownerTediId: "tedi-cto-1", status: "approved" }],
					homePlan: {
						assignments: [
							{ ownerTediId: "tedi-cto-1", objective: "Write the new feature" },
						],
					},
					status: "approved",
				},
			});
			const db = stubDb([], [], [planEvent]);

			await mineHomeOperatorDecisions(db, { orgId: ORG });

			const call = mockCreateFact.mock.calls[0][1];
			expect(call.tediId).toBe("tedi-cto-1");
			expect(call.content).toContain("1 tedi");
		});

		it("multi-owner plan → org-scoped (tediId null)", async () => {
			const planEvent = makePlanEvent({
				payload: {
					action: "home.plan.approved",
					assignments: [
						{ ownerTediId: "tedi-cto-1", status: "approved" },
						{ ownerTediId: "tedi-cfo-1", status: "approved" },
					],
					homePlan: { assignments: [] },
					status: "approved",
				},
			});
			const db = stubDb([], [], [planEvent]);

			await mineHomeOperatorDecisions(db, { orgId: ORG });

			const call = mockCreateFact.mock.calls[0][1];
			expect(call.tediId).toBeNull();
		});

		it("home.plan.rejected → a fact emitted", async () => {
			const planEvent = makePlanEvent({
				payload: {
					action: "home.plan.rejected",
					assignments: [{ ownerTediId: "tedi-cto-1", status: "canceled" }],
					homePlan: {
						assignments: [
							{ ownerTediId: "tedi-cto-1", objective: "Deploy to prod" },
						],
					},
					status: "canceled",
				},
			});
			const db = stubDb([], [], [planEvent]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(1);
			const call = mockCreateFact.mock.calls[0][1];
			expect(call.content).toContain("Operator rejected a proposed plan");
			expect(call.content).toContain("tedi-cto-1");
		});

		it("dedup: same event id → only 1 fact (second call returns false via source dedup)", async () => {
			const eventId = "plan-evt-dedup-test";
			const planEvent = makePlanEvent({
				id: eventId,
				payload: {
					action: "home.plan.approved",
					assignments: [{ ownerTediId: "tedi-cto-1", status: "approved" }],
					homePlan: { assignments: [] },
					status: "approved",
				},
			});
			// Simulate that this source already exists in memory_facts
			const existingFact: MemoryFactRow = {
				id: "fact-dedup-1",
				organizationId: ORG,
				source: `home:reflection:${ORG}:${eventId}`,
				archivedAt: null,
			};
			const db = stubDb([], [existingFact], [planEvent]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(0);
			expect(result.factsSkipped).toBe(1);
			expect(mockCreateFact).not.toHaveBeenCalled();
		});

		it("shared budget: plan events count against the same 50-fact cap", async () => {
			// 50 audit events fill the budget; the plan event should trigger budgetHit
			const auditEvts = Array.from({ length: 50 }, (_, i) =>
				makeAuditEvent({
					id: `evt-${i}`,
					action: "approval.approved",
					metadata: { tediId: `tedi-${i}`, actionType: `write_type_${i}` },
				}),
			);
			const planEvent = makePlanEvent({
				payload: {
					action: "home.plan.approved",
					assignments: [{ ownerTediId: "tedi-new-1", status: "approved" }],
					homePlan: { assignments: [] },
					status: "approved",
				},
			});
			const db = stubDb(auditEvts, [], [planEvent]);

			const result = await mineHomeOperatorDecisions(db, { orgId: ORG });

			expect(result.factsWritten).toBe(50);
			expect(result.budgetHit).toBe(true);
			// createFact called exactly 50 times — the plan event was budget-blocked
			expect(mockCreateFact).toHaveBeenCalledTimes(50);
		});
	});
});
