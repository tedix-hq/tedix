export const REPOSITORY_CANDIDATE_MAX_FILES = 8;
export const REPOSITORY_CANDIDATE_MAX_FILE_BYTES = 64 * 1024;
export const REPOSITORY_CANDIDATE_MAX_TOTAL_BYTES = 256 * 1024;

type CandidateIdentity = {
	organizationId: string;
	workItemId: string;
	attemptId: string;
	admissionId: string;
	baseRevision: string;
	selectionDigest: string;
};

export function repositoryCandidateDocKey(scope: CandidateIdentity): string {
	return `repo-candidate:${scope.workItemId}:${scope.attemptId}:${scope.admissionId}:${scope.baseRevision}:${scope.selectionDigest}`;
}

export function repositoryCandidateRoomName(scope: CandidateIdentity): string {
	return `work-repository:${[scope.organizationId, scope.workItemId, scope.attemptId, scope.admissionId, scope.baseRevision, scope.selectionDigest].map(encodeURIComponent).join(":")}`;
}

/** A single encoding binds exports to the same path/text pairs on every transport. */
export function repositoryCandidateContentText(
	files: Record<string, string>,
): string {
	return JSON.stringify(
		Object.entries(files).sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0,
		),
	);
}

export async function repositoryCandidateContentDigest(
	files: Record<string, string>,
): Promise<string> {
	const hash = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(repositoryCandidateContentText(files)),
		),
	);
	return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function repositoryCandidateContentError(
	files: Record<string, string>,
	paths: readonly string[],
): string | null {
	const entries = Object.entries(files);
	if (
		entries.length !== paths.length ||
		entries.length > REPOSITORY_CANDIDATE_MAX_FILES ||
		entries.some(([path]) => !paths.includes(path))
	)
		return "The candidate must contain exactly its frozen selected files";
	let total = 0;
	for (const [, text] of entries) {
		const bytes = new TextEncoder().encode(text).byteLength;
		if (text.includes("\0"))
			return "Shared repository candidates contain text files only";
		if (bytes > REPOSITORY_CANDIDATE_MAX_FILE_BYTES)
			return "A selected file exceeds the shared editing limit";
		total += bytes;
	}
	return total > REPOSITORY_CANDIDATE_MAX_TOTAL_BYTES
		? "Selected files exceed the shared editing limit"
		: null;
}
