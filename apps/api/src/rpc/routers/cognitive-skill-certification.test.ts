import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getSkillEntry: vi.fn(),
	getTediOrganizationId: vi.fn(),
	callSkillRuntime: vi.fn(),
	insertAuditEvent: vi.fn(),
	recordTediSubmissionStarted: vi.fn(),
	getSkillRun: vi.fn(),
}));
vi.mock("@tedix/db/queries/cognitive/skill-crud", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/cognitive/skill-crud")>()),
	getSkillEntry: mocks.getSkillEntry,
}));
vi.mock("@tedix/db/queries/tedis", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/tedis")>()),
	getTediOrganizationId: mocks.getTediOrganizationId,
}));
vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.insertAuditEvent,
}));
vi.mock("@tedix/db/queries/skill-runs", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/skill-runs")>()),
	getSkillRun: mocks.getSkillRun,
}));
vi.mock("../../services/skill-runtime-client", () => ({
	callSkillRuntime: mocks.callSkillRuntime,
}));
vi.mock("../../kernel/runtime-submission-bridge", async (load) => ({
	...(await load<typeof import("../../kernel/runtime-submission-bridge")>()),
	recordTediSubmissionStarted: mocks.recordTediSubmissionStarted,
}));
import { skillsRunWorkflow } from "./cognitive-skill-runs/run-start";

const input = {
	skillId: "skill-1",
	tediId: "tedi-1",
	certification: true,
	expectedSkillRevision: 7,
};
function client(patch: Partial<BaseContext> = {}) {
	return createRouterClient(skillsRunWorkflow, {
		context: {
			authType: "user",
			user: { sub: "owner-1" },
			userRole: "owner",
			organizationId: "org-1",
			db: {},
			env: { ENVIRONMENT: "development" },
			headers: new Headers(),
			url: new URL("https://api.test/rpc/skills"),
			rateLimiter: { limit: async () => ({ success: true }) },
			...patch,
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getTediOrganizationId.mockResolvedValue("org-1");
	mocks.getSkillEntry.mockResolvedValue({
		id: "skill-1",
		slug: "example",
		revision: 7,
		lifecycleState: "draft",
		content: "# Example",
		files: { "scripts/workflow.ts": "export default {}" },
	});
	mocks.callSkillRuntime.mockResolvedValue({
		runId: "run-1",
		workflowInstanceId: "run-1",
		status: "queued",
	});
});
describe("certification run admission", () => {
	it.each(["owner", "admin"])(
		"pins and audits a %s certification run",
		async (userRole) => {
			await client({ userRole })(input);
			expect(mocks.callSkillRuntime).toHaveBeenCalledWith(
				expect.anything(),
				"/run",
				expect.objectContaining({
					certification: true,
					createdBy: "user:owner-1",
					skillRevision: 7,
				}),
			);
			expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					actorId: "owner-1",
					action: "skill.certification.started",
					resourceId: "run-1",
					metadata: expect.objectContaining({
						certification: true,
						revision: 7,
					}),
				}),
			);
		},
	);
	it.each([
		{ userRole: "member" },
		{ userRole: undefined },
		{ user: undefined },
		{ authType: "service-binding" },
		{ authType: "apikey" },
		{ authType: "tedi" },
		{ externalAgentPrincipalId: "executor" },
		{ tediId: "tedi-1" },
	] as Partial<BaseContext>[])(
		"refuses certification without direct human owner/admin authority: %j",
		async (patch) => {
			await expect(client(patch)(input)).rejects.toThrow();
			expect(mocks.callSkillRuntime).not.toHaveBeenCalled();
			expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
		},
	);
	it("does not turn an ordinary draft run into certification from params", async () => {
		await client()({
			...input,
			certification: undefined,
			params: { certification: true },
		});
		expect(mocks.callSkillRuntime).toHaveBeenCalledWith(
			expect.anything(),
			"/run",
			expect.objectContaining({ certification: false }),
		);
		expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
	});
});
