export function linkWorkspaceMemoryChangeRecord(
	storage: { run(sql: string, ...params: unknown[]): void },
	revisionId: string,
	changeRecordId: string,
): void {
	storage.run(
		"UPDATE workspace_memory_revisions SET record = json_set(record, '$.provenance.changeRecordId', ?) WHERE revision_id = ?",
		changeRecordId,
		revisionId,
	);
}
