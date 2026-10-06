import {
	type OsDerivedAccessEnvelope,
	OsDerivedAccessEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-workspaces";

type Envelope = OsDerivedAccessEnvelope;
type Source = Envelope["sources"][number];

function parseEnvelope(value: string | null | undefined): Envelope | null {
	if (value == null) return null;
	try {
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function identity(source: Source): string {
	return JSON.stringify([
		source.workspaceId,
		source.providerId,
		source.resourceType,
		source.providerResourceId,
		source.connectionScope,
	]);
}

/**
 * Preserve every known source when immutable output bytes are revised.
 * Any unverifiable input, identity disagreement, or schema-bound overflow
 * fails closed to null rather than silently narrowing the access requirement.
 */
export function mergeOsOutputAccessEnvelopes(
	priorValue: string | null | undefined,
	additionalValue: string | null | undefined,
): string | null {
	const prior = parseEnvelope(priorValue);
	const additional = parseEnvelope(additionalValue);
	if (!prior || !additional) return null;

	const byResourceId = new Map<string, Source>();
	const resourceIdByIdentity = new Map<string, string>();
	for (const source of [...prior.sources, ...additional.sources]) {
		const sourceIdentity = identity(source);
		const identityOwner = resourceIdByIdentity.get(sourceIdentity);
		if (identityOwner && identityOwner !== source.workspaceResourceId)
			return null;
		resourceIdByIdentity.set(sourceIdentity, source.workspaceResourceId);

		const existing = byResourceId.get(source.workspaceResourceId);
		if (!existing) {
			byResourceId.set(source.workspaceResourceId, source);
			continue;
		}
		if (identity(existing) !== sourceIdentity) return null;
		byResourceId.set(source.workspaceResourceId, {
			...existing,
			requiredScopes: [
				...new Set([...existing.requiredScopes, ...source.requiredScopes]),
			].sort(),
			operations: [
				...new Set([...existing.operations, ...source.operations]),
			].sort(),
		});
	}

	const merged = OsDerivedAccessEnvelopeSchema.safeParse({
		version: 1,
		sources: [...byResourceId.values()],
	});
	return merged.success ? JSON.stringify(merged.data) : null;
}
