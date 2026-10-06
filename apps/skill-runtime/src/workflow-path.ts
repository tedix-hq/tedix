/** Maximum encoded size for one artifact path component. */
export const WORKFLOW_ARTIFACT_SEGMENT_MAX_LENGTH = 160;

/**
 * Encode one operator-authored artifact path component without ever emitting
 * `..`, which the shared artifact validator rejects. The bound keeps the full
 * path below the platform's 512-character limit even for nested step receipts.
 */
export function encodeWorkflowArtifactPathSegment(value: string): string {
	// The literal prefix prevents WHATWG URL parsers from normalizing encoded
	// `.` / `..` path segments and makes the grammar explicit to readers.
	const encodedPayload = encodeURIComponent(value).replaceAll(".", "%2E");
	const encoded = `x:${encodedPayload}`;
	if (
		encodedPayload.length === 0 ||
		encoded.length > WORKFLOW_ARTIFACT_SEGMENT_MAX_LENGTH
	) {
		throw new Error(
			`encoded workflow artifact segment must be between 1 and ${WORKFLOW_ARTIFACT_SEGMENT_MAX_LENGTH} characters`,
		);
	}
	return encoded;
}
