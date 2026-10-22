import { DatabaseSync } from "node:sqlite";
import type { KernelGovernancePolicy } from "@tedix/api-contract/utils/approval-policy";
import { createRouterClient } from "@orpc/server";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { tediApprovalDependencyEvents } from "@tedix/db/schema/approval-simulations";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import {
	kernelConversations,
	kernelConversationGrants,
	kernelRuntimeRuns,
} from "@tedix/db/schema/cognitive-runtime";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { workEvents } from "@tedix/db/schema/work-items";
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

const effects = vi.hoisted(() => ({
	event: vi.fn(async () => ({})),
	promote: vi.fn(async () => "delegation-work"),
	dispatch: vi.fn(async () => ({ childRunId: "child", status: "queued" })),
	workstation: vi.fn(),
	learning: vi.fn(),
	settle: vi.fn(),
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
}));
vi.mock("./policy-normalization", async (original) => ({
	...(await original<typeof import("./policy-normalization")>()),
	kernelDelegateRunner: effects.dispatch,
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
