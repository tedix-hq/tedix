import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";

const ids = {
	normal: "10000000-0000-4000-8000-000000000001",
	rig: "10000000-0000-4000-8000-000000000002",
	promotion: "10000000-0000-4000-8000-000000000003",
	prerequisite: "10000000-0000-4000-8000-000000000004",
	dependent: "10000000-0000-4000-8000-000000000005",
	componentChild: "10000000-0000-4000-8000-000000000006",
};

const calls: string[] = [];
const rows = new Map<string, ReturnType<typeof approvalRow>>();
const mocks = vi.hoisted(() => ({
	executePromotion: vi.fn(),
	getApproval: vi.fn(),
	insertAudit: vi.fn(),
	invalidateDependency: vi.fn(),
	listDependencies: vi.fn(),
	listReceipts: vi.fn(),
	recordLearning: vi.fn(),
	resolveApproval: vi.fn(),
	settleHome: vi.fn(),
}));

vi.mock("@tedix/db/queries/approvals", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/approvals")>()),
	getApprovalRequestById: mocks.getApproval,
	resolveApprovalRequest: mocks.resolveApproval,
}));
vi.mock("@tedix/db/queries/approval-simulations", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/approval-simulations")
	>()),
	invalidateApprovalDependency: mocks.invalidateDependency,
	listActiveApprovalDependencies: mocks.listDependencies,
	listApprovalExecutionReceipts: mocks.listReceipts,
}));
vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.insertAudit,
}));
vi.mock("./learning-interaction-recorder", () => ({
	recordObservedLearningInteraction: mocks.recordLearning,
}));
vi.mock("./provisional-outcome-promotion", async (importOriginal) => ({
	...(await importOriginal<typeof import("./provisional-outcome-promotion")>()),
	executeApprovedProvisionalPromotion: mocks.executePromotion,
}));
vi.mock("../rpc/routers/kernel/write-approval-settlement", () => ({
	settleHomeToolWriteApproval: mocks.settleHome,
}));

import { tediApprovalsContractRouter } from "../rpc/routers/tedi-approvals";

function approvalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ids.normal,
		tediId: "20000000-0000-4000-8000-000000000001",
		orgId: "org-1",
		actionType: "deploy",
		description: "Approve one exact action",
		payload: { kind: "test" },
		status: "pending" as const,
		createdAt: "2026-09-22T10:00:00.000Z",
		expiresAt: "2099-09-22T10:00:00.000Z",
		resolvedAt: null,
		resolvedBy: null,
		resolution: null,
		workflowId: null,
		...overrides,
	};
}

function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "apikey",
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: "org-1",
			scopes: ["*"],
		},
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/tedi-approvals"),
		...overrides,
	} as BaseContext;
}

function client(overrides: Partial<BaseContext> = {}) {
	return createRouterClient(tediApprovalsContractRouter, {
		context: context(overrides),
	});
}

beforeEach(() => {
	rows.clear();
	calls.length = 0;
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.getApproval.mockImplementation(async (_db, id: string) => rows.get(id));
	mocks.listDependencies.mockResolvedValue([]);
	mocks.listReceipts.mockResolvedValue([]);
	mocks.insertAudit.mockResolvedValue("audit-1");
	mocks.invalidateDependency.mockImplementation(async () => {
		calls.push("invalidate");
		return {};
	});
	mocks.settleHome.mockResolvedValue("not_applicable");
	mocks.resolveApproval.mockImplementation(async (_db, id, resolution) => {
		const row = rows.get(id);
		if (!row || row.status !== "pending") return undefined;
		calls.push(`resolve:${id}:${resolution.status}:${resolution.resolvedBy}`);
		const resolved = {
			...row,
			status: resolution.status,
			resolvedAt: "2026-09-22T11:00:00.000Z",
			resolvedBy: resolution.resolvedBy,
			resolution: resolution.resolution ?? null,
		};
		rows.set(id, resolved as ReturnType<typeof approvalRow>);
		return resolved;
	});
});

describe("ordered approval manifest resolution", () => {
	it("rejects manifest drift before any effect", async () => {
		rows.set(ids.normal, approvalRow());
		const api = client();
		const manifest = await api.getReviewManifest({
			approvalRequestIds: [ids.normal],
		});
		await expect(
			api.resolveReviewManifest({
				approvalRequestIds: [ids.normal],
				expectedManifestHash: `sha256:${"0".repeat(64)}`,
				decisions: [
					{
						approvalRequestId: ids.normal,
						expectedCanonicalInputHash: manifest.actions[0]!.canonicalInputHash,
						decision: "veto",
					},
				],
			}),
		).rejects.toThrow("reload the manifest");
		expect(mocks.resolveApproval).not.toHaveBeenCalled();
	});

	it("validates a later human-only decision before an earlier veto can persist", async () => {
		rows.set(ids.normal, approvalRow());
		rows.set(
			ids.rig,
			approvalRow({
				id: ids.rig,
				actionType: "product_motion_rig_admission",
				payload: { kind: "product_motion_rig_admission_v1" },
			}),
		);
		const api = client();
		const manifest = await api.getReviewManifest({
			approvalRequestIds: [ids.normal, ids.rig],
		});
		await expect(
			api.resolveReviewManifest({
				approvalRequestIds: [ids.normal, ids.rig],
				expectedManifestHash: manifest.manifestHash,
				decisions: manifest.actions.map((action) => ({
					approvalRequestId: action.approval.id,
					expectedCanonicalInputHash: action.canonicalInputHash,
					decision: "veto" as const,
				})),
			}),
		).rejects.toThrow("authenticated human approver");
		expect(mocks.resolveApproval).not.toHaveBeenCalled();
	});

	it("records the canonical gateway user and reports failed promotion settlement", async () => {
		rows.set(
			ids.promotion,
			approvalRow({
				id: ids.promotion,
				actionType: "provisional_outcome_promotion",
				payload: {
					kind: "provisional_outcome_promotion_v2",
					provisionalOutcomeId: "outcome-1",
					provisionalOutcomeHash: "sha256:proposal",
				},
			}),
		);
		mocks.executePromotion.mockResolvedValue(null);
		const api = client({ gatewayEndUserId: "6190" });
		const manifest = await api.getReviewManifest({
			approvalRequestIds: [ids.promotion],
		});
		const result = await api.resolveReviewManifest({
			approvalRequestIds: [ids.promotion],
			expectedManifestHash: manifest.manifestHash,
			decisions: [
				{
					approvalRequestId: ids.promotion,
					expectedCanonicalInputHash: manifest.actions[0]!.canonicalInputHash,
					decision: "approve",
				},
			],
		});
		expect(mocks.resolveApproval).toHaveBeenCalledWith(
			expect.anything(),
			ids.promotion,
			expect.objectContaining({ resolvedBy: "user:6190" }),
		);
		expect(mocks.executePromotion).toHaveBeenCalledTimes(1);
		expect(result.results).toEqual([
			expect.objectContaining({
				approvalRequestId: ids.promotion,
				outcome: "failed",
			}),
		]);
	});

	it("does not report success from an unrelated Home receipt", async () => {
		rows.set(
			ids.normal,
			approvalRow({
				status: "approved",
				payload: {
					kind: "home_tool_write",
					organizationId: "org-1",
					homeRunId: "run-1",
				},
			}),
		);
		mocks.listReceipts.mockResolvedValue([
			{
				id: "receipt-unrelated",
				canonicalInputHash: `sha256:${"f".repeat(64)}`,
				outcome: "succeeded",
			},
		]);
		const manifest = await client().getReviewManifest({
			approvalRequestIds: [ids.normal],
		});
		expect(manifest.actions[0]!.execution).toEqual({
			state: "unknown",
			receiptId: null,
		});
	});

	it("expands a selected action to its complete hard dependency component", async () => {
		rows.set(
			ids.prerequisite,
			approvalRow({
				id: ids.prerequisite,
				description: "Hard prerequisite",
				createdAt: "2026-09-22T09:00:00.000Z",
			}),
		);
		rows.set(
			ids.dependent,
			approvalRow({ id: ids.dependent, description: "Selected action" }),
		);
		rows.set(
			ids.componentChild,
			approvalRow({
				id: ids.componentChild,
				description: "Hard-dependent action",
				createdAt: "2026-09-22T11:00:00.000Z",
			}),
		);
		const edges = [
			{
				id: "dependency-parent",
				organizationId: "org-1",
				dependentApprovalRequestId: ids.dependent,
				prerequisiteApprovalRequestId: ids.prerequisite,
				simulationId: "simulation-1",
				eventType: "declared",
				dependencyKind: "hard",
				invalidatesEventId: null,
				reason: null,
				recordHash: "sha256:dependency-parent",
				createdAt: "2026-09-22T10:00:00.000Z",
			},
			{
				id: "dependency-child",
				organizationId: "org-1",
				dependentApprovalRequestId: ids.componentChild,
				prerequisiteApprovalRequestId: ids.dependent,
				simulationId: "simulation-2",
				eventType: "declared",
				dependencyKind: "hard",
				invalidatesEventId: null,
				reason: null,
				recordHash: "sha256:dependency-child",
				createdAt: "2026-09-22T10:01:00.000Z",
			},
		];
		mocks.listDependencies.mockImplementation(async (_db, input) =>
			edges.filter((edge) => {
				const dependent = input.approvalRequestIds.includes(
					edge.dependentApprovalRequestId,
				);
				const prerequisite = input.approvalRequestIds.includes(
					edge.prerequisiteApprovalRequestId,
				);
				return input.relation === "dependent"
					? dependent
					: input.relation === "prerequisite"
						? prerequisite
						: dependent || prerequisite;
			}),
		);

		const manifest = await client().getReviewManifest({
			approvalRequestIds: [ids.dependent],
		});

		expect(manifest.actions.map((action) => action.approval.id)).toEqual([
			ids.prerequisite,
			ids.dependent,
			ids.componentChild,
		]);
		expect(manifest.actions.map((action) => action.inclusion)).toEqual([
			"hard_dependency_component",
			"requested",
			"hard_dependency_component",
		]);
		expect(manifest.actions[1]!.dependencies).toEqual([
			expect.objectContaining({
				prerequisiteApprovalRequestId: ids.prerequisite,
				kind: "hard",
			}),
		]);
	});

	it("rejects a hard dependency component whose action cannot be loaded", async () => {
		rows.set(
			ids.dependent,
			approvalRow({ id: ids.dependent, description: "Selected action" }),
		);
		mocks.listDependencies.mockImplementation(async (_db, input) =>
			input.approvalRequestIds.includes(ids.dependent)
				? [
						{
							id: "dependency-missing",
							organizationId: "org-1",
							dependentApprovalRequestId: ids.dependent,
							prerequisiteApprovalRequestId: ids.prerequisite,
							simulationId: "simulation-1",
							eventType: "declared",
							dependencyKind: "hard",
							invalidatesEventId: null,
							reason: null,
							recordHash: "sha256:dependency-missing",
							createdAt: "2026-09-22T10:00:00.000Z",
						},
					]
				: [],
		);

		await expect(
			client().getReviewManifest({ approvalRequestIds: [ids.dependent] }),
		).rejects.toThrow("dependency component is incomplete");
	});

	it("cancels hard descendants before invalidating their edge", async () => {
		rows.set(
			ids.prerequisite,
			approvalRow({ id: ids.prerequisite, description: "Root" }),
		);
		rows.set(
			ids.dependent,
			approvalRow({ id: ids.dependent, description: "Dependent" }),
		);
		const edge = {
			id: "dependency-1",
			organizationId: "org-1",
			dependentApprovalRequestId: ids.dependent,
			prerequisiteApprovalRequestId: ids.prerequisite,
			simulationId: "simulation-1",
			eventType: "declared",
			dependencyKind: "hard",
			invalidatesEventId: null,
			reason: null,
			recordHash: "sha256:dependency",
			createdAt: "2026-09-22T10:00:00.000Z",
		};
		mocks.listDependencies.mockImplementation(async (_db, input) => {
			if (calls.includes("invalidate")) return [];
			return input.relation === "dependent"
				? input.approvalRequestIds.includes(ids.dependent)
					? [edge]
					: []
				: input.relation === "prerequisite"
					? input.approvalRequestIds.includes(ids.prerequisite)
						? [edge]
						: []
					: input.approvalRequestIds.includes(ids.prerequisite) ||
						  input.approvalRequestIds.includes(ids.dependent)
						? [edge]
						: [];
		});
		const api = client({ gatewayEndUserId: "6190" });
		const manifest = await api.getReviewManifest({
			approvalRequestIds: [ids.dependent],
		});
		const root = manifest.actions.find(
			(action) => action.approval.id === ids.prerequisite,
		)!;
		const dependent = manifest.actions.find(
			(action) => action.approval.id === ids.dependent,
		)!;
		const result = await api.resolveReviewManifest({
			approvalRequestIds: [ids.dependent],
			expectedManifestHash: manifest.manifestHash,
			decisions: [
				{
					approvalRequestId: root.approval.id,
					expectedCanonicalInputHash: root.canonicalInputHash,
					decision: "veto",
				},
				{
					approvalRequestId: dependent.approval.id,
					expectedCanonicalInputHash: dependent.canonicalInputHash,
					decision: "approve",
				},
			],
		});
		expect(calls).toEqual([
			`resolve:${ids.prerequisite}:rejected:user:6190`,
			`resolve:${ids.dependent}:cancelled:user:6190`,
			"invalidate",
		]);
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					approvalRequestId: ids.dependent,
					outcome: "cascade_cancelled",
				}),
				expect.objectContaining({
					approvalRequestId: ids.dependent,
					outcome: "blocked",
				}),
			]),
		);
	});
});
