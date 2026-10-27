import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	getSkillRun: vi.fn(),
	listRunTimelineArtifacts: vi.fn(),
}));
vi.mock("@tedix/db/queries/skill-runs", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/skill-runs")>()),
	getSkillRun: mocks.getSkillRun,
}));
vi.mock("@tedix/db/queries/skill-run-artifacts", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/skill-run-artifacts")>()),
	listRunTimelineArtifacts: mocks.listRunTimelineArtifacts,
}));
import { skillsGetWorkflowRunTimeline } from "./cognitive-skill-runs/run-reads";

function context(scopes = ["*"]): BaseContext {
	return {
		apiKey: { id: "key-1", name: "test", organizationId: "org-1", scopes },
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "development" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/skills"),
	};
}
const run = {
	id: "run-1",
	tediId: "tedi-1",
	status: "running",
	executionEpoch: 7,
	startedAt: null,
	completedAt: null,
	error: null,
	workflowRetiredAt: null,
};
const client = (ctx = context()) =>
	createRouterClient(
		{ getWorkflowRunTimeline: skillsGetWorkflowRunTimeline },
		{ context: ctx },
	);
describe("skills.getWorkflowRunTimeline", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillRun.mockResolvedValue({ ...run });
		mocks.listRunTimelineArtifacts.mockResolvedValue([]);
	});
	it("scopes the run by org/environment and reads the full current epoch once", async () => {
		const ctx = context();
		const result = await client(ctx).getWorkflowRunTimeline({
			runId: "run-1",
			tediId: "tedi-1",
		});
		expect(mocks.getSkillRun).toHaveBeenCalledWith(
			ctx.db,
			"run-1",
			"org-1",
			"development",
		);
		expect(mocks.listRunTimelineArtifacts).toHaveBeenCalledExactlyOnceWith(
			ctx.db,
			"run-1",
			7,
		);
		expect(result).toMatchObject({
			run: { id: "run-1", executionEpoch: 7 },
			coverage: "partial",
			events: [],
			truncated: false,
		});
	});
	it("does not read receipts for an out-of-scope run", async () => {
		mocks.getSkillRun.mockResolvedValue(undefined);
		await expect(
			client().getWorkflowRunTimeline({ runId: "other-org" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listRunTimelineArtifacts).not.toHaveBeenCalled();
	});
	it("does not read receipts for a mismatched tedi", async () => {
		await expect(
			client().getWorkflowRunTimeline({ runId: "run-1", tediId: "other-tedi" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listRunTimelineArtifacts).not.toHaveBeenCalled();
	});
	it.each([
		{ error: "REVOKED" },
		{ error: "REVOKED: by operator" },
		{ workflowRetiredAt: "2026-01-01T00:00:00Z" },
	])("hides revoked runs: %j", async (revoked) => {
		mocks.getSkillRun.mockResolvedValue({ ...run, ...revoked });
		await expect(
			client().getWorkflowRunTimeline({ runId: "run-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.listRunTimelineArtifacts).not.toHaveBeenCalled();
	});
	it("requires read scope before accessing the run", async () => {
		await expect(
			client(context(["mcp:tedis.write"])).getWorkflowRunTimeline({
				runId: "run-1",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getSkillRun).not.toHaveBeenCalled();
	});
});
