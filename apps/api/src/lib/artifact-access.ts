import { OsDerivedAccessEnvelopeSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type { TediArtifactRow } from "@tedix/db/queries/cognitive-runtime";
import type { BaseContext } from "../rpc/orpc";
import { authorizeDerivedOutputSources } from "../services/os-derived-resource-access";

const SHA256 = /^[a-f0-9]{64}$/;

export type ArtifactAccessDecision =
	| { allowed: true }
	| {
			allowed: false;
			reason:
				| "missing_provenance"
				| "source_access_required"
				| "source_access_unavailable";
	  };

function derivedEnvelope(artifact: TediArtifactRow) {
	if (
		artifact.publicationState !== "ready" ||
		!SHA256.test(artifact.contentDigest ?? "") ||
		!artifact.producerExecutionId ||
		!artifact.accessEnvelope
	)
		return null;
	try {
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(
			JSON.parse(artifact.accessEnvelope),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Legacy rows retain their explicit pre-classification behavior. */
export function authorizePublicArtifactBytes(
	artifact: TediArtifactRow,
): ArtifactAccessDecision {
	if (artifact.accessClassification === null) return { allowed: true };
	if (artifact.publicationState !== "ready")
		return { allowed: false, reason: "missing_provenance" };
	if (artifact.accessClassification === "runtime_private")
		return { allowed: false, reason: "source_access_required" };
	if (artifact.accessClassification === "explicit_shareable")
		return { allowed: true };
	if (artifact.accessClassification !== "source_derived")
		return { allowed: false, reason: "missing_provenance" };
	const envelope = derivedEnvelope(artifact);
	if (!envelope) return { allowed: false, reason: "missing_provenance" };
	return envelope.sources.length === 0
		? { allowed: true }
		: { allowed: false, reason: "source_access_required" };
}

export async function authorizeAuthenticatedArtifactBytes(
	context: BaseContext,
	artifact: TediArtifactRow,
): Promise<ArtifactAccessDecision> {
	if (artifact.accessClassification === null) return { allowed: true };
	if (artifact.publicationState !== "ready")
		return { allowed: false, reason: "missing_provenance" };
	if (artifact.accessClassification === "runtime_private")
		return { allowed: false, reason: "source_access_required" };
	if (artifact.accessClassification === "explicit_shareable")
		return { allowed: true };
	if (artifact.accessClassification !== "source_derived")
		return { allowed: false, reason: "missing_provenance" };
	const envelope = derivedEnvelope(artifact);
	if (!envelope) return { allowed: false, reason: "missing_provenance" };
	return (await authorizeDerivedOutputSources(context, {
		organizationId: artifact.organizationId,
		accessEnvelope: envelope,
	}))
		? { allowed: true }
		: { allowed: false, reason: "source_access_unavailable" };
}
