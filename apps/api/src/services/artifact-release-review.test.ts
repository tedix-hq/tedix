import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import {
	ArtifactReleaseReviewError,
	createRedactedArtifactRevision,
	decideArtifactRelease,
	getArtifactReleaseReview,
	getArtifactReleaseSourcePreview,
	requireCanonicalHumanOwner,
} from "./artifact-release-review";

const mocks = vi.hoisted(() => ({
	appendReview: vi.fn(),
	authorizeSources: vi.fn(),
	createCandidate: vi.fn(),
	getCandidate: vi.fn(),
	getActiveApproval: vi.fn(),
	getConversation: vi.fn(),
	getEvent: vi.fn(),
	getHead: vi.fn(),
	getMember: vi.fn(),
	getReceipt: vi.fn(),
	getTediArtifact: vi.fn(),
	isConversationDeleted: vi.fn(),
	parseEnvelope: vi.fn(),
	publishArtifact: vi.fn(),
	readArtifact: vi.fn(),
	resolveConversationAccess: vi.fn(),
	sha256Hex: vi.fn(),
}));

vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.getMember,
}));
vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	getTediArtifact: mocks.getTediArtifact,
	getTediRuntimeEventById: mocks.getEvent,
	isTediConversationDeleted: mocks.isConversationDeleted,
}));
vi.mock("@tedix/db/queries/kernel-conversations", () => ({
	getKernelConversation: mocks.getConversation,
}));
vi.mock("@tedix/db/queries/artifact-policy/releases", () => ({
	appendArtifactReleaseReview: mocks.appendReview,
	createArtifactRedactionCandidate: mocks.createCandidate,
	getArtifactContributionReceiptForRelease: mocks.getReceipt,
	getArtifactRedactionCandidate: mocks.getCandidate,
	getArtifactReleaseReviewHead: mocks.getHead,
	getActiveArtifactReleaseApproval: mocks.getActiveApproval,
}));
vi.mock("../kernel/conversation-access", () => ({
	resolveKernelConversationAccess: mocks.resolveConversationAccess,
}));
vi.mock("./os-derived-resource-access", () => ({
	authorizeDerivedOutputSources: mocks.authorizeSources,
	parseDerivedAccessEnvelope: mocks.parseEnvelope,
}));
vi.mock("./artifact-immutable-publication", () => ({
	publishImmutablePrivateTextArtifact: mocks.publishArtifact,
	readVerifiedPrivateTextArtifact: mocks.readArtifact,
}));
vi.mock("@tedix/worker-kit/crypto", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/worker-kit/crypto")>()),
	sha256Hex: mocks.sha256Hex,
}));

const parent = {
	id: "parent-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	conversationId: "conversation-1",
	runId: "run-1",
	messageId: null,
	kind: "file" as const,
	name: "original.txt",
	mimeType: "text/plain; charset=utf-8",
	uri: "r2://tedix-tedi-production/private/original",
	sizeBytes: 8,
	metadata: null,
	accessClassification: "runtime_private" as const,
	contentDigest: "a".repeat(64),
	producerExecutionId: null,
	accessEnvelope: null,
	publicationState: "ready" as const,
	createdAt: "2026-09-23T10:00:00.000Z",
};
const child = {
	...parent,
	id: "child-1",
	name: "redacted.txt",
	contentDigest: "b".repeat(64),
};
const candidate = {
	id: "candidate-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	parentArtifactId: parent.id,
	parentContentDigest: parent.contentDigest,
	childArtifactId: child.id,
	childContentDigest: child.contentDigest,
	idempotencyKey: "key-1",
	createdByMemberId: "member-1",
	createdByUserId: "user-1",
	createdAt: "2026-09-23T10:00:00.000Z",
};
const member = {
	id: "member-1",
	organizationId: "org-1",
	userId: "user-1",
	descopeUserId: "descope-1",
	role: "owner",
	status: "active",
};
const emptyReceipt = {
	id: "receipt-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	artifactId: parent.id,
	producerRuntimeEventId: "event-1",
	conversationId: parent.conversationId,
	runId: parent.runId,
	contentDigest: parent.contentDigest,
	observationDigest: "empty-digest",
	observations: [],
	completeness: "observed_prefix",
	createdAt: parent.createdAt,
};
const contributionPayload = {
	artifactContributionReceipt: {
		version: 1,
		artifactIds: [parent.id],
		completeness: "observed_prefix",
		observations: [],
	},
};

function context(overrides: Partial<BaseContext> = {}): BaseContext {
	return {
		authType: "user",
		organizationId: "org-1",
		userId: "user-1",
		user: { sub: "descope-1" },
		db: {} as BaseContext["db"],
		env: { TEDI_R2_BUCKET: {} } as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.tedix.test"),
		...overrides,
	} as BaseContext;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getMember.mockResolvedValue(member);
	mocks.getConversation.mockResolvedValue({ id: parent.conversationId });
	mocks.isConversationDeleted.mockResolvedValue(false);
	mocks.resolveConversationAccess.mockResolvedValue({ allowed: true });
	mocks.getReceipt.mockResolvedValue(emptyReceipt);
	mocks.sha256Hex.mockImplementation(async (bytes: Uint8Array) => {
		const text = new TextDecoder().decode(bytes);
		if (text === "[]") return "empty-digest";
		let value = 0;
		for (const character of text)
			value = (value * 31 + character.charCodeAt(0)) >>> 0;
		return value.toString(16).padStart(64, "0");
	});
	mocks.getEvent.mockResolvedValue({
		id: "event-1",
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: parent.conversationId,
		runId: parent.runId,
		kind: "tool.completed",
		payload: contributionPayload,
	});
	mocks.readArtifact.mockImplementation(async (_bucket, artifact) => ({
		bytes: new TextEncoder().encode(artifact.id),
		text: artifact.id,
	}));
	mocks.getTediArtifact.mockImplementation(async (_db, input) =>
		input.artifactId === parent.id
			? parent
			: input.artifactId === child.id
				? child
				: null,
	);
	mocks.getCandidate.mockResolvedValue(candidate);
	mocks.getHead.mockResolvedValue(null);
	mocks.getActiveApproval.mockResolvedValue(null);
	mocks.publishArtifact.mockResolvedValue(child);
	mocks.createCandidate.mockResolvedValue({ candidate, created: true });
	mocks.appendReview.mockResolvedValue({ created: true });
});

describe("artifact release review service", () => {
	it.each([
		["api key", { authType: "apikey", apiKey: { id: "key" } }],
		["service", { authType: "service-binding", serviceAccount: { id: "svc" } }],
		["tedi", { tediId: "tedi-1" }],
		["missing authenticated subject", { user: {} }],
		["mismatched canonical user", { userId: "other-user" }],
		["inactive owner", {}, { ...member, status: "deactivated" }],
		["non-owner", {}, { ...member, role: "admin" }],
	] as const)("rejects %s authority", async (_label, overrides, membership) => {
		if (membership) mocks.getMember.mockResolvedValueOnce(membership);
		await expect(
			requireCanonicalHumanOwner(context(overrides as Partial<BaseContext>)),
		).rejects.toBeInstanceOf(ArtifactReleaseReviewError);
	});

	it("uses the authenticated human subject without a tedi-only context field", async () => {
		await expect(requireCanonicalHumanOwner(context())).resolves.toMatchObject({
			organizationId: "org-1",
			member,
		});
		expect(mocks.getMember).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"descope-1",
		);
	});

	it("previews a valid empty observed prefix as explicit unknown history", async () => {
		const result = await getArtifactReleaseSourcePreview(context(), {
			tediId: "tedi-1",
			sourceArtifactId: parent.id,
		});
		expect(result).toMatchObject({
			parentArtifactId: parent.id,
			parentContentDigest: parent.contentDigest,
			sourceStatus: "unknown_history",
			parentPreview: { text: parent.id },
		});
	});

	it.each([
		["missing", null],
		["unavailable", { ...emptyReceipt, completeness: "unavailable" }],
		["wrong run", { ...emptyReceipt, runId: "other-run" }],
		["malformed", { ...emptyReceipt, observations: [{}] }],
	] as const)("denies %s contribution evidence", async (_label, receipt) => {
		mocks.getReceipt.mockResolvedValueOnce(receipt);
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "unavailable" });
	});

	it("denies a contribution whose canonical producer event does not match", async () => {
		mocks.getEvent.mockResolvedValueOnce({
			...(await mocks.getEvent()),
			runId: "foreign-run",
		});
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "unavailable" });
	});

	it.each([
		["unknown completeness", { ...emptyReceipt, completeness: "complete" }],
		["null observations", { ...emptyReceipt, observations: null }],
	] as const)("fails closed for stored %s", async (_label, receipt) => {
		mocks.getReceipt.mockResolvedValueOnce(receipt);
		mocks.getEvent.mockResolvedValueOnce({
			id: "event-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			conversationId: parent.conversationId,
			runId: parent.runId,
			kind: "tool.completed",
			payload: {
				artifactContributionReceipt: {
					version: 1,
					artifactIds: [parent.id],
					completeness: receipt.completeness,
					observations: receipt.observations,
				},
			},
		});
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "unavailable" });
		expect(mocks.readArtifact).not.toHaveBeenCalled();
	});

	it("rechecks governed Gadget access and denies known Docs claims", async () => {
		const governed = {
			...parent,
			producerExecutionId: "execution-1",
			accessEnvelope: { version: 1, sources: [] },
		};
		mocks.getTediArtifact.mockResolvedValue(governed);
		mocks.parseEnvelope.mockReturnValue({ version: 1, sources: [] });
		mocks.authorizeSources.mockResolvedValue(false);
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "unavailable" });
		expect(mocks.authorizeSources).toHaveBeenCalledOnce();

		mocks.authorizeSources.mockResolvedValue(true);
		mocks.getReceipt.mockResolvedValue({
			...emptyReceipt,
			observations: [{ innerCallId: "docs", receipt: {} }],
		});
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "unavailable" });
	});

	it("denies deleted or denied conversations and accepts canonical Think evidence", async () => {
		mocks.getConversation.mockResolvedValueOnce({ id: parent.conversationId });
		mocks.resolveConversationAccess.mockResolvedValueOnce({ allowed: false });
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "forbidden" });

		mocks.getConversation.mockResolvedValueOnce(null);
		mocks.isConversationDeleted.mockResolvedValueOnce(true);
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).rejects.toMatchObject({ reason: "forbidden" });

		mocks.getConversation.mockResolvedValueOnce(null);
		mocks.isConversationDeleted.mockResolvedValueOnce(false);
		mocks.getReceipt.mockResolvedValue(emptyReceipt);
		mocks.getEvent.mockResolvedValue({
			id: "event-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			conversationId: parent.conversationId,
			runId: parent.runId,
			kind: "tool.completed",
			payload: contributionPayload,
		});
		await expect(
			getArtifactReleaseSourcePreview(context(), {
				tediId: "tedi-1",
				sourceArtifactId: parent.id,
			}),
		).resolves.toMatchObject({ sourceStatus: "unknown_history" });
	});

	it("pins the expected parent digest before creating a child", async () => {
		await expect(
			createRedactedArtifactRevision(context(), {
				tediId: "tedi-1",
				parentArtifactId: parent.id,
				expectedParentDigest: "c".repeat(64),
				content: "redacted",
				idempotencyKey: "key-1",
			}),
		).rejects.toMatchObject({ reason: "conflict" });
		expect(mocks.publishArtifact).not.toHaveBeenCalled();
	});

	it("approves with head CAS, retries exactly, and revokes without source or R2", async () => {
		const approved = await decideArtifactRelease(context(), {
			candidateId: candidate.id,
			tediId: "tedi-1",
			expectedReviewHeadId: candidate.id,
			childContentDigest: child.contentDigest,
			eventType: "approved",
			attestation: "reviewed exact redaction",
		});
		expect(approved.decision.eventType).toBe("approved");
		expect(mocks.appendReview).toHaveBeenCalledOnce();

		const approvalRow = mocks.appendReview.mock.calls[0]![1];
		mocks.getHead.mockResolvedValueOnce({ ...approvalRow });
		const approvalReplay = await decideArtifactRelease(context(), {
			candidateId: candidate.id,
			tediId: "tedi-1",
			expectedReviewHeadId: candidate.id,
			childContentDigest: child.contentDigest,
			eventType: "approved",
			attestation: "reviewed exact redaction",
		});
		expect(approvalReplay.decision.reviewId).toBe(approvalRow.id);
		expect(mocks.appendReview).toHaveBeenCalledOnce();

		mocks.readArtifact.mockRejectedValue(new Error("R2 unavailable"));
		mocks.authorizeSources.mockRejectedValue(new Error("source unavailable"));
		mocks.getHead.mockResolvedValueOnce({ ...approvalRow });
		await decideArtifactRelease(context(), {
			candidateId: candidate.id,
			tediId: "tedi-1",
			expectedReviewHeadId: approvalRow.id,
			childContentDigest: child.contentDigest,
			eventType: "revoked",
			attestation: "withdraw release",
		});
		expect(mocks.appendReview).toHaveBeenCalledTimes(2);

		const revokeCall = mocks.appendReview.mock.calls[1]![1];
		mocks.getHead.mockResolvedValueOnce({ ...revokeCall });
		const replay = await decideArtifactRelease(context(), {
			candidateId: candidate.id,
			tediId: "tedi-1",
			expectedReviewHeadId: revokeCall.previousReviewId,
			childContentDigest: child.contentDigest,
			eventType: "revoked",
			attestation: "withdraw release",
		});
		expect(replay.decision.reviewId).toBe(revokeCall.id);
	});

	it("keeps exact revocation controls visible when private previews are unavailable", async () => {
		const approval = {
			id: "approval-1",
			organizationId: "org-1",
			tediId: "tedi-1",
			candidateId: candidate.id,
			eventType: "approved" as const,
			previousReviewId: candidate.id,
			targetApprovalId: null,
			childContentDigest: child.contentDigest,
			reviewerMemberId: member.id,
			reviewerUserId: member.userId,
			reviewerDescopeUserId: member.descopeUserId,
			attestation: "reviewed exact redaction",
			createdAt: "2026-09-23T10:01:00.000Z",
		};
		mocks.getHead.mockResolvedValue(approval);
		mocks.getActiveApproval.mockResolvedValue({ approval });
		mocks.authorizeSources.mockRejectedValue(new Error("source unavailable"));
		mocks.readArtifact.mockRejectedValue(new Error("R2 unavailable"));

		const review = await getArtifactReleaseReview(context(), {
			organizationId: "org-1",
			tediId: "tedi-1",
			candidateId: candidate.id,
		});

		expect(review).toMatchObject({
			candidateId: candidate.id,
			childContentDigest: child.contentDigest,
			reviewability: "unavailable",
			reviewHeadId: approval.id,
			activeApprovalId: approval.id,
			parentPreview: null,
			candidatePreview: null,
		});

		await expect(
			decideArtifactRelease(context(), {
				candidateId: candidate.id,
				tediId: "tedi-1",
				expectedReviewHeadId: approval.id,
				childContentDigest: child.contentDigest,
				eventType: "approved",
				attestation: "approve while unavailable",
			}),
		).rejects.toMatchObject({ reason: "unavailable" });

		await expect(
			decideArtifactRelease(context(), {
				candidateId: candidate.id,
				tediId: "tedi-1",
				expectedReviewHeadId: approval.id,
				childContentDigest: child.contentDigest,
				eventType: "revoked",
				attestation: "withdraw during outage",
			}),
		).resolves.toMatchObject({
			review: null,
			decision: { eventType: "revoked", candidateId: candidate.id },
		});
	});
});
