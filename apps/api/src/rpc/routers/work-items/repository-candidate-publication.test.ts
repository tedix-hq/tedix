import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	author: vi.fn(),
	external: vi.fn(),
	authoritative: vi.fn(),
	recorded: vi.fn(),
	admission: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.author,
}));
vi.mock("../work-items-principal", () => ({
	verifiedExternalAgent: mocks.external,
	assertTediAccess: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getAuthoritativeWorkItemAttempt: mocks.authoritative,
	getRecordedWorkItemAttempt: mocks.recorded,
	recordWorkAttemptRepositoryCandidatePublication: vi.fn(),
	claimWorkAttemptRepositoryCandidatePublication: vi.fn(),
}));
vi.mock("../../../services/work-repository-candidate-access", () => ({
	assertRepositoryCandidateAdmission: mocks.admission,
}));
vi.mock(
	"../../../services/work-repository-candidate-publication",
	async (original) => ({
		...(await original<Record<string, unknown>>()),
		applyRepositoryCandidatePublication: async (io: {
			authority: () => Promise<unknown>;
		}) => io.authority(),
		reconcileRepositoryCandidatePublication: mocks.reconcile,
	}),
);
import {
	applyRepositoryCandidate,
	reconcileRepositoryCandidate,
} from "./repository-candidate-publication";
const id = "11111111-1111-4111-8111-111111111111",
	attemptId = "22222222-2222-4222-8222-222222222222";
function context() {
	return {
		db: {},
		env: {},
		organizationId: "org",
		authType: "user",
		userRole: "owner",
		userId: "owner",
		user: { sub: "owner", roles: ["owner"] },
		userPermissions: ["secrets:manage"],
		permissions: ["secrets:manage"],
	} as unknown as BaseContext;
}
const input = {
	id,
	attemptId,
	expectedBaseRevision: "a".repeat(40),
	expectedPosition: { generation: 0, revision: 1 },
	expectedContentDigest: "b".repeat(64),
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({ id, orgId: "org" });
	mocks.author.mockResolvedValue("owner");
	mocks.external.mockResolvedValue({
		executor: { type: "external_agent", id: "executor", sessionId: "session" },
		externalSessionKey: "fence",
	});
	mocks.authoritative.mockImplementation(async (_db, p) => {
		if (
			p.executor.id !== "executor" ||
			p.sessionId !== "session" ||
			p.externalSessionKey !== "fence"
		)
			throw new Error("stale peer");
		return { id: attemptId };
	});
	mocks.recorded.mockResolvedValue({ id: attemptId, runtimeState: "expired" });
	mocks.admission.mockResolvedValue(undefined);
	mocks.reconcile.mockResolvedValue({ observed: true });
});
describe("native repository publication authority", () => {
	it("rejects browser apply and reconciliation before Git or historical reads", async () => {
		mocks.external.mockResolvedValue(null);
		await expect(
			applyRepositoryCandidate({ context: context(), input } as never),
		).rejects.toThrow(/verified/);
		await expect(
			reconcileRepositoryCandidate({
				context: context(),
				input: { id, attemptId },
			} as never),
		).rejects.toThrow(/verified/);
		expect(mocks.recorded).not.toHaveBeenCalled();
	});
	it("fences apply to the actual native executor and session", async () => {
		await applyRepositoryCandidate({ context: context(), input } as never);
		expect(mocks.authoritative).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				executor: {
					type: "external_agent",
					id: "executor",
					sessionId: "session",
				},
				sessionId: "session",
				externalSessionKey: "fence",
			}),
		);
		mocks.external.mockResolvedValue({
			executor: { type: "external_agent", id: "peer", sessionId: "other" },
			externalSessionKey: "other",
		});
		await expect(
			applyRepositoryCandidate({ context: context(), input } as never),
		).rejects.toThrow(/stale/);
	});
	it("rejects revoked owner/admin authorization", async () => {
		mocks.author.mockRejectedValue(new Error("revoked membership"));
		await expect(
			applyRepositoryCandidate({ context: context(), input } as never),
		).rejects.toThrow(/revoked/);
		expect(mocks.authoritative).not.toHaveBeenCalled();
	});
	it("rejects missing secrets authority", async () => {
		const c = context();
		Object.assign(c, {
			userRole: "viewer",
			user: { sub: "owner", roles: [] },
			userPermissions: [],
			permissions: [],
		});
		await expect(
			applyRepositoryCandidate({ context: c, input } as never),
		).rejects.toThrow(/secrets/);
		expect(mocks.authoritative).not.toHaveBeenCalled();
	});
	it("reconciles historical Attempts without active authority or terminal mutation", async () => {
		await reconcileRepositoryCandidate({
			context: context(),
			input: { id, attemptId },
		} as never);
		expect(mocks.recorded).toHaveBeenCalledWith(expect.anything(), {
			orgId: "org",
			workItemId: id,
			attemptId,
		});
		expect(mocks.authoritative).not.toHaveBeenCalled();
		expect(mocks.admission).not.toHaveBeenCalled();
		expect(mocks.reconcile).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				attempt: { id: attemptId, runtimeState: "expired" },
			}),
		);
	});
});
