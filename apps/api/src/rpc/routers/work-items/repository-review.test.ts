import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	author: vi.fn(),
	attempt: vi.fn(),
	read: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.author,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getRecordedWorkItemAttempt: mocks.attempt,
}));
vi.mock("../../../services/work-repository-review", async (original) => ({
	...(await original<Record<string, unknown>>()),
	readWorkRepositoryReview: mocks.read,
}));
import { reviewAttemptRepository } from "./repository-review";
function args() {
	return {
		input: {
			id: "work",
			attemptId: "attempt",
			expectedHeadRevision: "a".repeat(40),
			operation: "tree",
			path: "",
			offset: 0,
		},
		context: {
			db: "db",
			user: { id: "owner" },
			userRole: "owner",
			env: { ARTIFACTS: "binding" },
		},
	} as never;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({ id: "work", orgId: "org" });
	mocks.author.mockResolvedValue("owner");
	mocks.attempt.mockResolvedValue({ id: "attempt" });
	mocks.read.mockResolvedValue({ headRevision: "a".repeat(40) });
});
describe("retained repository authorization", () => {
	it("reads the historical Attempt only through tenant and Work scope", async () => {
		await reviewAttemptRepository(args());
		expect(mocks.attempt).toHaveBeenCalledWith("db", {
			orgId: "org",
			workItemId: "work",
			attemptId: "attempt",
		});
		expect(mocks.read).toHaveBeenCalledWith(
			expect.objectContaining({
				artifacts: "binding",
				attempt: { id: "attempt" },
			}),
		);
	});
	it("denies ordinary users before repository or Attempt reads", async () => {
		mocks.author.mockRejectedValue(new Error("owner/admin only"));
		await expect(reviewAttemptRepository(args())).rejects.toThrow(
			"owner/admin",
		);
		expect(mocks.attempt).not.toHaveBeenCalled();
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("requires explicit secrets authority and rejects a foreign Attempt", async () => {
		const request = args() as Parameters<typeof reviewAttemptRepository>[0];
		Object.assign(request.context, { userRole: "member", userPermissions: [] });
		await expect(reviewAttemptRepository(request)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.attempt).not.toHaveBeenCalled();
		mocks.attempt.mockResolvedValue(null);
		await expect(reviewAttemptRepository(args())).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
