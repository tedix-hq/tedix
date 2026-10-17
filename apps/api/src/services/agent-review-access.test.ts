import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/context";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	member: vi.fn(),
	item: vi.fn(),
}));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectById: mocks.project,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByCanonicalUserId: mocks.member,
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/work-items/project-access", () => ({
	hasProjectWorkItemReference: mocks.item,
}));
import { guardAgentReviewAccess } from "./agent-review-access";

const project = {
	id: "private-reviews",
	orgId: "fictional-org",
	leadTediId: "fictional-triage",
};
function context(overrides: Partial<BaseContext> = {}) {
	return {
		env: { AGENT_REVIEW_PROJECT_ID: project.id },
		db: {},
		organizationId: project.orgId,
		authType: "user",
		user: { sub: "fictional-user" },
		...overrides,
	} as BaseContext;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.project.mockResolvedValue(project);
	mocks.member.mockResolvedValue({ status: "active", role: "member" });
	mocks.item.mockImplementation(async (_db, { ids }) =>
		ids.includes("private-work"),
	);
});

describe("private review project access", () => {
	it.each(["owner", "admin"])(
		"allows a fresh active %s membership",
		async (role) => {
			mocks.member.mockResolvedValue({ status: "active", role });
			const next = vi.fn(async () => ({
				output: { report: "private report" },
			}));
			await guardAgentReviewAccess(context(), { projectId: project.id }, next);
			expect(next).toHaveBeenCalledOnce();
		},
	);
	it.each([
		{ status: "inactive", role: "admin" },
		{ status: "active", role: "viewer" },
		null,
	])("does not trust stale admin claims", async (member) => {
		mocks.member.mockResolvedValue(member);
		const next = vi.fn();
		await expect(
			guardAgentReviewAccess(
				context({ userRole: "admin" }),
				{ id: "private-work" },
				next,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(next).not.toHaveBeenCalled();
	});
	it.each([
		{ id: project.id },
		{ projectId: project.id },
		{ workItemId: "private-work" },
		{ workItemIds: ["private-work"] },
		{ nested: { id: "private-work" } },
	])(
		"blocks reads and writes before running a protected operation",
		async (input) => {
			const next = vi.fn();
			await expect(
				guardAgentReviewAccess(context(), input, next),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(next).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ data: [{ projectId: project.id, description: "private report" }] },
		{ nested: { workItemId: "private-work", body: "private comment" } },
		{ projects: [{ id: project.id }] },
	])("blocks nested aggregate disclosures", async (output) => {
		await expect(
			guardAgentReviewAccess(context(), {}, async () => ({ output })),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("allows only the designated triage tedi in the destination org", async () => {
		await expect(
			guardAgentReviewAccess(
				context({ authType: "tedi", tediId: project.leadTediId }),
				{ id: "private-work" },
				async () => ({ output: "ok" }),
			),
		).resolves.toMatchObject({ output: "ok" });
		await expect(
			guardAgentReviewAccess(
				context({
					authType: "tedi",
					tediId: "another-tedi",
					tediScopes: ["platform:admin"],
				}),
				{ id: "private-work" },
				async () => ({ output: "leak" }),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			guardAgentReviewAccess(
				context({
					authType: "tedi",
					tediId: project.leadTediId,
					organizationId: "another-org",
				}),
				{ id: "private-work" },
				async () => ({ output: "leak" }),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("allows unrelated work and has no effect without an intake project", async () => {
		await expect(
			guardAgentReviewAccess(context(), { id: "ordinary-work" }, async () => ({
				output: { id: "ordinary-work" },
			})),
		).resolves.toMatchObject({ output: { id: "ordinary-work" } });
		mocks.project.mockClear();
		await guardAgentReviewAccess(
			context({ env: {} as CloudflareEnv }),
			{},
			async () => ({ output: "ok" }),
		);
		expect(mocks.project).not.toHaveBeenCalled();
	});
});

it("fails closed when the configured private project cannot be loaded", async () => {
	mocks.project.mockResolvedValue(undefined);
	const next = vi.fn();
	await expect(
		guardAgentReviewAccess(context(), {}, next),
	).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	expect(next).not.toHaveBeenCalled();
});
