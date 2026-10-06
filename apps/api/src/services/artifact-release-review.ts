import type { ArtifactReleaseReview } from "@tedix/api-contract/schemas/cognitive-runtime";
import { parseOwnedReadObservations } from "@tedix/mcp-shared/read-observation-receipt";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getTediArtifact,
	getTediRuntimeEventById,
	isTediConversationDeleted,
} from "@tedix/db/queries/cognitive-runtime";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import {
	appendArtifactReleaseReview,
	createArtifactRedactionCandidate,
	getArtifactContributionReceiptForRelease,
	getArtifactRedactionCandidate,
	getArtifactReleaseReviewHead,
	getActiveArtifactReleaseApproval,
} from "@tedix/db/queries/artifact-policy/releases";
import type { BaseContext } from "../rpc/orpc";
import { resolveKernelConversationAccess } from "../kernel/conversation-access";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "./os-derived-resource-access";
import {
	publishImmutablePrivateTextArtifact,
	readVerifiedPrivateTextArtifact,
} from "./artifact-immutable-publication";
import { sha256Hex } from "@tedix/worker-kit/crypto";

export class ArtifactReleaseReviewError extends Error {
	constructor(
		readonly reason: "forbidden" | "not_found" | "conflict" | "unavailable",
		message: string,
	) {
		super(message);
		this.name = "ArtifactReleaseReviewError";
	}
}

export async function requireCanonicalHumanOwner(context: BaseContext) {
	if (
		context.authType !== "user" ||
		!context.user ||
		!context.user.sub ||
		!context.userId ||
		context.tediId ||
		context.externalAgentPrincipalId ||
		context.serviceAccount ||
		context.apiKey
	)
		throw new ArtifactReleaseReviewError(
			"forbidden",
			"Artifact release review requires an interactive human owner",
		);
	const organizationId = context.organizationId;
	if (!organizationId)
		throw new ArtifactReleaseReviewError(
			"forbidden",
			"Organization context is required",
		);
	const member = await getMemberByUserId(
		context.db,
		organizationId,
		context.user.sub,
	);
	if (
		!member ||
		member.status !== "active" ||
		member.role !== "owner" ||
		!member.userId ||
		member.userId !== context.userId
	)
		throw new ArtifactReleaseReviewError(
			"forbidden",
			"Artifact release review requires the current active organization owner",
		);
	return { organizationId, member };
}

async function deterministicId(prefix: string, fields: string[]) {
	const digest = await sha256Hex(
		new TextEncoder().encode(JSON.stringify(fields)),
	);
	return `${prefix}:${digest}`;
}

async function requireArtifactConversationAccess(
	context: BaseContext,
	artifact: NonNullable<Awaited<ReturnType<typeof getTediArtifact>>>,
) {
	if (!artifact.conversationId)
		throw new ArtifactReleaseReviewError(
			"unavailable",
			"Artifact is not bound to an accessible conversation",
		);
	const home = await getKernelConversation(context.db, {
		organizationId: artifact.organizationId,
		conversationId: artifact.conversationId,
	});
	if (!home) {
		if (
			await isTediConversationDeleted(context.db, {
				organizationId: artifact.organizationId,
				tediId: artifact.tediId,
				conversationId: artifact.conversationId,
			})
		)
			throw new ArtifactReleaseReviewError(
				"forbidden",
				"Artifact conversation is deleted",
			);
		const receipt = await getArtifactContributionReceiptForRelease(context.db, {
			organizationId: artifact.organizationId,
			artifactId: artifact.id,
		});
		const event = receipt
			? await getTediRuntimeEventById(
					context.db,
					receipt.producerRuntimeEventId,
				)
			: null;
		if (
			!receipt ||
			!event ||
			event.organizationId !== artifact.organizationId ||
			event.tediId !== artifact.tediId ||
			event.conversationId !== artifact.conversationId ||
			event.runId !== artifact.runId ||
			!(event.kind === "tool.completed" || event.kind === "tool.failed")
		)
			throw new ArtifactReleaseReviewError(
				"unavailable",
				"Artifact conversation has no canonical runtime record",
			);
		return;
	}
	const decision = await resolveKernelConversationAccess(context.db, {
		conversationId: artifact.conversationId,
		organizationId: artifact.organizationId,
		descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
		required: "read",
	});
	if (!decision.allowed)
		throw new ArtifactReleaseReviewError(
			"forbidden",
			"Artifact conversation access is required",
		);
}

function canonicalContributionClaim(
	payload: unknown,
	artifactId: string,
	completeness: string,
	observations: unknown,
) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return false;
	const claim = (payload as Record<string, unknown>)
		.artifactContributionReceipt;
	if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
	const value = claim as Record<string, unknown>;
	return (
		value.version === 1 &&
		Array.isArray(value.artifactIds) &&
		value.artifactIds.includes(artifactId) &&
		value.completeness === completeness &&
		JSON.stringify(value.observations) === JSON.stringify(observations)
	);
}

async function sourceState(
	context: BaseContext,
	parent: NonNullable<Awaited<ReturnType<typeof getTediArtifact>>>,
) {
	if (parent.accessClassification !== "runtime_private")
		return {
			status: "unavailable" as const,
			notice: "Only runtime-private artifacts can enter this review.",
		};
	if (parent.accessEnvelope || parent.producerExecutionId) {
		const envelope = parseDerivedAccessEnvelope(parent.accessEnvelope);
		if (!envelope || !parent.producerExecutionId)
			return {
				status: "known_unverifiable" as const,
				notice: "The artifact has an incomplete governed-source binding.",
			};
		const allowed = await authorizeDerivedOutputSources(context, {
			organizationId: parent.organizationId,
			accessEnvelope: envelope,
		});
		if (!allowed)
			return {
				status: "unavailable" as const,
				notice: "A known governed source is not currently available.",
			};
	}
	const receipt = await getArtifactContributionReceiptForRelease(context.db, {
		organizationId: parent.organizationId,
		artifactId: parent.id,
	});
	if (!receipt)
		return {
			status: "known_unverifiable" as const,
			notice: "The artifact has no canonical runtime contribution receipt.",
		};
	if (
		receipt.tediId !== parent.tediId ||
		receipt.conversationId !== parent.conversationId ||
		receipt.runId !== parent.runId ||
		receipt.contentDigest !== parent.contentDigest
	)
		return {
			status: "known_unverifiable" as const,
			notice: "The contribution receipt does not match the immutable artifact.",
		};
	if (receipt.completeness === "unavailable")
		return {
			status: "unavailable" as const,
			notice: "The runtime marked contribution evidence unavailable.",
		};
	if (
		receipt.completeness !== "observed_prefix" ||
		!Array.isArray(receipt.observations)
	)
		return {
			status: "known_unverifiable" as const,
			notice: "Stored contribution evidence is malformed.",
		};
	const parsed = parseOwnedReadObservations(receipt.observations);
	if (parsed.length !== receipt.observations.length)
		return {
			status: "known_unverifiable" as const,
			notice: "Stored contribution evidence is malformed.",
		};
	if (
		(await sha256Hex(new TextEncoder().encode(JSON.stringify(parsed)))) !==
		receipt.observationDigest
	)
		return {
			status: "known_unverifiable" as const,
			notice: "Stored contribution evidence failed its digest check.",
		};
	const producer = await getTediRuntimeEventById(
		context.db,
		receipt.producerRuntimeEventId,
	);
	if (
		!producer ||
		producer.organizationId !== parent.organizationId ||
		producer.tediId !== parent.tediId ||
		producer.conversationId !== parent.conversationId ||
		producer.runId !== parent.runId ||
		!(producer.kind === "tool.completed" || producer.kind === "tool.failed") ||
		!canonicalContributionClaim(
			producer.payload,
			parent.id,
			receipt.completeness,
			parsed,
		)
	)
		return {
			status: "known_unverifiable" as const,
			notice:
				"Stored contribution evidence is not bound to its canonical runtime event.",
		};
	if (parsed.length > 0)
		return {
			status: "known_unverifiable" as const,
			notice:
				"Known Docs observations cannot yet be revalidated against an immutable site-source configuration.",
		};
	return {
		status: "unknown_history" as const,
		notice:
			"The observed prefix contains no read receipt, but it is not proof of source-free history.",
	};
}

async function buildReview(
	context: BaseContext,
	candidateId: string,
	expectedTediId?: string,
	allowUnavailable = false,
): Promise<ArtifactReleaseReview> {
	const owner = await requireCanonicalHumanOwner(context);
	const candidate = await getArtifactRedactionCandidate(context.db, {
		organizationId: owner.organizationId,
		candidateId,
	});
	if (!candidate)
		throw new ArtifactReleaseReviewError(
			"not_found",
			"Artifact release candidate not found",
		);
	if (expectedTediId && candidate.tediId !== expectedTediId)
		throw new ArtifactReleaseReviewError(
			"not_found",
			"Artifact release candidate not found",
		);
	const [parent, child] = await Promise.all([
		getTediArtifact(context.db, {
			organizationId: owner.organizationId,
			artifactId: candidate.parentArtifactId,
		}),
		getTediArtifact(context.db, {
			organizationId: owner.organizationId,
			artifactId: candidate.childArtifactId,
		}),
	]);
	if (
		!parent ||
		!child ||
		parent.contentDigest !== candidate.parentContentDigest ||
		child.contentDigest !== candidate.childContentDigest ||
		child.accessClassification !== "runtime_private"
	)
		throw new ArtifactReleaseReviewError(
			"conflict",
			"Artifact release candidate no longer matches its immutable artifacts",
		);
	const head = await getArtifactReleaseReviewHead(context.db, {
		organizationId: owner.organizationId,
		candidateId,
	});
	const recordedApprovalId = head?.eventType === "approved" ? head.id : null;
	const effectiveApproval = recordedApprovalId
		? await getActiveArtifactReleaseApproval(context.db, {
				organizationId: owner.organizationId,
				childArtifactId: child.id,
				approvalId: recordedApprovalId,
				childContentDigest: candidate.childContentDigest,
			})
		: null;
	let source: Awaited<ReturnType<typeof sourceState>> = {
		status: "unavailable",
		notice: "Private preview is unavailable.",
	};
	let parentBody: Awaited<
		ReturnType<typeof readVerifiedPrivateTextArtifact>
	> | null = null;
	let childBody: Awaited<
		ReturnType<typeof readVerifiedPrivateTextArtifact>
	> | null = null;
	try {
		await requireArtifactConversationAccess(context, parent);
		source = await sourceState(context, parent);
		if (
			source.status === "known_unverifiable" ||
			source.status === "unavailable"
		)
			throw new ArtifactReleaseReviewError("unavailable", source.notice);
		const bucket = context.env.TEDI_R2_BUCKET;
		if (!bucket)
			throw new ArtifactReleaseReviewError(
				"unavailable",
				"Artifact storage is unavailable",
			);
		[parentBody, childBody] = await Promise.all([
			readVerifiedPrivateTextArtifact(bucket, parent),
			readVerifiedPrivateTextArtifact(bucket, child),
		]);
	} catch (error) {
		if (!allowUnavailable) {
			if (error instanceof ArtifactReleaseReviewError) throw error;
			throw new ArtifactReleaseReviewError(
				"unavailable",
				"Private preview is unavailable",
			);
		}
		source = {
			status: "unavailable",
			notice:
				error instanceof ArtifactReleaseReviewError
					? error.message
					: "Private preview is unavailable.",
		};
	}
	return {
		candidateId,
		parentArtifactId: parent.id,
		parentContentDigest: candidate.parentContentDigest,
		childArtifactId: child.id,
		childContentDigest: candidate.childContentDigest,
		sourceStatus: source.status,
		sourceNotice: source.notice,
		reviewability: parentBody && childBody ? "reviewable" : "unavailable",
		reviewHeadId: head?.id ?? candidate.id,
		activeApprovalId: effectiveApproval?.approval.id ?? null,
		recordedApprovalId,
		releaseActive: Boolean(effectiveApproval),
		createdAt: candidate.createdAt,
		parentPreview: parentBody
			? {
					artifactId: parent.id,
					digest: candidate.parentContentDigest,
					text: parentBody.text,
					mimeType: "text/plain; charset=utf-8",
				}
			: null,
		candidatePreview: childBody
			? {
					artifactId: child.id,
					digest: candidate.childContentDigest,
					text: childBody.text,
					mimeType: "text/plain; charset=utf-8",
				}
			: null,
	};
}

export async function getArtifactReleaseSourcePreview(
	context: BaseContext,
	input: { tediId: string; sourceArtifactId: string },
) {
	const owner = await requireCanonicalHumanOwner(context);
	const parent = await getTediArtifact(context.db, {
		organizationId: owner.organizationId,
		artifactId: input.sourceArtifactId,
	});
	if (
		!parent ||
		parent.tediId !== input.tediId ||
		!parent.contentDigest ||
		parent.publicationState !== "ready"
	)
		throw new ArtifactReleaseReviewError(
			"not_found",
			"Reviewable source artifact not found",
		);
	await requireArtifactConversationAccess(context, parent);
	const source = await sourceState(context, parent);
	if (source.status === "known_unverifiable" || source.status === "unavailable")
		throw new ArtifactReleaseReviewError("unavailable", source.notice);
	const bucket = context.env.TEDI_R2_BUCKET;
	if (!bucket)
		throw new ArtifactReleaseReviewError(
			"unavailable",
			"Artifact storage is unavailable",
		);
	const body = await readVerifiedPrivateTextArtifact(bucket, parent);
	return {
		parentArtifactId: parent.id,
		parentContentDigest: parent.contentDigest,
		sourceStatus: source.status,
		sourceNotice: source.notice,
		parentPreview: {
			artifactId: parent.id,
			digest: parent.contentDigest,
			text: body.text,
			mimeType: "text/plain; charset=utf-8" as const,
		},
	};
}

export async function createRedactedArtifactRevision(
	context: BaseContext,
	input: {
		tediId: string;
		parentArtifactId: string;
		expectedParentDigest: string;
		content: string;
		idempotencyKey: string;
	},
) {
	const owner = await requireCanonicalHumanOwner(context);
	const parent = await getTediArtifact(context.db, {
		organizationId: owner.organizationId,
		artifactId: input.parentArtifactId,
	});
	if (
		!parent ||
		parent.tediId !== input.tediId ||
		parent.contentDigest !== input.expectedParentDigest ||
		parent.publicationState !== "ready"
	)
		throw new ArtifactReleaseReviewError(
			"conflict",
			"Reviewable parent artifact changed or is unavailable",
		);
	await requireArtifactConversationAccess(context, parent);
	const source = await sourceState(context, parent);
	if (source.status === "known_unverifiable" || source.status === "unavailable")
		throw new ArtifactReleaseReviewError("unavailable", source.notice);
	const bucket = context.env.TEDI_R2_BUCKET;
	if (!bucket)
		throw new ArtifactReleaseReviewError(
			"unavailable",
			"Artifact storage is unavailable",
		);
	await readVerifiedPrivateTextArtifact(bucket, parent);
	const candidateId = await deterministicId("artifact-release-candidate", [
		owner.organizationId,
		parent.id,
		input.idempotencyKey,
	]);
	const childId = await deterministicId("artifact-redaction", [
		owner.organizationId,
		parent.id,
		input.idempotencyKey,
	]);
	const child = await publishImmutablePrivateTextArtifact({
		db: context.db,
		bucket,
		id: childId,
		organizationId: owner.organizationId,
		tediId: input.tediId,
		conversationId: parent.conversationId,
		runId: parent.runId,
		messageId: parent.messageId,
		kind: parent.kind,
		name: `${parent.name}.redacted.txt`,
		content: input.content,
		createdAt: new Date().toISOString(),
	});
	await createArtifactRedactionCandidate(context.db, {
		id: candidateId,
		organizationId: owner.organizationId,
		tediId: input.tediId,
		parentArtifactId: parent.id,
		parentContentDigest: parent.contentDigest,
		childArtifactId: child.id,
		childContentDigest: child.contentDigest!,
		idempotencyKey: input.idempotencyKey,
		createdByMemberId: owner.member.id,
		createdByUserId: owner.member.userId!,
		createdAt: child.createdAt,
	});
	return buildReview(context, candidateId);
}

export async function getArtifactReleaseReview(
	context: BaseContext,
	input: { organizationId: string; tediId: string; candidateId: string },
) {
	const owner = await requireCanonicalHumanOwner(context);
	if (owner.organizationId !== input.organizationId)
		throw new ArtifactReleaseReviewError(
			"forbidden",
			"Artifact release organization changed",
		);
	return buildReview(context, input.candidateId, input.tediId, true);
}

export async function getArtifactReleaseTarget(
	context: BaseContext,
	input: { organizationId: string; tediId: string; artifactId: string },
) {
	const owner = await requireCanonicalHumanOwner(context);
	if (owner.organizationId !== input.organizationId)
		throw new ArtifactReleaseReviewError(
			"forbidden",
			"Artifact release organization changed",
		);
	const candidate = await getArtifactRedactionCandidate(context.db, {
		organizationId: owner.organizationId,
		childArtifactId: input.artifactId,
	});
	if (candidate) {
		if (candidate.tediId !== input.tediId)
			throw new ArtifactReleaseReviewError(
				"not_found",
				"Artifact release target not found",
			);
		return {
			review: await buildReview(context, candidate.id, input.tediId, true),
			sourcePreview: null,
		};
	}
	return {
		review: null,
		sourcePreview: await getArtifactReleaseSourcePreview(context, {
			tediId: input.tediId,
			sourceArtifactId: input.artifactId,
		}),
	};
}

export async function decideArtifactRelease(
	context: BaseContext,
	input: {
		candidateId: string;
		tediId: string;
		expectedReviewHeadId: string;
		childContentDigest: string;
		eventType: "approved" | "revoked";
		attestation: string;
	},
) {
	const owner = await requireCanonicalHumanOwner(context);
	const candidate = await getArtifactRedactionCandidate(context.db, {
		organizationId: owner.organizationId,
		candidateId: input.candidateId,
	});
	if (
		!candidate ||
		candidate.tediId !== input.tediId ||
		candidate.childContentDigest !== input.childContentDigest
	)
		throw new ArtifactReleaseReviewError(
			"conflict",
			"Artifact release candidate changed",
		);
	const id = await deterministicId("artifact-release-review", [
		owner.organizationId,
		candidate.id,
		input.eventType,
		input.expectedReviewHeadId,
		input.childContentDigest,
		input.attestation,
		owner.member.id,
	]);
	const head = await getArtifactReleaseReviewHead(context.db, {
		organizationId: owner.organizationId,
		candidateId: candidate.id,
	});
	if (head?.id === id)
		return {
			review:
				input.eventType === "approved"
					? await buildReview(context, candidate.id)
					: null,
			decision: {
				reviewId: id,
				eventType: input.eventType,
				candidateId: candidate.id,
				childContentDigest: candidate.childContentDigest,
			},
		};
	const expectedHead = head?.id ?? candidate.id;
	if (
		expectedHead !== input.expectedReviewHeadId ||
		(input.eventType === "revoked" && head?.eventType !== "approved")
	)
		throw new ArtifactReleaseReviewError(
			"conflict",
			"Artifact release review changed",
		);
	if (input.eventType === "approved") await buildReview(context, candidate.id);
	await appendArtifactReleaseReview(context.db, {
		id,
		organizationId: owner.organizationId,
		tediId: input.tediId,
		candidateId: candidate.id,
		eventType: input.eventType,
		previousReviewId: expectedHead,
		targetApprovalId: input.eventType === "revoked" ? expectedHead : null,
		childContentDigest: candidate.childContentDigest,
		reviewerMemberId: owner.member.id,
		reviewerUserId: owner.member.userId!,
		reviewerDescopeUserId: context.descopeUserId!,
		attestation: input.attestation,
		createdAt: new Date().toISOString(),
	});
	return {
		review:
			input.eventType === "approved"
				? await buildReview(context, candidate.id)
				: null,
		decision: {
			reviewId: id,
			eventType: input.eventType,
			candidateId: candidate.id,
			childContentDigest: candidate.childContentDigest,
		},
	};
}
