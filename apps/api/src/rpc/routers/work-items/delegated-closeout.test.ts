import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	home: vi.fn(),
	member: vi.fn(),
	tedi: vi.fn(),
	item: vi.fn(),
	attempts: vi.fn(),
	complete: vi.fn(),
	policy: vi.fn(),
}));
vi.mock("@orpc/server", async (original) => ({
	...(await original<typeof import("@orpc/server")>()),
	createRouterClient: () => ({ resolveAgentTransportPolicy: mocks.policy }),
}));
vi.mock("../mcp-governance", () => ({ mcpGovernanceContractRouter: {} }));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	getKernelRuntimeRun: mocks.home,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("../work-items-principal", () => ({ assertTediAccess: mocks.tedi }));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: mocks.attempts,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.item,
	completeWorkItem: mocks.complete,
}));
import { closeoutDelegatedWork } from "./delegated-closeout";

const project = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
const input = {
	id: "target",
	homeRunId: "home",
	runId: "child",
	linkedWorkItemId: "linked",
	sha,
};
const context = {
	authType: "service-binding",
	tediId: "tedi",
	organizationId: "org",
	db: {},
	headers: new Headers({ "X-Tedix-Caller-Source": "http-platform-client" }),
} as BaseContext;
const item = {
	id: "target",
	orgId: "org",
	projectId: project,
	disposition: "accepted",
	workKind: "coding",
	riskLevel: "medium",
	version: 7,
};
const home = () => ({
	status: "running",
	delegatedTediId: "tedi",
	childRunId: "child",
	metadata: {
		workItemId: "linked",
		redriveInput: {
			descopeUserId: "subject",
			content: `Work backlog hygiene in project ${project}: Mark each completed with a closing comment.`,
		},
		homeDelegation: {
			workOrder: {
				capabilityPlan: {
					version: "delegation-capabilities.v1",
					requiredCapabilities: ["work.closeout"],
					allowedToolIds: ["close_completed_work_item"],
					missingCapabilities: [],
					urls: [],
					outputIds: [],
				},
			},
		},
	},
});
beforeEach(() => {
	vi.clearAllMocks();
	mocks.home.mockResolvedValue(home());
	mocks.member.mockResolvedValue({
		status: "active",
		role: "owner",
		userId: "owner",
	});
	mocks.tedi.mockResolvedValue({ id: "tedi", status: "active" });
	mocks.item.mockResolvedValue(item);
	mocks.policy.mockResolvedValue({
		autonomy: { version: 1, maxRisk: "medium" },
		requireExplicitApprovalPolicy: false,
	});
	mocks.attempts.mockImplementation(async (_db, params) => ({
		data:
			params.workItemId === "linked"
				? [
						{
							executorType: "tedi",
							executorId: "tedi",
							runId: "child",
							runtimeState: "running",
							expiresAt: "2099-01-01T00:00:00Z",
						},
					]
				: [
						{
							id: "settled",
							runtimeState: "finished",
							outcome: "succeeded",
							finishedAt: "2026-10-20",
							summary: `Landed ${sha}`,
						},
					],
	}));
	mocks.complete.mockResolvedValue({ ...item, disposition: "completed" });
});
describe("native project-scoped Home closeout", () => {
	it("records the acting tedi, delegating owner and settled Attempt; uses target version CAS", async () => {
		expect(await closeoutDelegatedWork(context, input)).toMatchObject({
			disposition: "completed",
		});
		expect(mocks.complete).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({
				actor: { type: "tedi", id: "tedi" },
				expectedWorkItemVersion: 7,
			}),
		);
		expect(mocks.complete).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({
				closingComment: expect.objectContaining({
					metadata: expect.objectContaining({
						delegatedByUserId: "owner",
						settledAttemptId: "settled",
					}),
				}),
			}),
		);
	});
	for (const [label, alter] of [
		[
			"wrong child",
			() => mocks.home.mockResolvedValue({ ...home(), childRunId: "other" }),
		],
		[
			"terminal Home",
			() => mocks.home.mockResolvedValue({ ...home(), status: "completed" }),
		],
		[
			"inactive owner",
			() =>
				mocks.member.mockResolvedValue({ status: "inactive", role: "owner" }),
		],
		[
			"member requester",
			() =>
				mocks.member.mockResolvedValue({ status: "active", role: "member" }),
		],
		[
			"paused tedi",
			() => mocks.tedi.mockResolvedValue({ id: "tedi", status: "paused" }),
		],
		[
			"foreign project",
			() => mocks.item.mockResolvedValue({ ...item, projectId: "other" }),
		],
		[
			"critical target",
			() => mocks.item.mockResolvedValue({ ...item, riskLevel: "critical" }),
		],
		[
			"always ask",
			() =>
				mocks.policy.mockResolvedValue({
					autonomy: { version: 1, maxRisk: "medium", askForClasses: ["*"] },
				}),
		],
		[
			"canonical completion always ask",
			() =>
				mocks.policy.mockResolvedValue({
					autonomy: {
						version: 1,
						maxRisk: "medium",
						askForClasses: ["tool:tedix:tedix__complete_work_item"],
					},
				}),
		],
		[
			"tedi always ask",
			() =>
				mocks.policy.mockResolvedValue({
					autonomy: { version: 1, maxRisk: "medium" },
					requireExplicitApprovalPolicy: true,
				}),
		],
		["missing autonomy", () => mocks.policy.mockResolvedValue({})],
		[
			"failed or active latest Attempt",
			() =>
				mocks.attempts.mockResolvedValue({
					data: [{ runtimeState: "failed", outcome: "failed", summary: sha }],
				}),
		],
		[
			"unproven SHA",
			() =>
				mocks.attempts.mockResolvedValue({
					data: [
						{
							runtimeState: "finished",
							outcome: "succeeded",
							finishedAt: "2026-10-20",
							summary: "Partial work",
						},
					],
				}),
		],
	] as const)
		it(`denies ${label} without mutation`, async () => {
			alter();
			await expect(closeoutDelegatedWork(context, input)).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
			expect(mocks.complete).not.toHaveBeenCalled();
		});
	for (const invalid of [
		{ expiresAt: "2020-01-01T00:00:00Z" },
		{ executorId: "another-tedi" },
		{ runId: "another-run" },
		{ runtimeState: "finished" },
	])
		it(`rejects a linked Attempt fence mismatch: ${JSON.stringify(invalid)}`, async () => {
			mocks.attempts
				.mockResolvedValueOnce({
					data: [
						{
							id: "settled",
							runtimeState: "finished",
							outcome: "succeeded",
							finishedAt: "2026-10-20",
							summary: sha,
						},
					],
				})
				.mockResolvedValueOnce({
					data: [
						{
							executorType: "tedi",
							executorId: "tedi",
							runId: "child",
							runtimeState: "running",
							expiresAt: "2099-01-01T00:00:00Z",
							...invalid,
						},
					],
				});
			await expect(closeoutDelegatedWork(context, input)).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
			expect(mocks.complete).not.toHaveBeenCalled();
		});
	it("rejects MCP transport and self-closeout", async () => {
		await expect(
			closeoutDelegatedWork(
				{
					...context,
					serviceBindingAuthorization: { source: "mcp-tool", toolId: "fake" },
				},
				input,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			closeoutDelegatedWork(context, { ...input, id: "linked" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.complete).not.toHaveBeenCalled();
	});
});
