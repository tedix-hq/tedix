import { DatabaseSync } from "node:sqlite";
import type { KernelGovernancePolicy } from "@tedix/api-contract/utils/approval-policy";
import { createRouterClient, ORPCError } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { tediApprovalDependencyEvents } from "@tedix/db/schema/approval-simulations";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import {
	kernelConversations,
	kernelConversationGrants,
	kernelRuntimeRuns,
	kernelRuntimeEvents,
} from "@tedix/db/schema/cognitive-runtime";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { eq, sql } from "drizzle-orm";
import { evaluateKernelRunMetadataPatch } from "../__tests__/api-sqlite";
import * as runQueries from "@tedix/db/queries/kernel-runtime-runs";
import { workstationDispatchIdentity } from "../kernel/workstation-dispatch";
import { predictAgentRunId } from "../kernel/runtime-shared";
import { workItems, workEvents } from "@tedix/db/schema/work-items";
import { runtimeSubmissions } from "@tedix/db/schema/runtime-submissions";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { apiKeyContext, userContext } from "../../test-context";
import {
	approveHomePlanAssignmentsCore,
	respondKernelDelegationRecommendationApprovalCore,
} from "./approval-control";
import { respondApprovalRoute } from "./delegation-control";
import { resolveApprovalByChatReply } from "./turn-delegation";

describe("kernel metadata fixture SQL evaluation", () => {
	async function metadataPatch(metadata: Record<string, unknown>) {
		let captured: Record<string, unknown> = {};
		const db = {
			update: () => ({
				set: (patch: Record<string, unknown>) => {
					captured = patch;
					return { where: async () => undefined };
				},
			}),
		};
		await runQueries.updateKernelRuntimeRun(db as never, "fictional-run", {
			metadata,
		});
		return captured;
	}

	it("evaluates ordinary metadata while retaining trusted claims from the current row", async () => {
		const current = {
			metadata: {
				homeDelegationResume: { claimId: "trusted-resume" },
				homeDelegationResolutionClaim: { claimId: "trusted-normal" },
			},
		};
		const patch = await metadataPatch({
			answer: "retained",
			homeDelegationResume: { claimId: "forged" },
		});
		expect(evaluateKernelRunMetadataPatch(patch, current).metadata).toEqual({
			answer: "retained",
			...current.metadata,
		});
	});

	it("removes incoming claims absent from the current row", async () => {
		const patch = await metadataPatch({
			answer: "retained",
			homeDelegationResume: { claimId: "forged" },
			homeDelegationResolutionClaim: { claimId: "forged" },
		});
		expect(evaluateKernelRunMetadataPatch(patch).metadata).toEqual({
			answer: "retained",
		});
	});

	it("propagates SQLite errors instead of treating unevaluated SQL as metadata", () => {
		expect(() =>
			evaluateKernelRunMetadataPatch({
				metadata: sql`unknown_metadata_function()`,
			}),
		).toThrow();
	});
});

const effects = vi.hoisted(() => ({
	event: vi.fn(async () => ({})),
	promote: vi.fn(async () => "delegation-work"),
	foreignAttempt: vi.fn<
		() => Promise<{ id: string; startedAt: string } | null>
	>(async () => null),
	dispatch: vi.fn(async () => ({ childRunId: "child", status: "queued" })),
	workstation: vi.fn(),
	learning: vi.fn(),
	settle: vi.fn(),
	stop: vi.fn(async () => ({ attempted: true, outcome: "succeeded" as const })),
	policy: vi.fn<() => Promise<KernelGovernancePolicy | null>>(async () => null),
	fetch: vi.fn(() => {
		throw new Error("Unexpected external call");
	}),
}));
vi.mock("../kernel/run-store", async (original) => ({
	...(await original<typeof import("../kernel/run-store")>()),
	insertKernelRuntimeEvent: effects.event,
}));
vi.mock("../kernel/delegation-work-item", async (original) => ({
	...(await original<typeof import("../kernel/delegation-work-item")>()),
	createDelegationWorkItem: effects.promote,
	findForeignActiveAttempt: effects.foreignAttempt,
}));
vi.mock("./policy-normalization", async (original) => ({
	...(await original<typeof import("./policy-normalization")>()),
	kernelDelegateRunner: effects.dispatch,
	kernelChildStopper: effects.stop,
	readOrgGovernancePolicy: effects.policy,
}));
vi.mock("./run-reads-streams", async (original) => ({
	...(await original<typeof import("./run-reads-streams")>()),
	resolveKernelDelegateTarget: vi.fn(async () => ({
		id: "tedi-research",
		slug: "research",
	})),
	readKernelUserMessageContent: vi.fn(
		async () => "Review the fictional roadmap",
	),
}));
vi.mock("./workstation-dispatch", () => ({
	runWorkstationWorkOrderDispatch: effects.workstation,
}));
vi.mock(
	"../../../services/learning-interaction-recorder",
	async (original) => ({
		...(await original<
			typeof import("../../../services/learning-interaction-recorder")
		>()),
		recordObservedLearningInteraction: effects.learning,
	}),
);

vi.mock("../kernel/write-approval-settlement", async (original) => ({
	...(await original<typeof import("../kernel/write-approval-settlement")>()),
	settleHomeToolWriteApproval: effects.settle,
}));

const ORG = "00000000-0000-4000-8000-000000000071";
const OTHER_ORG = "00000000-0000-4000-8000-000000000072";
const AT = "2026-01-01T00:00:00.000Z";
const requirement = {
	surface: "native",
	requiredCapabilities: [],
	fallbackSurface: null,
	prohibitedSurfaces: [],
	satisfiable: true,
	reason: "Review in isolation",
};
const databases: DatabaseSync[] = [];

async function fixture(
	permissions = ["tedis:update", "os:approve"],
	role: "admin" | "member" = "admin",
) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(canonicalWorkFactoryDdl());
	sqlite.exec(
		schemaDdl(
			kernelRuntimeRuns,
			kernelRuntimeEvents,
			runtimeSubmissions,
			kernelConversations,
			kernelConversationGrants,
			organizationMembers,
			workEvents,
			tediApprovalRequests,
			tediApprovalDependencyEvents,
			auditEvents,
		),
	);
	const writes: string[] = [];
	const DB = createD1Facade(sqlite, {
		onPrepare: (sql) => {
			if (/^\s*(insert|update|delete|replace)\b/i.test(sql)) writes.push(sql);
		},
	});
	const context = userContext({
		organizationId: ORG,
		sub: "operator",
		permissions,
		env: { ENVIRONMENT: "test", DB } as CloudflareEnv,
	});
	await context.db.insert(kernelRuntimeRuns).values({
		id: "held-run",
		organizationId: ORG,
		conversationId: "home:test",
		status: "requires_approval",
		createdAt: AT,
		updatedAt: AT,
		metadata: {
			homeDelegation: {
				decision: { mode: "needs_approval" },
				workOrder: {
					targetTediId: "tedi-research",
					sourceContent: "Review the fictional roadmap",
					executionRequirement: requirement,
				},
			},
		},
	});
	await context.db.insert(organizationMembers).values({
		id: "member",
		organizationId: ORG,
		descopeUserId: "operator",
		email: "operator@example.test",
		role,
		status: "active",
	});
	writes.length = 0;
	const run = (await getKernelRuntimeRun(context.db, {
		id: "held-run",
		organizationId: ORG,
	}))!;
	const client = createRouterClient(
		{ respond: respondApprovalRoute },
		{ context },
	);
	return { sqlite, context, writes, run, client };
}
function noEffects(writes: string[]) {
	expect(writes).toEqual([]);
	expect(effects.fetch).not.toHaveBeenCalled();
	for (const effect of [
		effects.event,
		effects.promote,
		effects.dispatch,
		effects.workstation,
		effects.learning,
		effects.settle,
	])
		expect(effect).not.toHaveBeenCalled();
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", effects.fetch);
});
afterEach(() => {
	vi.unstubAllGlobals();
	for (const sqlite of databases.splice(0)) sqlite.close();
});

describe("delegation approval core", () => {
	it("retains the recorded operator decision when downstream Work admission fails", async () => {
		const f = await fixture();
		effects.event.mockImplementationOnce(async (...args: unknown[]) => {
			const input = args[1] as typeof kernelRuntimeEvents.$inferInsert;
			await f.context.db.insert(kernelRuntimeEvents).values(input);
			return input;
		});
		effects.promote.mockRejectedValueOnce(
			new ORPCError("CONFLICT", {
				message: "current Work risk approval is missing",
			}),
		);
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run: f.run,
				decision: "approve",
			}),
		).rejects.toThrow("risk approval is missing");
		expect(effects.event).toHaveBeenCalledExactlyOnceWith(
			f.context,
			expect.objectContaining({
				kind: "approval.resolved",
				payload: expect.objectContaining({
					status: "approved",
					resolvedBy: null,
				}),
			}),
		);
		expect(effects.dispatch).not.toHaveBeenCalled();
		expect(effects.workstation).not.toHaveBeenCalled();
		const saved = await getKernelRuntimeRun(f.context.db, {
			id: f.run.id,
			organizationId: ORG,
		});
		expect(saved?.status).toBe("requires_approval");
		expect(
			(saved?.metadata?.homeDelegation as Record<string, unknown>)
				.resolutionStatus,
		).toBeUndefined();
		expect(saved?.metadata?.homeDelegationResolutionClaim).toMatchObject({
			phase: "admission_failed",
		});
	});
	it.each(["approve", "reject"] as const)(
		"refuses a new %s decision when a recorded continuation owns the run",
		async (decision) => {
			const f = await fixture();
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run: {
						...f.run,
						metadata: {
							...f.run.metadata,
							homeDelegationResume: {
								claimId: "fictional-claim",
								phase: "dispatching",
							},
						},
					},
					decision,
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			noEffects(f.writes);
		},
	);
	it.each(["approve", "reject"] as const)(
		"records an authorized %s without confusing rejection with a refused request",
		async (decision) => {
			const f = await fixture();
			const result = await respondKernelDelegationRecommendationApprovalCore(
				f.context,
				{ organizationId: ORG, run: f.run, decision, note: "Reviewed" },
			);
			expect(result.run.status).toBe(
				decision === "approve" ? "queued" : "canceled",
			);
			expect(effects.event).toHaveBeenCalledWith(
				f.context,
				expect.objectContaining({
					kind: "approval.resolved",
					payload: expect.objectContaining({
						status: decision === "approve" ? "approved" : "rejected",
						resolution: "Reviewed",
					}),
				}),
			);
			expect(result.run.metadata?.homeDelegation).toMatchObject({
				resolutionStatus: decision === "approve" ? "approved" : "rejected",
			});
			if (decision === "approve") {
				expect(effects.promote).toHaveBeenCalledTimes(1);
				expect(effects.dispatch).toHaveBeenCalledTimes(1);
				expect(effects.dispatch).toHaveBeenCalledWith(
					expect.objectContaining({
						delegateToTediId: "tedi-research",
						childRunId: "held-run:approved:tedi-research",
					}),
				);
			} else {
				expect(effects.promote).not.toHaveBeenCalled();
				expect(effects.dispatch).not.toHaveBeenCalled();
			}
			expect(effects.workstation).not.toHaveBeenCalled();
		},
	);
	it.each(["completed", "failed", "canceled"] as const)(
		"refuses terminal %s before all effects",
		async (status) => {
			const f = await fixture();
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run: { ...f.run, status },
					decision: "approve",
				}),
			).rejects.toMatchObject({ code: "CONFLICT" });
			noEffects(f.writes);
		},
	);
	it.each(["approved", "rejected"])(
		"refuses an already %s delegation without writes",
		async (resolutionStatus) => {
			const f = await fixture();
			const metadata = structuredClone(f.run.metadata)!;
			(metadata.homeDelegation as Record<string, unknown>).resolutionStatus =
				resolutionStatus;
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run: { ...f.run, metadata },
					decision: "approve",
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("already"),
			});
			noEffects(f.writes);
		},
	);
	it("records an approval for Work another executor already holds without a second writer", async () => {
		const f = await fixture();
		effects.foreignAttempt.mockResolvedValueOnce({
			id: "lane-attempt",
			startedAt: "2026-11-03T16:53:00.000Z",
		});
		const result = await respondKernelDelegationRecommendationApprovalCore(
			f.context,
			{
				organizationId: ORG,
				run: f.run,
				decision: "approve",
				approvedWorkItemId: "work-held",
			},
		);
		expect(effects.foreignAttempt).toHaveBeenCalledWith(
			f.context,
			expect.objectContaining({ workItemId: "work-held" }),
		);
		expect(result.run.status).toBe("canceled");
		expect(result.run.metadata?.homeDelegation).toMatchObject({
			resolutionStatus: "approved",
			inProgressAttemptId: "lane-attempt",
		});
		expect(effects.event).toHaveBeenCalledWith(
			f.context,
			expect.objectContaining({
				runtimeMetadata: expect.objectContaining({
					dispatch: "home-delegation-already-in-progress",
				}),
			}),
		);
		expect(effects.promote).not.toHaveBeenCalled();
		expect(effects.dispatch).not.toHaveBeenCalled();
	});
	it("reconciles a typed admission race and refuses one repeated parent resolution without dispatching", async () => {
		const f = await fixture();
		effects.foreignAttempt
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "racing-attempt", startedAt: AT });
		effects.promote.mockRejectedValueOnce(
			new ORPCError("CONFLICT", { data: { rejectionCode: "already_running" } }),
		);
		const input = {
			organizationId: ORG,
			run: f.run,
			decision: "approve" as const,
			approvedWorkItemId: "work-held",
		};
		const result = await respondKernelDelegationRecommendationApprovalCore(
			f.context,
			input,
		);
		expect(result.run.status).toBe("canceled");
		expect(result.run.metadata?.homeDelegation).toMatchObject({
			resolutionStatus: "approved",
			inProgressAttemptId: "racing-attempt",
		});
		expect(effects.foreignAttempt).toHaveBeenCalledTimes(2);
		expect(effects.foreignAttempt).toHaveBeenLastCalledWith(
			f.context,
			expect.objectContaining({
				workItemId: "work-held",
				organizationId: ORG,
				homeRunId: f.run.id,
			}),
		);
		const resolved = await getKernelRuntimeRun(f.context.db, {
			id: f.run.id,
			organizationId: ORG,
		});
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				...input,
				run: resolved!,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(effects.promote).toHaveBeenCalledTimes(1);
		expect(effects.event).toHaveBeenCalledTimes(1);
		expect(effects.dispatch).not.toHaveBeenCalled();
		expect(effects.workstation).not.toHaveBeenCalled();
	});
	it.each(["untyped", "different-rejection", "no-current-holder"])(
		"does not suppress an admission failure with %s",
		async (kind) => {
			const f = await fixture();
			const error =
				kind === "untyped"
					? new Error("already_running")
					: new ORPCError("CONFLICT", {
							data: {
								rejectionCode:
									kind === "different-rejection"
										? "approval_required"
										: "already_running",
							},
						});
			effects.promote.mockRejectedValueOnce(error);
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run: f.run,
					decision: "approve",
					approvedWorkItemId: "work-held",
				}),
			).rejects.toBe(error);
			expect(effects.foreignAttempt).toHaveBeenCalledTimes(
				kind === "no-current-holder" ? 2 : 1,
			);
			expect(
				(
					await getKernelRuntimeRun(f.context.db, {
						id: f.run.id,
						organizationId: ORG,
					})
				)?.status,
			).toBe("requires_approval");
			expect(effects.dispatch).not.toHaveBeenCalled();
		},
	);
	it("does not overwrite a competing Home transition while reconciling an admission race", async () => {
		const f = await fixture();
		effects.foreignAttempt
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: "racing-attempt", startedAt: AT });
		effects.promote.mockImplementationOnce(async () => {
			f.sqlite
				.prepare(
					"UPDATE kernel_runtime_runs SET status = 'canceled', progress_label = 'Canceled by operator', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
				)
				.run(f.run.id);
			throw new ORPCError("CONFLICT", {
				data: { rejectionCode: "already_running" },
			});
		});
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run: f.run,
				decision: "approve",
				approvedWorkItemId: "work-held",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Home run changed"),
		});
		expect(
			await getKernelRuntimeRun(f.context.db, {
				id: f.run.id,
				organizationId: ORG,
			}),
		).toMatchObject({
			status: "canceled",
			progressLabel: "Canceled by operator",
		});
		expect(effects.dispatch).not.toHaveBeenCalled();
	});
	it("refuses a run without a pending delegation", async () => {
		const f = await fixture();
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run: { ...f.run, metadata: {} },
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		noEffects(f.writes);
	});
	it("loses a stale compare-and-set without promoting or dispatching twice", async () => {
		const f = await fixture();
		await respondKernelDelegationRecommendationApprovalCore(f.context, {
			organizationId: ORG,
			run: f.run,
			decision: "reject",
		});
		const changes = f.sqlite.prepare("SELECT total_changes() AS n").get();
		vi.clearAllMocks();
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run: f.run,
				decision: "approve",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("changed while"),
		});
		expect(f.sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(
			changes,
		);
		for (const effect of [
			effects.event,
			effects.promote,
			effects.dispatch,
			effects.workstation,
		])
			expect(effect).not.toHaveBeenCalled();
	});
	it("does not let policy release an explicitly operator-held task", async () => {
		const f = await fixture();
		const metadata = structuredClone(f.run.metadata)!;
		const delegation = metadata.homeDelegation as Record<string, unknown>;
		delegation.decision = {
			mode: "needs_approval",
			reason: "operator explicitly held dispatch for approval",
		};
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run: { ...f.run, metadata },
				decision: "approve",
				resolvedBy: { type: "policy", id: "policy" },
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("Autonomy policy refused"),
		});
		noEffects(f.writes);
	});
});

describe("interrupted delegation resolution", () => {
	const CUT_OFF_AT = "2026-01-01T00:05:00.000Z";
	const recordedEventId = [
		"home",
		ORG,
		"event",
		"delegation.approval.resolved",
		"home:test",
		"held-run",
		CUT_OFF_AT,
	].join(":");
	/** The row a resolver leaves when it is cut off after taking its claim. */
	async function interrupted(
		f: Awaited<ReturnType<typeof fixture>>,
		options: { claimedAt?: string; recorded?: "approved" | "rejected" } = {},
	) {
		const claimedAt = options.claimedAt ?? CUT_OFF_AT;
		const metadata = {
			...f.run.metadata,
			homeDelegationResolutionClaim: {
				version: 1,
				phase: "resolving",
				claimId: "cut-off-claim",
				claimedAt,
				approvalEventId: recordedEventId,
				approvalResolvedAt: claimedAt,
				organizationId: ORG,
				runId: "held-run",
				conversationId: "home:test",
				workItemId: null,
				scopeDigest: null,
			},
		};
		await f.context.db
			.update(kernelRuntimeRuns)
			.set({ metadata, updatedAt: claimedAt })
			.where(eq(kernelRuntimeRuns.id, "held-run"));
		if (options.recorded) {
			const workOrder = (
				f.run.metadata?.homeDelegation as Record<string, unknown>
			).workOrder as Record<string, unknown>;
			await f.context.db.insert(kernelRuntimeEvents).values({
				id: recordedEventId,
				organizationId: ORG,
				conversationId: "home:test",
				runId: "held-run",
				kind: "approval.resolved",
				delegatedTediId: "tedi-research",
				createdAt: claimedAt,
				payload: {
					status: options.recorded,
					delegationWorkOrder: { ...workOrder, status: options.recorded },
					resolvedBy: { type: "user", id: "operator" },
					resolution: "Reviewed before the outage",
				},
				runtimeMetadata: { source: "kernelRuntime.respondApproval" },
			});
		}
		f.writes.length = 0;
		return (await getKernelRuntimeRun(f.context.db, {
			id: "held-run",
			organizationId: ORG,
		}))!;
	}
	async function saved(f: Awaited<ReturnType<typeof fixture>>) {
		return (await getKernelRuntimeRun(f.context.db, {
			id: "held-run",
			organizationId: ORG,
		}))!;
	}

	it.each(["approve", "reject"] as const)(
		"refuses a %s while a live resolver still holds a fresh claim",
		async (decision) => {
			const f = await fixture();
			const run = await interrupted(f, {
				claimedAt: new Date().toISOString(),
			});
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run,
					decision,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: "Another approval resolution is still in progress",
			});
			noEffects(f.writes);
		},
	);

	it("lets the next decision take over a stale claim that recorded nothing", async () => {
		const f = await fixture();
		const run = await interrupted(f);
		const result = await respondKernelDelegationRecommendationApprovalCore(
			f.context,
			{ organizationId: ORG, run, decision: "reject", note: "Not now" },
		);
		expect(result.run.status).toBe("canceled");
		expect(effects.event).toHaveBeenCalledExactlyOnceWith(
			f.context,
			expect.objectContaining({
				kind: "approval.resolved",
				payload: expect.objectContaining({ status: "rejected" }),
			}),
		);
		const claim = (await saved(f)).metadata
			?.homeDelegationResolutionClaim as Record<string, unknown>;
		expect(claim).toMatchObject({
			phase: "resolving",
			takeoverOf: "cut-off-claim",
		});
		expect(claim.claimId).not.toBe("cut-off-claim");
	});

	it("lets only one of two concurrent takers win a stale claim", async () => {
		const f = await fixture();
		const run = await interrupted(f);
		await respondKernelDelegationRecommendationApprovalCore(f.context, {
			organizationId: ORG,
			run,
			decision: "approve",
		});
		vi.clearAllMocks();
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run,
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		for (const effect of [effects.event, effects.promote, effects.dispatch])
			expect(effect).not.toHaveBeenCalled();
	});

	it("finishes a recorded approval with its one receipt instead of deciding again", async () => {
		const f = await fixture();
		const run = await interrupted(f, { recorded: "approved" });
		const result = await respondKernelDelegationRecommendationApprovalCore(
			f.context,
			{ organizationId: ORG, run, decision: "approve" },
		);
		expect(result.run.status).toBe("queued");
		expect(effects.event).not.toHaveBeenCalled();
		expect(effects.promote).toHaveBeenCalledTimes(1);
		expect(effects.dispatch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				childRunId: "held-run:approved:tedi-research",
			}),
		);
		expect(result.run.metadata?.homeDelegation).toMatchObject({
			resolutionStatus: "approved",
			resolvedAt: CUT_OFF_AT,
			resolution: "Reviewed before the outage",
			resolvedBy: { type: "user", id: "operator" },
		});
		const events = await f.context.db
			.select()
			.from(kernelRuntimeEvents)
			.where(eq(kernelRuntimeEvents.kind, "approval.resolved"));
		expect(events.map((event) => event.id)).toEqual([recordedEventId]);
		// The finished run is resolved; a repeat cannot resolve it twice.
		vi.clearAllMocks();
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run: await saved(f),
				decision: "approve",
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(effects.dispatch).not.toHaveBeenCalled();
	});

	it.each([
		["approved", "reject", "Approve again to finish it"],
		["rejected", "approve", "Reject again to finish it"],
	] as const)(
		"refuses the opposite decision over a recorded %s",
		async (recorded, decision, hint) => {
			const f = await fixture();
			const run = await interrupted(f, { recorded });
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run,
					decision,
				}),
			).rejects.toMatchObject({
				code: "CONFLICT",
				message: expect.stringContaining(hint),
			});
			noEffects(f.writes);
		},
	);

	it("finishes a recorded rejection without dispatching", async () => {
		const f = await fixture();
		const run = await interrupted(f, { recorded: "rejected" });
		const result = await respondKernelDelegationRecommendationApprovalCore(
			f.context,
			{ organizationId: ORG, run, decision: "reject" },
		);
		expect(result.run.status).toBe("canceled");
		expect(effects.event).not.toHaveBeenCalled();
		expect(effects.dispatch).not.toHaveBeenCalled();
	});

	it("does not take over when a receipt appears after the claim was read", async () => {
		const f = await fixture();
		const run = await interrupted(f);
		// The cut-off resolver's receipt lands between the read and the takeover.
		effects.event.mockImplementation(async () => ({}));
		const lookup = vi
			.spyOn(
				await import("@tedix/db/queries/kernel-runtime-events"),
				"getKernelRuntimeEventById",
			)
			.mockImplementationOnce(async () => {
				await f.context.db.insert(kernelRuntimeEvents).values({
					id: recordedEventId,
					organizationId: ORG,
					conversationId: "home:test",
					runId: "held-run",
					kind: "approval.resolved",
					createdAt: CUT_OFF_AT,
					payload: { status: "approved" },
				});
				return undefined;
			});
		await expect(
			respondKernelDelegationRecommendationApprovalCore(f.context, {
				organizationId: ORG,
				run,
				decision: "reject",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		lookup.mockRestore();
		expect(effects.event).not.toHaveBeenCalled();
		expect((await saved(f)).status).toBe("requires_approval");
	});
});

describe("operator route authorization before delegation resolution", () => {
	it("refuses a different requested organization", async () => {
		const f = await fixture();
		await expect(
			f.client.respond({
				runId: f.run.id,
				organizationId: OTHER_ORG,
				decision: "approve",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		noEffects(f.writes);
	});
	it("does not find a run owned by another organization", async () => {
		const f = await fixture();
		const context = { ...f.context, organizationId: OTHER_ORG };
		await expect(
			createRouterClient(
				{ respond: respondApprovalRoute },
				{ context },
			).respond({ runId: f.run.id, decision: "reject" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		noEffects(f.writes);
	});
	it.each(["member", "viewer"])(
		"refuses an active %s even with tedis:update",
		async (role) => {
			const f = await fixture();
			f.sqlite.prepare("UPDATE organization_members SET role = ?").run(role);
			await expect(
				f.client.respond({ runId: f.run.id, decision: "approve" }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("owner or admin"),
			});
			noEffects(f.writes);
		},
	);
	it("refuses an inactive owner", async () => {
		const f = await fixture();
		f.sqlite.exec(
			"UPDATE organization_members SET role = 'owner', status = 'deactivated'",
		);
		await expect(
			f.client.respond({ runId: f.run.id, decision: "reject" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("owner or admin"),
		});
		noEffects(f.writes);
	});
	it("lets an active admin reject at the real route", async () => {
		const f = await fixture();
		const result = await f.client.respond({
			runId: f.run.id,
			decision: "reject",
		});
		expect(result.run.status).toBe("canceled");
		expect(effects.learning).toHaveBeenCalledTimes(1);
		expect(effects.dispatch).not.toHaveBeenCalled();
	});
	it("keeps the invocation alive until an approval's dispatch settles", async () => {
		// A browser leaving the page cancels the request; without this the
		// invocation died between admitting the Attempt and delivering the
		// work order, leaving the card pending behind an orphaned Attempt.
		const f = await fixture();
		const kept: Promise<unknown>[] = [];
		f.context.waitUntil = (promise) => {
			kept.push(promise);
		};
		const result = await f.client.respond({
			runId: f.run.id,
			decision: "approve",
		});
		expect(result.run.status).toBe("queued");
		expect(kept).toHaveLength(1);
		await expect(kept[0]).resolves.toBeUndefined();
		expect(effects.dispatch).toHaveBeenCalledTimes(1);
	});
});

describe("Home plan Work promotion", () => {
	async function planFixture() {
		const f = await fixture();
		const plan = {
			id: "plan",
			summary: "Review a fictional roadmap",
			status: "proposed",
			createdAt: AT,
			dependencies: [],
			assignments: [
				{
					id: "assignment",
					ownerTediId: "tedi-research",
					ownerLabel: "Research",
					routeKind: "agent",
					objective: "Review roadmap",
					confidence: 1,
					required: true,
					status: "proposed",
					expectedEvidence: ["Summary"],
				},
			],
		};
		f.sqlite
			.prepare("UPDATE kernel_runtime_runs SET metadata = ?")
			.run(JSON.stringify({ homePlan: plan }));
		return f;
	}
	it("promotes once and reuses the accepted Work for an explicitly repeated selection", async () => {
		const f = await planFixture();
		const input = {
			organizationId: ORG,
			homeRunId: f.run.id,
			assignmentIds: ["assignment"],
			dispatch: false,
		};
		const first = await approveHomePlanAssignmentsCore(f.context, input);
		const second = await approveHomePlanAssignmentsCore(f.context, input);
		expect(first.assignments[0]).toMatchObject({
			status: "approved",
			childRunId: null,
		});
		expect(second.assignments[0]?.workItemId).toBe(
			first.assignments[0]?.workItemId,
		);
		expect(
			f.sqlite
				.prepare("SELECT id, disposition, source_intent_id FROM work_items")
				.all(),
		).toEqual([
			{
				id: first.assignments[0]?.workItemId,
				disposition: "accepted",
				source_intent_id: "assignment",
			},
		]);
		expect(effects.dispatch).not.toHaveBeenCalled();
	});
	it("rejects an unknown selection before any Work write", async () => {
		const f = await planFixture();
		await expect(
			approveHomePlanAssignmentsCore(f.context, {
				organizationId: ORG,
				homeRunId: f.run.id,
				assignmentIds: ["missing"],
				dispatch: false,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		noEffects(f.writes);
	});
	it("enforces the fan-out cap before promoting even one assignment", async () => {
		const f = await planFixture();
		effects.policy.mockResolvedValueOnce({ maxDelegationsPerTurn: 1 });
		await expect(
			approveHomePlanAssignmentsCore(f.context, {
				organizationId: ORG,
				homeRunId: f.run.id,
				dispatch: true,
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("fan-out cap"),
		});
		noEffects(f.writes);
	});
});

describe("write approval guards reached through respondApproval", () => {
	async function pendingWrite(f: Awaited<ReturnType<typeof fixture>>) {
		await f.context.db.insert(tediApprovalRequests).values({
			id: "write-approval",
			tediId: "tedi-research",
			orgId: ORG,
			actionType: "home.tool_write",
			description: "Fictional document update",
			status: "pending",
			createdAt: AT,
			expiresAt: "2099-01-01T00:00:00.000Z",
			payload: {
				kind: "home_tool_write",
				appSlug: "example",
				toolName: "update_document",
				organizationId: ORG,
				homeRunId: f.run.id,
				conversationId: f.run.conversationId,
				args: { title: "Example" },
			},
		});
		f.sqlite
			.prepare("UPDATE kernel_runtime_runs SET metadata = ?")
			.run(JSON.stringify({ approvalRequestId: "write-approval" }));
		f.writes.length = 0;
	}

	it.each(["approve", "reject"] as const)(
		"denies an operational member's direct %s before every effect",
		async (decision) => {
			const f = await fixture(["tedis:update"], "member");
			await pendingWrite(f);
			await expect(
				f.client.respond({ runId: f.run.id, decision }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			noEffects(f.writes);
			expect(
				f.sqlite.prepare("SELECT status FROM tedi_approval_requests").get(),
			).toEqual({ status: "pending" });
		},
	);

	it.each(["approve", "reject"] as const)(
		"denies an operational member's conversational %s before every effect",
		async (content) => {
			const f = await fixture(["tedis:update"], "member");
			await pendingWrite(f);
			const result = await resolveApprovalByChatReply(f.context, {
				organizationId: ORG,
				conversationId: f.run.conversationId,
				runId: "reply-run",
				content,
			});
			expect(result?.error).toContain("os:approve");
			noEffects(f.writes);
			expect(
				f.sqlite.prepare("SELECT status FROM tedi_approval_requests").get(),
			).toEqual({ status: "pending" });
		},
	);

	it("does not let a tedi approve its own Home write through a chat reply", async () => {
		const f = await fixture();
		await pendingWrite(f);
		const context = {
			...f.context,
			authType: "tedi" as const,
			user: undefined,
			tediId: "tedi-research",
			tediScopes: ["tedis:write", "mcp:memory.admin"],
		};
		const result = await resolveApprovalByChatReply(context, {
			organizationId: ORG,
			conversationId: f.run.conversationId,
			runId: "reply-run",
			content: "approve",
		});
		expect(result?.error).toContain("Work approval plane");
		noEffects(f.writes);
	});

	it("does not accept a machine's tedi-write scope as approval authority", async () => {
		const f = await fixture();
		await pendingWrite(f);
		const context = apiKeyContext({
			organizationId: ORG,
			scopes: ["tedis:write"],
			env: f.context.env,
		});
		const client = createRouterClient(
			{ respond: respondApprovalRoute },
			{ context },
		);
		await expect(
			client.respond({ runId: f.run.id, decision: "approve" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		noEffects(f.writes);
	});

	it.each(["os:approve", "settings:manage"])(
		"retains explicit approval authority for %s",
		async (permission) => {
			const f = await fixture([permission], "member");
			await pendingWrite(f);
			await f.client.respond({ runId: f.run.id, decision: "approve" });
			expect(
				f.sqlite.prepare("SELECT status FROM tedi_approval_requests").get(),
			).toEqual({ status: "approved" });
			expect(effects.settle).toHaveBeenCalledOnce();
		},
	);

	it.each([
		{
			status: "pending" as const,
			expiresAt: "2000-01-01T00:00:00.000Z",
			orgId: ORG,
			message: "expired",
			code: "BAD_REQUEST",
		},
		{
			status: "approved" as const,
			expiresAt: "2099-01-01T00:00:00.000Z",
			orgId: ORG,
			message: "already",
			code: "BAD_REQUEST",
		},
		{
			status: "rejected" as const,
			expiresAt: "2099-01-01T00:00:00.000Z",
			orgId: ORG,
			message: "already",
			code: "BAD_REQUEST",
		},
		{
			status: "pending" as const,
			expiresAt: "2099-01-01T00:00:00.000Z",
			orgId: OTHER_ORG,
			message: "Access denied",
			code: "FORBIDDEN",
		},
	])(
		"refuses $status / $message before the approval latch or settlement",
		async ({ status, expiresAt, orgId, message, code }) => {
			const f = await fixture();
			await f.context.db.insert(tediApprovalRequests).values({
				id: "write-approval",
				tediId: "tedi-research",
				orgId,
				actionType: "home.tool_write",
				description: "Fictional document update",
				status,
				createdAt: AT,
				expiresAt,
				payload: {
					kind: "home_tool_write",
					appSlug: "example",
					toolName: "update_document",
					organizationId: orgId,
					homeRunId: f.run.id,
					conversationId: f.run.conversationId,
					args: { title: "Example" },
				},
			});
			f.sqlite
				.prepare("UPDATE kernel_runtime_runs SET metadata = ?")
				.run(JSON.stringify({ approvalRequestId: "write-approval" }));
			f.writes.length = 0;
			await expect(
				f.client.respond({ runId: f.run.id, decision: "approve" }),
			).rejects.toMatchObject({
				code,
				message: expect.stringContaining(message),
			});
			noEffects(f.writes);
			expect(
				f.sqlite.prepare("SELECT status FROM tedi_approval_requests").get(),
			).toEqual({ status });
		},
	);
});

vi.mock("../kernel/tedi-capabilities", async (original) => ({
	...(await original<typeof import("../kernel/tedi-capabilities")>()),
	readOrgDispatchPolicyLayer: vi.fn(async () => ({
		autonomy: { version: 1, maxRisk: "medium" },
	})),
}));

describe("policy authority for critical actions", () => {
	it.each(["Email a customer", "Delete records", "Publish a blog"])(
		"retains the human hold for %s without side effects",
		async (sourceContent) => {
			const f = await fixture();
			const run = {
				...f.run,
				metadata: {
					...f.run.metadata,
					approvalRequestId: "approval",
					delegationWorkOrder: {
						kind: "workstation.attach",
						sourceContent,
						executionRequirement: requirement,
					},
				},
			};
			await expect(
				respondKernelDelegationRecommendationApprovalCore(f.context, {
					organizationId: ORG,
					run,
					decision: "approve",
					resolvedBy: { type: "policy", id: "policy" },
				}),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("Autonomy policy refused"),
			});
			noEffects(f.writes);
		},
	);
});

async function editableWriteFixture() {
	const f = await fixture();
	await f.context.db.insert(tediApprovalRequests).values({
		id: "editable-write",
		tediId: "tedi-research",
		orgId: ORG,
		actionType: "home.tool_write",
		description: "Fictional document update",
		status: "pending",
		createdAt: AT,
		expiresAt: "2099-01-01T00:00:00.000Z",
		payload: {
			kind: "home_tool_write",
			appSlug: "example",
			toolName: "update_document",
			organizationId: ORG,
			homeRunId: f.run.id,
			conversationId: f.run.conversationId,
			initiatedByUserId: "requester",
			args: { title: "Draft", accountId: "original" },
			editableFields: [
				{
					name: "title",
					label: "Title",
					required: true,
					schema: { type: "string", maxLength: 20 },
				},
			],
		},
	});
	f.sqlite
		.prepare("UPDATE kernel_runtime_runs SET metadata = ?")
		.run(JSON.stringify({ approvalRequestId: "editable-write" }));
	f.writes.length = 0;
	return f;
}

describe("Home approve with changes", () => {
	it("atomically stores edits and audit before settling, preserving requester identity", async () => {
		const f = await editableWriteFixture();
		await f.client.respond({
			runId: f.run.id,
			decision: "approve",
			edits: { title: "Final" },
		});
		const row = f.sqlite
			.prepare("SELECT payload, status FROM tedi_approval_requests")
			.get() as { payload: string; status: string };
		expect(row.status).toBe("approved");
		const stored = JSON.parse(row.payload);
		expect(stored).toMatchObject({
			args: { title: "Final", accountId: "original" },
			initiatedByUserId: "requester",
			approverEdits: {
				editedBy: "operator",
				changes: [{ field: "title", before: "Draft", after: "Final" }],
			},
		});
		expect(effects.settle).toHaveBeenCalledWith(
			f.context,
			expect.objectContaining({
				approval: expect.objectContaining({ payload: stored }),
			}),
		);
		const audit = f.sqlite
			.prepare(
				"SELECT metadata FROM audit_events WHERE resource_id = 'editable-write'",
			)
			.get() as { metadata: string };
		expect(JSON.parse(audit.metadata)).toMatchObject({
			source: "kernelRuntime.respondApproval",
			approverEdits: stored.approverEdits.changes,
		});
		await expect(
			f.client.respond({
				runId: f.run.id,
				decision: "approve",
				edits: { title: "Again" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(effects.settle).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ decision: "reject" as const, edits: { title: "Final" } },
		{
			decision: "approve" as const,
			delegateRecommendation: true,
			edits: { title: "Final" },
		},
		{ decision: "approve" as const, edits: { title: "x".repeat(21) } },
		{ decision: "approve" as const, edits: { accountId: "redirected" } },
	])("refuses invalid Home edits before resolution: %j", async (input) => {
		const f = await editableWriteFixture();
		await expect(
			f.client.respond({ runId: f.run.id, ...input }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		noEffects(f.writes);
	});

	it("refuses a machine's edits before the approval latch", async () => {
		const f = await editableWriteFixture();
		const client = createRouterClient(
			{ respond: respondApprovalRoute },
			{
				context: apiKeyContext({
					db: f.context.db,
					env: f.context.env,
					organizationId: ORG,
					scopes: ["mcp:tedis.write"],
				}),
			},
		);
		await expect(
			client.respond({
				runId: f.run.id,
				decision: "approve",
				edits: { title: "Final" },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		noEffects(f.writes);
	});

	it("does not silently ignore edits on a delegation", async () => {
		const f = await fixture();
		await expect(
			f.client.respond({
				runId: f.run.id,
				decision: "approve",
				edits: { title: "Final" },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		noEffects(f.writes);
	});
});

async function resumedNativeFixture(
	surface: "native" | "workstation" = "native",
) {
	const f = await fixture();
	const childRunId =
		surface === "workstation"
			? workstationDispatchIdentity({
					homeRunId: f.run.id,
					target: { id: "tedi-research" },
				}).runtimeRunId
			: predictAgentRunId({
					clientRequestId: `${f.run.id}:approved:tedi-research`,
					tediId: "tedi-research",
				});
	const eventId = [
		"home",
		ORG,
		"event",
		"delegation.approval.resolved",
		f.run.conversationId,
		f.run.id,
		AT,
	].join(":");
	const workOrder = {
		...((f.run.metadata!.homeDelegation as Record<string, unknown>)
			.workOrder as Record<string, unknown>),
		status: "approved",
		executionRequirement: { ...requirement, surface },
	};
	await f.context.db.insert(workItems).values({
		id: "delegation-work",
		orgId: ORG,
		title: "Fictional bounded review",
		disposition: "accepted",
		version: 2,
		admissionSpecRevision: "fictional-spec",
		createdAt: AT,
		updatedAt: AT,
	});
	await f.context.db.insert(kernelRuntimeEvents).values({
		id: eventId,
		organizationId: ORG,
		conversationId: f.run.conversationId,
		runId: f.run.id,
		kind: "approval.resolved",
		delegatedTediId: "tedi-research",
		createdAt: AT,
		payload: {
			status: "approved",
			delegationWorkOrder: workOrder,
			resolvedBy: null,
		},
		runtimeMetadata: {
			source: "kernelRuntime.respondApproval",
			dispatch: "home-delegation-approved",
		},
	});
	const marker = {
		version: 1,
		claimId: "fictional-claim",
		approvalEventId: eventId,
		approvalResolvedAt: AT,
		workItemId: "delegation-work",
		workItemVersion: 2,
		admissionSpecRevision: "fictional-spec",
		scopeDigest: "d".repeat(64),
		claimedAt: AT,
		phase: "claimed",
		targetTediId: "tedi-research",
		expectedChildRunId: childRunId,
	};
	await f.context.db
		.update(kernelRuntimeRuns)
		.set({ metadata: { ...f.run.metadata, homeDelegationResume: marker } })
		.where(eq(kernelRuntimeRuns.id, f.run.id));
	const run = (await getKernelRuntimeRun(f.context.db, {
		id: f.run.id,
		organizationId: ORG,
	}))!;
	const pending: Promise<unknown>[] = [];
	f.context.waitUntil = (promise) => {
		pending.push(promise);
	};
	const invoke = () =>
		respondKernelDelegationRecommendationApprovalCore(f.context, {
			organizationId: ORG,
			run,
			decision: "approve",
			approvedWorkItemId: "delegation-work",
			recordedApproval: {
				claimId: marker.claimId,
				eventId,
				resolvedAt: AT,
				workOrder,
				resolvedBy: null,
				resolution: null,
			},
		});
	const childSubmission = () =>
		f.context.db.insert(runtimeSubmissions).values({
			id: `sub:${childRunId}`,
			organizationId: ORG,
			subjectKind: "tedi",
			subjectId: "tedi-research",
			runId: childRunId,
			sourceKind: "tedi_message",
			status: "running",
		});
	const read = () =>
		getKernelRuntimeRun(f.context.db, { id: f.run.id, organizationId: ORG });
	return {
		...f,
		childRunId,
		eventId,
		marker,
		pending,
		invoke,
		childSubmission,
		read,
	};
}

describe("native recorded approval single-send lifecycle", () => {
	it("retains and stops an actual workstation acknowledgement after cancellation", async () => {
		const f = await resumedNativeFixture("workstation");
		const adapter = await vi.importActual<
			typeof import("./workstation-dispatch")
		>("./workstation-dispatch");
		effects.workstation.mockImplementationOnce(
			adapter.runWorkstationWorkOrderDispatch,
		);
		effects.dispatch.mockImplementationOnce(async () => {
			await f.childSubmission();
			await f.context.db
				.update(kernelRuntimeRuns)
				.set({ status: "canceled" })
				.where(eq(kernelRuntimeRuns.id, f.run.id));
			return { childRunId: f.childRunId, status: "queued" };
		});
		const result = await f.invoke();
		await Promise.all(f.pending);
		expect(result.run.status).toBe("canceled");
		expect(effects.dispatch).toHaveBeenCalledTimes(1);
		expect(effects.event).not.toHaveBeenCalled();
		expect(effects.stop).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				childRunId: f.childRunId,
				delegatedTediId: "tedi-research",
			}),
		);
		expect((await f.read())?.metadata?.homeDelegationResume).toMatchObject({
			observation: {
				outcome: "acknowledged",
				observedChildRunId: f.childRunId,
			},
			stopObservation: { completion: { outcome: "succeeded" } },
		});
	});

	it("uses the original decision once and refuses a duplicate internal send", async () => {
		const f = await resumedNativeFixture();
		effects.dispatch.mockResolvedValueOnce({
			childRunId: f.childRunId,
			status: "queued",
		});
		const result = await f.invoke();
		expect(result.run.childRunId).toBe(f.childRunId);
		expect(effects.event).not.toHaveBeenCalled();
		expect(effects.dispatch).toHaveBeenCalledTimes(1);
		expect(effects.stop).not.toHaveBeenCalled();
		await expect(f.invoke()).rejects.toThrow(/already started/);
		expect(effects.dispatch).toHaveBeenCalledTimes(1);
	});
	it("honors cancellation before the provider boundary", async () => {
		const f = await resumedNativeFixture();
		effects.promote.mockImplementationOnce(async () => {
			await f.context.db
				.update(kernelRuntimeRuns)
				.set({ status: "canceled" })
				.where(eq(kernelRuntimeRuns.id, f.run.id));
			return "delegation-work";
		});
		await expect(f.invoke()).rejects.toThrow(/canceled or already started/);
		expect(effects.dispatch).not.toHaveBeenCalled();
		expect((await f.read())?.status).toBe("canceled");
	});
	it.each([false, true])(
		"retains actual late ACK after timeout without another send (canceled=%s)",
		async (canceled) => {
			vi.useFakeTimers();
			try {
				const f = await resumedNativeFixture();
				let release!: (v: { childRunId: string; status: string }) => void;
				effects.dispatch.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							release = resolve;
						}),
				);
				const invocation = f.invoke();
				await vi.waitFor(() =>
					expect(effects.dispatch).toHaveBeenCalledTimes(1),
				);
				await vi.advanceTimersByTimeAsync(20_001);
				const first = await invocation;
				expect(first.run.metadata?.homeDelegationResume).toMatchObject({
					observation: { outcome: "unknown", observedChildRunId: null },
				});
				if (canceled)
					await f.context.db
						.update(kernelRuntimeRuns)
						.set({ status: "canceled" })
						.where(eq(kernelRuntimeRuns.id, f.run.id));
				await f.childSubmission();
				release({ childRunId: f.childRunId, status: "queued" });
				await Promise.all(f.pending);
				const saved = await f.read();
				expect(saved?.metadata?.homeDelegationResume).toMatchObject({
					observation: { outcome: "unknown" },
					lateObservation: {
						outcome: "acknowledged",
						observedChildRunId: f.childRunId,
					},
				});
				expect(saved?.status).toBe(canceled ? "canceled" : "queued");
				expect(effects.dispatch).toHaveBeenCalledTimes(1);
				expect(effects.event).not.toHaveBeenCalled();
				if (canceled) {
					expect(effects.stop).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({
							childRunId: f.childRunId,
							delegatedTediId: "tedi-research",
						}),
					);
					expect(saved?.metadata?.homeDelegationResume).toMatchObject({
						stopObservation: { completion: { outcome: "succeeded" } },
					});
				} else expect(effects.stop).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it("retains a real late ACK even when recording the initial timeout fails", async () => {
		vi.useFakeTimers();
		const writer = vi.spyOn(
			runQueries,
			"recordApprovedHomeDelegationResumeDispatch",
		);
		try {
			const f = await resumedNativeFixture();
			let release!: (v: { childRunId: string; status: string }) => void;
			effects.dispatch.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = resolve;
					}),
			);
			writer.mockRejectedValueOnce(
				new Error("fictional evidence database unavailable"),
			);
			const invocation = f.invoke();
			const rejected = expect(invocation).rejects.toThrow(
				"fictional evidence database unavailable",
			);
			await vi.waitFor(() => expect(effects.dispatch).toHaveBeenCalledTimes(1));
			await vi.advanceTimersByTimeAsync(20_001);
			await rejected;
			release({ childRunId: f.childRunId, status: "queued" });
			await Promise.all(f.pending);
			const saved = await f.read();
			expect(saved?.metadata?.homeDelegationResume).toMatchObject({
				observation: {
					outcome: "acknowledged",
					observedChildRunId: f.childRunId,
				},
			});
			expect(effects.dispatch).toHaveBeenCalledTimes(1);
		} finally {
			writer.mockRestore();
			vi.useRealTimers();
		}
	});
});
