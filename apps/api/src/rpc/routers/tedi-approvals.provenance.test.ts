import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	hasRequest: vi.fn(),
	simulations: vi.fn(),
	receipts: vi.fn(),
	recordSimulation: vi.fn(),
	recordReceipt: vi.fn(),
	resolve: vi.fn(),
	settle: vi.fn(),
	promote: vi.fn(),
}));
vi.mock("@tedix/db/queries/approval-simulations", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/approval-simulations")
	>()),
	hasApprovalProvenanceRequest: mocks.hasRequest,
	listApprovalSimulationPage: mocks.simulations,
	listApprovalExecutionReceiptPage: mocks.receipts,
	recordApprovalSimulation: mocks.recordSimulation,
	recordApprovalExecutionReceipt: mocks.recordReceipt,
}));
vi.mock("@tedix/db/queries/approvals", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/approvals")>()),
	resolveApprovalRequest: mocks.resolve,
}));
vi.mock("./kernel/write-approval-settlement", () => ({
	settleHomeToolWriteApproval: mocks.settle,
}));
vi.mock(
	"../../services/provisional-outcome-promotion",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../services/provisional-outcome-promotion")
		>()),
		executeApprovedProvisionalPromotion: mocks.promote,
	}),
);
import { tediApprovalsContractRouter } from "./tedi-approvals";

const id = "10000000-0000-4000-8000-000000000001";
const scope = { organizationId: "org-1", approvalRequestId: id };
const prediction = {
	id: "simulation-1",
	...scope,
	simulatorId: "preview",
	simulatorVersion: "1",
	canonicalInputHash: "sha256:input",
	recordHash: "sha256:prediction",
	baselineEvidenceRefs: [{ ref: "config://test", revision: "1" }],
	predictedResult: { title: "Draft" },
	assumptions: [{ name: "local", value: true }],
	confidence: 0.8,
	evidenceKind: "simulation",
	notProof: true,
	createdAt: "2026-10-02T00:00:00Z",
};
const receipt = {
	id: "receipt-1",
	...scope,
	simulationId: "simulation-1",
	idempotencyKey: "execute-1",
	canonicalInputHash: "sha256:input",
	recordHash: "sha256:receipt",
	baselineFenceOutcome: "matched",
	outcome: "succeeded",
	observedResult: { title: "Observed draft" },
	observedError: null,
	providerReceiptRefs: [{ provider: "tedix", ref: "draft-1" }],
	executedAt: "2026-10-02T01:00:00Z",
	createdAt: "2026-10-02T01:00:00Z",
};
function client(
	organizationId: string | undefined = "org-1",
	scopes = ["mcp:memory.admin"],
	overrides: Partial<BaseContext> = {},
) {
	return createRouterClient(tediApprovalsContractRouter, {
		context: {
			authType: "apikey",
			apiKey: { id: "key", name: "test", organizationId, scopes },
			organizationId,
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			url: new URL("https://api.tedix.test/rpc/tediApprovals"),
			rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
			...overrides,
		} as unknown as BaseContext,
	});
}
beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.hasRequest.mockResolvedValue(true);
	mocks.simulations.mockResolvedValue({
		records: [prediction],
		nextCursor: null,
	});
	mocks.receipts.mockResolvedValue({ records: [receipt], nextCursor: null });
});

describe("approval provenance inspection", () => {
	it("preserves complete marked predictions and distinct observed receipts without executing or mutating", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response());
		const result = await client().getProvenance({ approvalRequestId: id });
		expect(mocks.hasRequest).toHaveBeenCalledWith({}, scope);
		expect(mocks.simulations).toHaveBeenCalledWith({}, scope, { limit: 10 });
		expect(result.simulations.records[0]).toEqual(prediction);
		expect(result.executionReceipts.records[0]).toEqual({
			...receipt,
			evidenceKind: "execution_receipt",
		});
		for (const mock of [
			mocks.recordSimulation,
			mocks.recordReceipt,
			mocks.resolve,
			mocks.settle,
			mocks.promote,
		])
			expect(mock).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		fetch.mockRestore();
	});
	it("allows a human reviewer and denies a member lacking approval authority", async () => {
		const human = {
			authType: "user" as const,
			apiKey: undefined,
			user: {
				sub: "human-1",
				roles: [],
				permissions: [],
			} as BaseContext["user"],
			userRole: "owner" as const,
		};
		await expect(
			client("org-1", [], human).getProvenance({ approvalRequestId: id }),
		).resolves.toMatchObject({ approvalRequestId: id });
		mocks.hasRequest.mockClear();
		await expect(
			client("org-1", [], { ...human, userRole: "member" }).getProvenance({
				approvalRequestId: id,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.hasRequest).not.toHaveBeenCalled();
	});
	it("denies foreign or missing requests before any ledger read", async () => {
		mocks.hasRequest.mockResolvedValue(false);
		await expect(
			client().getProvenance({ approvalRequestId: id }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.simulations).not.toHaveBeenCalled();
		expect(mocks.receipts).not.toHaveBeenCalled();
	});
	it("requires organization and approval-review machine scope", async () => {
		await expect(
			client("org-1", ["apps:read"]).getProvenance({ approvalRequestId: id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client("" as string).getProvenance({ approvalRequestId: id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.hasRequest).not.toHaveBeenCalled();
	});
	it("forwards independent cursors and preserves failed observed errors and empty prediction history", async () => {
		mocks.simulations.mockResolvedValue({ records: [], nextCursor: null });
		const error = {
			code: "STALE",
			message: "Baseline changed",
			retryable: false,
		};
		mocks.receipts.mockResolvedValue({
			records: [
				{
					...receipt,
					outcome: "failed",
					observedResult: null,
					observedError: error,
					baselineFenceOutcome: "stale",
				},
			],
			nextCursor: null,
		});
		const cursor = { timestamp: "2026-10-02T00:00:00Z", id: "simulation-0" };
		const result = await client().getProvenance({
			approvalRequestId: id,
			simulations: { limit: 1, cursor },
			executionReceipts: { limit: 25 },
		});
		expect(mocks.simulations).toHaveBeenCalledWith({}, scope, {
			limit: 1,
			cursor,
		});
		expect(mocks.receipts).toHaveBeenCalledWith({}, scope, { limit: 25 });
		expect(result.simulations.records).toEqual([]);
		expect(result.executionReceipts.records[0]).toMatchObject({
			outcome: "failed",
			observedError: error,
			observedResult: null,
		});
	});
	it("rejects corrupted simulation proof markers instead of presenting them as observations", async () => {
		mocks.simulations.mockResolvedValue({
			records: [{ ...prediction, notProof: false }],
			nextCursor: null,
		});
		await expect(
			client().getProvenance({ approvalRequestId: id }),
		).rejects.toThrow();
	});
});
