/**
 * True when a statement failed only because this store has no
 * `audit_metadata_refs` table. The main database gets the table from the
 * normal release; each logs database gets it when the operator applies the
 * logs migrations, which can be later. Callers fall back to inline
 * identifiers for that store and rethrow every other error.
 */
export function isMissingAuditMetadataRefsTable(error: unknown): boolean {
	const seen = new Set<unknown>();
	for (
		let current = error;
		current instanceof Error && !seen.has(current);
		current = current.cause
	) {
		seen.add(current);
		if (current.message.includes("no such table: audit_metadata_refs"))
			return true;
	}
	return false;
}
