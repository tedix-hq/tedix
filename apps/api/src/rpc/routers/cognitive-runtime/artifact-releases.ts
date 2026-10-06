import { AUTHZ, ErrorCodes, createError } from "../../orpc";
import { requireStepUp } from "../../step-up";
import {
	ArtifactReleaseReviewError,
	createRedactedArtifactRevision,
	decideArtifactRelease,
	getArtifactReleaseReview,
	getArtifactReleaseTarget,
	requireCanonicalHumanOwner,
} from "../../../services/artifact-release-review";
import { authed, requireTediAccess } from "./events-policy";

function releaseError(error: unknown): never {
	if (!(error instanceof ArtifactReleaseReviewError)) throw error;
	const code =
		error.reason === "forbidden"
			? ErrorCodes.FORBIDDEN
			: error.reason === "not_found"
				? ErrorCodes.NOT_FOUND
				: error.reason === "conflict"
					? ErrorCodes.CONFLICT
					: ErrorCodes.SERVICE_UNAVAILABLE;
	throw createError(code, error.message);
}

async function preflight(
	context: Parameters<typeof requireCanonicalHumanOwner>[0],
	tediId: string,
) {
	await requireTediAccess(context, tediId);
	return requireCanonicalHumanOwner(context);
}

export const createRedactedArtifactRevisionRoute =
	authed.createRedactedArtifactRevision
		.use(AUTHZ.tedisWrite)
		.handler(async ({ context, input }) => {
			try {
				await preflight(context, input.tediId);
				return { review: await createRedactedArtifactRevision(context, input) };
			} catch (error) {
				releaseError(error);
			}
		});

export const getArtifactReleaseReviewRoute = authed.getArtifactReleaseReview
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		try {
			const owner = await preflight(context, input.tediId);
			if (input.candidateId)
				return {
					review: await getArtifactReleaseReview(context, {
						organizationId: owner.organizationId,
						tediId: input.tediId,
						candidateId: input.candidateId,
					}),
					sourcePreview: null,
				};
			return getArtifactReleaseTarget(context, {
				organizationId: owner.organizationId,
				tediId: input.tediId,
				artifactId: input.sourceArtifactId!,
			});
		} catch (error) {
			releaseError(error);
		}
	});

export const approveArtifactReleaseRoute = authed.approveArtifactRelease
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		try {
			await preflight(context, input.tediId);
			requireStepUp(context, "Approving a redacted artifact release");
			return decideArtifactRelease(context, {
				candidateId: input.candidateId,
				tediId: input.tediId,
				expectedReviewHeadId: input.expectedReviewHeadId,
				childContentDigest: input.childContentDigest,
				eventType: "approved",
				attestation: input.attestation,
			});
		} catch (error) {
			releaseError(error);
		}
	});

export const revokeArtifactReleaseRoute = authed.revokeArtifactRelease
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
		try {
			await preflight(context, input.tediId);
			requireStepUp(context, "Revoking a redacted artifact release");
			return decideArtifactRelease(context, {
				candidateId: input.candidateId,
				tediId: input.tediId,
				expectedReviewHeadId: input.expectedApprovalId,
				childContentDigest: input.childContentDigest,
				eventType: "revoked",
				attestation: input.reason,
			});
		} catch (error) {
			releaseError(error);
		}
	});
