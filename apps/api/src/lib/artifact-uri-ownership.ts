const PRIMARY_ARTIFACT_BUCKET = "tedix-tedi-production";
const LEGACY_ARTIFACT_BUCKET_ALIAS = "tedi-storage";
const UUID_SEGMENT =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMBIGUOUS_KEY_CHARACTER = /[\\?#]/;
const ENCODED_SEPARATOR_OR_NUL = /%(?:00|2f|5c)/i;
const ENCODED_DOT_SEGMENT = /^(?:%2e){1,2}$/i;
const MAX_R2_KEY_BYTES = 1_024;

export type ArtifactUriOwnership =
	| { kind: "non-r2" }
	| {
			kind: "owned-r2";
			bucket: typeof PRIMARY_ARTIFACT_BUCKET;
			key: string;
	  }
	| { kind: "invalid-r2" };

function hasSafeKeyShape(key: string): boolean {
	const hasControlCharacter = Array.from(key).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || codePoint === 0x7f;
	});
	if (
		!key ||
		new TextEncoder().encode(key).byteLength > MAX_R2_KEY_BYTES ||
		hasControlCharacter ||
		AMBIGUOUS_KEY_CHARACTER.test(key) ||
		ENCODED_SEPARATOR_OR_NUL.test(key)
	) {
		return false;
	}
	const segments = key.split("/");
	return segments.every(
		(segment, index) =>
			(index === segments.length - 1 && segment === "") ||
			(segment !== "" &&
				segment !== "." &&
				segment !== ".." &&
				!ENCODED_DOT_SEGMENT.test(segment)),
	);
}

/**
 * Classify an artifact URI and prove that any platform R2 key belongs to the
 * artifact row's tenant namespace. Non-R2 references remain registry-only.
 *
 * Same-organization peer workstation evidence is intentional: independent
 * tedis review one another's execution receipts. The organization segment is
 * therefore authoritative for `orgs/.../workstations`, while direct artifact
 * and legacy organization-less workstation keys remain bound to the row tedi.
 */
export function inspectArtifactUriOwnership(input: {
	uri: string | null | undefined;
	organizationId: string;
	tediId: string;
}): ArtifactUriOwnership {
	const { uri, organizationId, tediId } = input;
	if (!uri || !/^r2:/i.test(uri)) return { kind: "non-r2" };
	const match = /^r2:\/\/([^/]+)\/(.+)$/.exec(uri);
	if (!match?.[1] || !match[2]) return { kind: "invalid-r2" };
	const authority = match[1];
	const key = match[2];
	if (
		(authority !== PRIMARY_ARTIFACT_BUCKET &&
			authority !== LEGACY_ARTIFACT_BUCKET_ALIAS) ||
		!hasSafeKeyShape(key)
	) {
		return { kind: "invalid-r2" };
	}

	const directArtifactPrefix = `${tediId}/artifacts/`;
	const legacyWorkstationPrefix = `tedis/${tediId}/workstations/`;
	const organizationWorkstationPrefix = `orgs/${organizationId}/tedis/`;
	const organizationWorkstationRemainder = key.startsWith(
		organizationWorkstationPrefix,
	)
		? key.slice(organizationWorkstationPrefix.length)
		: null;
	const peerSegments = organizationWorkstationRemainder?.split("/") ?? [];
	const isOrganizationWorkstation =
		peerSegments.length >= 3 &&
		UUID_SEGMENT.test(peerSegments[0] ?? "") &&
		peerSegments[1] === "workstations";

	if (
		!key.startsWith(directArtifactPrefix) &&
		!key.startsWith(legacyWorkstationPrefix) &&
		!isOrganizationWorkstation
	) {
		return { kind: "invalid-r2" };
	}
	return { kind: "owned-r2", bucket: PRIMARY_ARTIFACT_BUCKET, key };
}

export function isOwnedArtifactR2Uri(input: {
	uri: string | null | undefined;
	organizationId: string;
	tediId: string;
}): boolean {
	return inspectArtifactUriOwnership(input).kind === "owned-r2";
}
