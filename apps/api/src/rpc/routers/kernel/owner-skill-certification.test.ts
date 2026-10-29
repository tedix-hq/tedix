import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { HomeToolWritePayload } from "./write-executor";

const mocks = vi.hoisted(() => ({
	member: vi.fn(),
	client: vi.fn(),
	run: vi.fn(),
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("@orpc/server", () => ({ createRouterClient: mocks.client }));
vi.mock("../cognitive-skill-runs/run-start", () => ({ skillsRunWorkflow: {} }));
import { executeOwnerSkillCertification } from "./owner-skill-certification";

const context = {
	authType: "user",
	user: { sub: "owner" },
	userRole: "owner",
	organizationId: "org",
	db: {},
} as BaseContext;
const payload = {
	kind: "home_tool_write",
	toolName: "skills.run_workflow",
	organizationId: "org",
	initiatedByUserId: "owner",
	args: {
		skillId: "skill",
		tediId: "tedi",
		certification: true,
		expectedSkillRevision: 7,
		idempotencyKey: "stable-test",
		params: { mode: "daily" },
	},
} as HomeToolWritePayload;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.member.mockResolvedValue({ status: "active", role: "owner" });
	mocks.client.mockReturnValue(mocks.run);
	mocks.run.mockResolvedValue({ runId: "run" });
});
describe("owner certification execution", () => {
	it("uses the original owner context and the stored pinned arguments", async () => {
		expect(await executeOwnerSkillCertification(context, payload)).toEqual({
			ok: true,
			data: { runId: "run" },
		});
		expect(mocks.client).toHaveBeenCalledWith(expect.anything(), { context });
		expect(mocks.run).toHaveBeenCalledWith(payload.args);
		expect(mocks.member).toHaveBeenCalledWith(context.db, "org", "owner");
	});
	it.each([
		{ authType: "apikey" },
		{ authType: "service-binding" },
		{ authType: "tedi" },
		{ externalAgentPrincipalId: "agent" },
		{ tediId: "tedi" },
		{ user: { sub: "other-owner" } },
		{ organizationId: "other-org" },
	])("refuses a substituted caller %j", async (patch) => {
		expect(
			await executeOwnerSkillCertification(
				{ ...context, ...patch } as BaseContext,
				payload,
			),
		).toMatchObject({ ok: false });
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it.each([
		{ status: "inactive", role: "owner" },
		{ status: "active", role: "member" },
		null,
	])("refuses revoked owner authority %j", async (member) => {
		mocks.member.mockResolvedValue(member);
		expect(
			await executeOwnerSkillCertification(context, payload),
		).toMatchObject({ ok: false });
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it("refuses an agent-started request even if an owner approves it", async () => {
		expect(
			await executeOwnerSkillCertification(context, {
				...payload,
				initiatedByUserId: null,
				initiatedByAgentPrincipalId: "agent",
			}),
		).toMatchObject({ ok: false });
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it("refuses an unpinned legacy request", async () => {
		expect(
			await executeOwnerSkillCertification(context, {
				...payload,
				args: { ...payload.args, expectedSkillRevision: undefined },
			}),
		).toMatchObject({ ok: false });
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it("leaves ordinary writes on their existing executor", async () => {
		expect(
			await executeOwnerSkillCertification(context, {
				...payload,
				args: { certification: false },
			}),
		).toBeNull();
		expect(mocks.member).not.toHaveBeenCalled();
	});
});
