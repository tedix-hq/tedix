import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	decide: vi.fn(),
	getReview: vi.fn(),
	getTarget: vi.fn(),
	requireOwner: vi.fn(),
	requireTedi: vi.fn(),
}));

vi.mock("../../../services/artifact-release-review", () => {
	class ArtifactReleaseReviewError extends Error {
		constructor(
			readonly reason: "forbidden" | "not_found" | "conflict" | "unavailable",
			message: string,
		) {
			super(message);
		}
	}
	return {
		ArtifactReleaseReviewError,
		createRedactedArtifactRevision: mocks.create,
		decideArtifactRelease: mocks.decide,
		getArtifactReleaseReview: mocks.getReview,
		getArtifactReleaseTarget: mocks.getTarget,
		requireCanonicalHumanOwner: mocks.requireOwner,
	};
});

vi.mock("./events-policy", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./events-policy")>();
	return { ...actual, requireTediAccess: mocks.requireTedi };
});

import {
	approveArtifactReleaseRoute,
	createRedactedArtifactRevisionRoute,
	getArtifactReleaseReviewRoute,
	revokeArtifactReleaseRoute,
} from "./artifact-releases";
import { ArtifactReleaseReviewError } from "../../../services/artifact-release-review";

const digest = "a".repeat(64);
const review = {
	candidateId: "candidate-1",
	parentArtifactId: "parent-1",
	parentContentDigest: digest,
	childArtifactId: "child-1",
	childContentDigest: digest,
	sourceStatus: "unknown_history" as const,
	sourceNotice: "Observed prefix only.",
	reviewability: "reviewable" as const,
	reviewHeadId: "candidate-1",
	activeApprovalId: null,
	recordedApprovalId: null,
	releaseActive: false,
	createdAt: "2026-09-23T10:00:00.000Z",
	parentPreview: {
		artifactId: "parent-1",
		digest,
		text: "private",
		mimeType: "text/plain; charset=utf-8" as const,
	},
	candidatePreview: {
		artifactId: "child-1",
		digest,
		text: "redacted",
		mimeType: "text/plain; charset=utf-8" as const,
	},
};

const router = {
	create: createRedactedArtifactRevisionRoute,
	get: getArtifactReleaseReviewRoute,
	approve: approveArtifactReleaseRoute,
	revoke: revokeArtifactReleaseRoute,
};

function context(
	overrides: Partial<BaseContext> = {},
	permissions = ["tedis:read", "tedis:update"],
): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		userId: "user-1",
		descopeUserId: "descope-1",
		url: new URL("https://api.tedix.test/rpc/cognitive-runtime"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "descope-1",
			su: true,
		},
		...overrides,
	} as BaseContext;
}

function client(ctx: BaseContext) {
	return createRouterClient(router, { context: ctx });
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.requireTedi.mockImplementation(async (_context, tediId) => {
		if (tediId !== "tedi-1")
			throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
		return { id: tediId, organizationId: "org-1" };
	});
	mocks.requireOwner.mockImplementation(async (ctx: BaseContext) => {
		if (ctx.authType !== "user" || !ctx.user)
			throw new ArtifactReleaseReviewError("forbidden", "owner required");
		return { organizationId: "org-1", member: { id: "member-1" } };
	});
	mocks.getReview.mockResolvedValue(review);
	mocks.getTarget.mockResolvedValue({ review, sourcePreview: null });
	mocks.create.mockResolvedValue(review);
	mocks.decide.mockResolvedValue({
		review,
		decision: {
			reviewId: "decision-1",
			eventType: "approved",
			candidateId: review.candidateId,
			childContentDigest: digest,
		},
	});
});

describe("artifact release routes", () => {
	it.each([
		[
			"tedi",
			{
				authType: "tedi",
				user: undefined,
				tediId: "tedi-1",
				tediScopes: ["tedis:read", "tedis:write"],
				serviceAccount: { clientId: "authenticated-tedi-fixture" },
			},
			"FORBIDDEN",
		],
		[
			"external agent",
			{
				authType: "service-binding",
				user: undefined,
				externalAgentPrincipalId: "agent-1",
				tediScopes: ["tedis:read", "tedis:write"],
				serviceAccount: { clientId: "authenticated-external-agent-fixture" },
			},
			"FORBIDDEN",
		],
		[
			"API key",
			{
				authType: "apikey",
				user: undefined,
				apiKey: {
					id: "key-1",
					organizationId: "org-1",
					scopes: ["tedis:read", "tedis:write"],
				},
			},
			"FORBIDDEN",
		],
		[
			"service",
			{
				authType: "service-binding",
				user: undefined,
				tediScopes: ["tedis:read", "tedis:write"],
				serviceAccount: { clientId: "service-1" },
			},
			"FORBIDDEN",
		],
	] as const)(
		"rejects %s callers before release service access",
		async (_label, overrides, code) => {
			await expect(
				client(context(overrides as Partial<BaseContext>)).get({
					tediId: "tedi-1",
					candidateId: "candidate-1",
				}),
			).rejects.toMatchObject({ code });
			expect(mocks.getReview).not.toHaveBeenCalled();
		},
	);

	it("requires canonical owner authority after exact tedi access", async () => {
		mocks.requireOwner.mockRejectedValueOnce(
			new ArtifactReleaseReviewError("forbidden", "owner required"),
		);
		await expect(
			client(context()).get({ tediId: "tedi-1", candidateId: "candidate-1" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.requireTedi).toHaveBeenCalledWith(expect.anything(), "tedi-1");
	});

	it("binds candidate reads to the preflighted tedi and organization", async () => {
		await expect(
			client(context()).get({
				tediId: "other-tedi",
				candidateId: "candidate-1",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.getReview).not.toHaveBeenCalled();

		await client(context()).get({
			tediId: "tedi-1",
			candidateId: "candidate-1",
		});
		expect(mocks.getReview).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-1",
			tediId: "tedi-1",
			candidateId: "candidate-1",
		});

		await client(context()).get({
			tediId: "tedi-1",
			sourceArtifactId: "parent-1",
		});
		expect(mocks.getTarget).toHaveBeenCalledWith(expect.anything(), {
			organizationId: "org-1",
			tediId: "tedi-1",
			artifactId: "parent-1",
		});
	});

	it("requires fresh step-up for approval and revocation", async () => {
		const unstepped = context({ user: { ...context().user!, su: false } });
		await expect(
			client(unstepped).approve({
				tediId: "tedi-1",
				candidateId: "candidate-1",
				expectedReviewHeadId: "candidate-1",
				childContentDigest: digest,
				acknowledgeIncompleteSourceHistory: true,
				attestation: "reviewed exact bytes",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client(unstepped).revoke({
				tediId: "tedi-1",
				candidateId: "candidate-1",
				expectedApprovalId: "approval-1",
				childContentDigest: digest,
				reason: "withdraw",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.decide).not.toHaveBeenCalled();
	});

	it("forwards exact approval and revocation decisions after step-up", async () => {
		await client(context()).approve({
			tediId: "tedi-1",
			candidateId: "candidate-1",
			expectedReviewHeadId: "candidate-1",
			childContentDigest: digest,
			acknowledgeIncompleteSourceHistory: true,
			attestation: "reviewed exact bytes",
		});
		expect(mocks.decide).toHaveBeenLastCalledWith(expect.anything(), {
			candidateId: "candidate-1",
			tediId: "tedi-1",
			expectedReviewHeadId: "candidate-1",
			childContentDigest: digest,
			eventType: "approved",
			attestation: "reviewed exact bytes",
		});

		mocks.decide.mockResolvedValueOnce({
			review: null,
			decision: {
				reviewId: "revocation-1",
				eventType: "revoked",
				candidateId: "candidate-1",
				childContentDigest: digest,
			},
		});
		await client(context()).revoke({
			tediId: "tedi-1",
			candidateId: "candidate-1",
			expectedApprovalId: "approval-1",
			childContentDigest: digest,
			reason: "withdraw during outage",
		});
		expect(mocks.decide).toHaveBeenLastCalledWith(expect.anything(), {
			candidateId: "candidate-1",
			tediId: "tedi-1",
			expectedReviewHeadId: "approval-1",
			childContentDigest: digest,
			eventType: "revoked",
			attestation: "withdraw during outage",
		});
	});

	it("maps preview unavailability to SERVICE_UNAVAILABLE", async () => {
		mocks.getReview.mockRejectedValueOnce(
			new ArtifactReleaseReviewError("unavailable", "preview unavailable"),
		);
		await expect(
			client(context()).get({ tediId: "tedi-1", candidateId: "candidate-1" }),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
	});

	it("enforces literal acknowledgement and bounded nonblank attestations", async () => {
		await expect(
			client(context()).approve({
				tediId: "tedi-1",
				candidateId: "candidate-1",
				expectedReviewHeadId: "candidate-1",
				childContentDigest: digest,
				acknowledgeIncompleteSourceHistory: false as true,
				attestation: " ",
			}),
		).rejects.toBeDefined();
		expect(mocks.decide).not.toHaveBeenCalled();
	});
});
