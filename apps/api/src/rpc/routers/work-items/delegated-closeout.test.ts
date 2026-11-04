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
	coordinator: vi.fn(),
	submissions: vi.fn(),
	comment: vi.fn(),
	pack: vi.fn(),
	manifest: vi.fn(),
	delivery: vi.fn(),
	observations: vi.fn(),
	lessons: vi.fn(),
	linkedPolicy: vi.fn(),
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
	getAuthoritativeWorkItemAttempt: mocks.coordinator,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.item,
	completeWorkItem: mocks.complete,
}));
vi.mock("@tedix/db/queries/runtime-submissions/read-models", () => ({
	listSubmissionsByRun: mocks.submissions,
}));
vi.mock("@tedix/db/queries/work-items/comments", () => ({
	getWorkItemCommentById: mocks.comment,
}));
vi.mock("@tedix/db/queries/kernel-runtime-support", () => ({
	getActiveOrganizationPolicyPack: mocks.pack,
}));
vi.mock("@tedix/db/queries/repository-observer", () => ({
	findRepositoryPushObservations: mocks.observations,
}));
vi.mock("../../../kernel/request-target-readers", () => ({
	readConfiguredRepositoryDelivery: mocks.delivery,
}));
vi.mock("@tedix/ssrf-guard", () => ({ guardedFetch: mocks.manifest }));
vi.mock("@tedix/db/queries/work-items/delegation-autonomy", () => ({
	readDelegationAutonomyLessons: mocks.lessons,
}));
vi.mock("@tedix/db/queries/control-plane/definitions", () => ({
	getPolicyPackById: mocks.linkedPolicy,
}));
import {
	closeoutDelegatedWork,
	assertNativeStewardCloseout,
	prepareNativeStewardCloseout,
} from "./delegated-closeout";

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

const nativeTargetId = "22222222-2222-4222-8222-222222222222";
const nativeLinkedId = "33333333-3333-4333-8333-333333333333";
const nativeProof = {
	homeRunId: "native-home",
	runId: "native-child",
	linkedWorkItemId: nativeLinkedId,
	expectedWorkItemVersion: 7,
};
const nativeInput = { id: nativeTargetId, nativeStewardCloseout: nativeProof };
const nativeTargets = [
	{
		id: nativeTargetId,
		expectedWorkItemVersion: 7,
		repositoryTargetId: "configured-os",
	},
];
const liveSha = "b".repeat(40);
function nativeFixture() {
	const nativeItem = {
		...item,
		id: nativeTargetId,
		createdAt: "2026-11-01T12:00:00.000Z",
		riskLevel: "high",
		stewardType: "tedi",
		stewardId: "tedi",
	};
	const nativeHome = home();
	nativeHome.childRunId = nativeProof.runId;
	nativeHome.metadata.workItemId = nativeLinkedId;
	Object.assign(nativeHome.metadata.redriveInput, {
		runtimeMetadata: { stewardCloseoutTargets: nativeTargets },
	});
	Object.assign(nativeHome.metadata.homeDelegation.workOrder, {
		capabilityPlan: {
			version: "delegation-capabilities.v1",
			requiredCapabilities: ["work.steward_closeout"],
			allowedToolIds: ["read_steward_work", "complete_steward_work"],
			missingCapabilities: [],
			urls: [],
			outputIds: [],
			stewardCloseoutTargets: nativeTargets,
		},
	});
	const latest = {
		id: "source-attempt",
		workItemId: nativeTargetId,
		runtimeState: "finished",
		outcome: "succeeded",
		finishedAt: "2026-11-04T20:00:00.000Z",
		startedAt: "2026-11-04T19:00:00.000Z",
		metadata: { settlement: { commitSha: sha } },
	};
	const coordinator = {
		id: "coordinator-attempt",
		admissionId: "admission",
		executorType: "tedi",
		executorId: "tedi",
		runId: nativeProof.runId,
	};
	mocks.home.mockResolvedValue(nativeHome);
	mocks.item.mockImplementation(async (_db, id) =>
		id === nativeLinkedId
			? { ...nativeItem, id: nativeLinkedId, disposition: "accepted" }
			: nativeItem,
	);
	mocks.attempts.mockImplementation(async (_db, p) => ({
		data: [p.workItemId === nativeLinkedId ? coordinator : latest],
	}));
	mocks.coordinator.mockResolvedValue(coordinator);
	mocks.submissions.mockResolvedValue([]);
	mocks.comment.mockResolvedValue(null);
	mocks.lessons.mockResolvedValue([]);
	mocks.linkedPolicy.mockResolvedValue(null);
	mocks.member.mockResolvedValue({
		status: "active",
		role: "owner",
		userId: "owner",
		descopeUserId: "subject",
	});
	mocks.policy.mockResolvedValue({
		autonomy: { version: 1, maxRisk: "medium", askForClasses: [] },
		requireExplicitApprovalPolicy: false,
	});
	mocks.pack.mockResolvedValue({
		id: "policy-pack",
		definition: {
			kernelRequestCoordinator: {
				version: 1,
				enabled: true,
				nextOwner: "steward",
				retryMs: 1000,
				probeTimeoutMs: 1000,
				maxProbeAttempts: 1,
				runBudgetMs: 1000,
				workAttemptDelivery: {
					observerProjectId: project,
					verifyWindowMs: 60000,
				},
				repositoryTargets: [
					{
						id: "configured-os",
						repository: "fictional/platform",
						shipRepository: "fictional/ops",
						workflowId: "ship.yml",
						surface: "os",
						liveManifestUrl: "https://fixture.invalid/manifest",
						maxAgeMs: 10000,
					},
				],
			},
		},
	});
	mocks.manifest.mockImplementation(
		async () =>
			new Response(
				JSON.stringify({
					repository: "fictional/platform",
					surface: "os",
					commitSha: liveSha,
				}),
			),
	);
	mocks.delivery.mockResolvedValue({
		liveSha,
		shipSha: liveSha,
		shipStatus: "success",
		surface: "os",
		evidenceRefs: ["managed-receipt"],
		mainSha: "c".repeat(40),
		sourceAncestry: {
			sourceCommit: sha,
			liveCommitSha: liveSha,
			mainCommitSha: "c".repeat(40),
		},
	});
	mocks.observations.mockResolvedValue([
		{ id: "push", sha, beforeSha: "0".repeat(40), commitShas: [sha] },
	]);
	return { nativeItem, nativeHome, latest, coordinator };
}

describe("native steward metadata closeout", () => {
	it("verifies a high-risk target without changing its risk and binds source ancestry to actual OS delivery", async () => {
		const f = nativeFixture();
		const result = await prepareNativeStewardCloseout(context, nativeInput);
		expect(result.fence).toMatchObject({
			sourceAttemptId: f.latest.id,
			sourceCommit: sha,
			targetWorkItemVersion: 7,
			tediId: "tedi",
		});
		expect(result.item.riskLevel).toBe("high");
		expect(result.closingComment?.metadata).toMatchObject({
			sourceCommit: sha,
			liveCommitSha: liveSha,
			repositoryTargetId: "configured-os",
		});
		expect(mocks.delivery).toHaveBeenCalledWith(
			context,
			"org",
			expect.anything(),
			{
				kind: "repository_delivery",
				targetId: "configured-os",
				surface: "os",
				commitSha: liveSha,
				sourceCommit: sha,
			},
		);
		expect(mocks.complete).not.toHaveBeenCalled();
	});
	it("uses the typed top-level sourceCommit for a genuinely succeeded source Attempt", async () => {
		const f = nativeFixture();
		Reflect.deleteProperty(f.latest.metadata, "settlement");
		Object.assign(f.latest.metadata, { sourceCommit: sha });
		expect(
			(await prepareNativeStewardCloseout(context, nativeInput)).fence
				?.sourceCommit,
		).toBe(sha);
	});
	it.each([
		"steward",
		"version",
		"owner",
		"bound targets",
		"abort",
		"coordinator",
		"source failed",
		"source short",
		"policy asks",
		"explicit approval",
		"manifest surface",
		"delivery changed",
		"ancestry unknown",
	])("refuses %s without completing Work", async (kind) => {
		const f = nativeFixture();
		if (kind === "steward") f.nativeItem.stewardId = "other";
		if (kind === "version") f.nativeItem.version = 8;
		if (kind === "owner")
			mocks.member.mockResolvedValue({ status: "inactive", role: "owner" });
		if (kind === "bound targets")
			Object.assign(f.nativeHome.metadata.redriveInput, {
				runtimeMetadata: {
					stewardCloseoutTargets: [
						{ ...nativeTargets[0], expectedWorkItemVersion: 8 },
					],
				},
			});
		if (kind === "abort")
			mocks.submissions.mockResolvedValue([
				{ abortRequestedAt: "2026-11-04T20:00:00Z" },
			]);
		if (kind === "coordinator")
			mocks.coordinator.mockRejectedValue(new Error("expired"));
		if (kind === "source failed") f.latest.outcome = "failed";
		if (kind === "source short") f.latest.metadata.settlement.commitSha = "abc";
		if (kind === "policy asks")
			mocks.policy.mockResolvedValue({
				autonomy: {
					version: 1,
					maxRisk: "medium",
					askForClasses: ["native:complete_steward_work"],
				},
				requireExplicitApprovalPolicy: false,
			});
		if (kind === "explicit approval")
			mocks.policy.mockResolvedValue({
				autonomy: { version: 1, maxRisk: "medium" },
				requireExplicitApprovalPolicy: true,
			});
		if (kind === "manifest surface")
			mocks.manifest.mockResolvedValue(
				new Response(
					JSON.stringify({
						repository: "fictional/platform",
						surface: "api",
						commitSha: liveSha,
					}),
				),
			);
		if (kind === "delivery changed")
			mocks.delivery.mockResolvedValue({
				liveSha: sha,
				shipSha: liveSha,
				shipStatus: "success",
				surface: "os",
				evidenceRefs: [],
			});
		if (kind === "ancestry unknown") mocks.observations.mockResolvedValue([]);
		await expect(
			prepareNativeStewardCloseout(context, nativeInput),
		).rejects.toBeTruthy();
		expect(mocks.complete).not.toHaveBeenCalled();
	});
	it("rechecks current Home and target scope after provider verification", async () => {
		const f = nativeFixture();
		mocks.delivery.mockImplementation(async () => {
			f.nativeHome.status = "canceled";
			return {
				liveSha,
				shipSha: liveSha,
				shipStatus: "success",
				surface: "os",
				evidenceRefs: [],
				mainSha: "c".repeat(40),
				sourceAncestry: {
					sourceCommit: sha,
					liveCommitSha: liveSha,
					mainCommitSha: "c".repeat(40),
				},
			};
		});
		await expect(
			prepareNativeStewardCloseout(context, nativeInput),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects MCP and self-target authority before reading private context", async () => {
		nativeFixture();
		await expect(
			assertNativeStewardCloseout(
				{ ...context, authType: "apikey" },
				nativeInput,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			assertNativeStewardCloseout(context, {
				...nativeInput,
				id: nativeLinkedId,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.home).not.toHaveBeenCalled();
	});
	it("reads back only the same completion receipt at exactly expected version plus one", async () => {
		const f = nativeFixture();
		f.nativeItem.disposition = "completed";
		f.nativeItem.version = 8;
		const commentId = `${nativeProof.homeRunId}:steward-closeout:${nativeTargetId}:v7`;
		Object.assign(f.nativeItem, {
			metadata: { completionCommentId: commentId },
		});
		const comment = {
			id: commentId,
			orgId: "org",
			workItemId: nativeTargetId,
			authorType: "tedi",
			authorId: "tedi",
			metadata: {
				source: "native-steward-closeout.v1",
				homeRunId: nativeProof.homeRunId,
				childRunId: nativeProof.runId,
				linkedWorkItemId: nativeLinkedId,
				targetWorkItemVersion: 7,
			},
		};
		mocks.comment.mockResolvedValue(comment);
		expect(
			(await assertNativeStewardCloseout(context, nativeInput)).completed,
		).toBe(true);
		comment.metadata.childRunId = "foreign";
		await expect(
			assertNativeStewardCloseout(context, nativeInput),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

it.each(["explicit ask", "platform autonomy off"])(
	"refuses %s introduced during provider verification",
	async (kind) => {
		nativeFixture();
		mocks.policy
			.mockResolvedValueOnce({
				autonomy: { version: 1, maxRisk: "medium", askForClasses: [] },
				requireExplicitApprovalPolicy: false,
			})
			.mockResolvedValueOnce(
				kind === "explicit ask"
					? {
							autonomy: {
								version: 1,
								maxRisk: "medium",
								askForClasses: ["native:complete_steward_work"],
							},
							requireExplicitApprovalPolicy: false,
						}
					: {
							autonomy: { version: 1, maxRisk: "medium" },
							platformAutonomy: false,
							requireExplicitApprovalPolicy: false,
						},
			);
		await expect(
			prepareNativeStewardCloseout(context, nativeInput),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.delivery).toHaveBeenCalledOnce();
		expect(mocks.policy).toHaveBeenCalledTimes(2);
		expect(mocks.complete).not.toHaveBeenCalled();
	},
);
it("refuses platform autonomy opt-out before provider reads", async () => {
	nativeFixture();
	mocks.policy.mockResolvedValue({
		autonomy: { version: 1, maxRisk: "medium" },
		platformAutonomy: false,
		requireExplicitApprovalPolicy: false,
	});
	await expect(
		prepareNativeStewardCloseout(context, nativeInput),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mocks.manifest).not.toHaveBeenCalled();
});

it("keeps an older source discoverable when its original Work has a fresh verification Attempt", async () => {
	nativeFixture();
	await prepareNativeStewardCloseout(context, nativeInput);
	expect(mocks.observations).toHaveBeenCalledWith(context.db, {
		orgId: "org",
		projectId: project,
		shas: [sha],
		since: "2026-10-31T12:00:00.000Z",
	});
});
