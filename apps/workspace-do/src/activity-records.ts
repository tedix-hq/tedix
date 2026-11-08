import type { WorkspaceChangeInput } from "@tedix/api-contract/schemas/workspace-feed";
import type { WorkspaceStorage } from "./runtime";

/** Sanitized source records survive chat retention and failed core publication. */
export class SqlActivityRecords {
	constructor(private readonly storage: WorkspaceStorage) {
		storage.run(`CREATE TABLE IF NOT EXISTS activity_records (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			event TEXT NOT NULL
		)`);
	}

	append(event: WorkspaceChangeInput): void {
		this.storage.run(
			"INSERT OR IGNORE INTO activity_records (id, event) VALUES (?, ?)",
			event.changeRecordId,
			JSON.stringify(event),
		);
	}

	list(input: { afterSequence?: number; limit?: number } = {}) {
		return this.storage
			.exec<{ sequence: number; event: string }>(
				"SELECT sequence, event FROM activity_records WHERE sequence > ? ORDER BY sequence LIMIT ?",
				input.afterSequence ?? 0,
				Math.min(Math.max(input.limit ?? 100, 1), 1_000),
			)
			.map((row) => ({
				sequence: row.sequence,
				event: JSON.parse(row.event) as WorkspaceChangeInput,
			}));
	}
}
