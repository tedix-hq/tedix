import { hashValue } from "@tedix/agent-governance/hash";
import type {
	Actor,
	MemoryAdapter,
	MemoryEntry,
	MemoryProvenance,
	MemoryRevision,
	MemoryWriteInput,
} from "@tedix/agent-governance/types";
import type { WorkspaceStorage } from "./runtime";

interface RevisionRow {
	record: string;
}

/** Workspace-local revisions; graph memory retains its separate owner storage. */
export class SqlMemoryAdapter implements MemoryAdapter {
	constructor(private readonly storage: WorkspaceStorage) {
		storage.run(`
CREATE TABLE IF NOT EXISTS workspace_memory_revisions (
	revision_id TEXT PRIMARY KEY,
	key TEXT NOT NULL,
	revision INTEGER NOT NULL,
	review TEXT NOT NULL,
	record TEXT NOT NULL,
	UNIQUE(key, revision)
);
CREATE INDEX IF NOT EXISTS workspace_memory_review ON workspace_memory_revisions(key, review, revision);
`);
	}

	private async append(
		input: MemoryWriteInput,
		rolledBackFrom?: string,
	): Promise<MemoryRevision> {
		if (typeof input.key !== "string" || !input.key.trim())
			throw new Error("Memory key must be nonempty");
		// Snapshot before hashing: a caller cannot change the persisted value during the await.
		const encoded = JSON.stringify(input);
		const snapshot = JSON.parse(encoded) as MemoryWriteInput;
		if (!("value" in snapshot)) throw new Error("Memory value must be JSON");
		const hash = await hashValue(snapshot.value);
		const [head] = this.storage.exec<{ revision: number }>(
			"SELECT COALESCE(MAX(revision), 0) AS revision FROM workspace_memory_revisions WHERE key = ?",
			snapshot.key,
		);
		const revision: MemoryRevision = {
			revisionId: crypto.randomUUID(),
			key: snapshot.key,
			revision: (head?.revision ?? 0) + 1,
			value: snapshot.value,
			hash,
			writtenAt: new Date().toISOString(),
			provenance: snapshot.provenance,
			review: snapshot.review ?? "pending",
			...(rolledBackFrom ? { rolledBackFrom } : {}),
		};
		// No await between allocating the revision and inserting it.
		this.storage.run(
			"INSERT INTO workspace_memory_revisions (revision_id, key, revision, review, record) VALUES (?, ?, ?, ?, ?)",
			revision.revisionId,
			revision.key,
			revision.revision,
			revision.review,
			JSON.stringify(revision),
		);
		return revision;
	}

	write(input: MemoryWriteInput): Promise<MemoryRevision> {
		return this.append(input);
	}

	async read(key: string): Promise<MemoryEntry | null> {
		const [current] = this.storage.exec<RevisionRow>(
			"SELECT record FROM workspace_memory_revisions WHERE key = ? ORDER BY revision DESC LIMIT 1",
			key,
		);
		if (!current) return null;
		const [approved] = this.storage.exec<RevisionRow>(
			"SELECT record FROM workspace_memory_revisions WHERE key = ? AND review = 'approved' ORDER BY revision DESC LIMIT 1",
			key,
		);
		return {
			key,
			current: JSON.parse(current.record) as MemoryRevision,
			...(approved
				? { approved: JSON.parse(approved.record) as MemoryRevision }
				: {}),
		};
	}

	async list(prefix = ""): Promise<MemoryEntry[]> {
		// substr preserves literal %, _ and case, unlike SQLite LIKE.
		const keys = this.storage.exec<{ key: string }>(
			"SELECT DISTINCT key FROM workspace_memory_revisions WHERE substr(key, 1, length(?)) = ? ORDER BY key",
			prefix,
			prefix,
		);
		const entries: MemoryEntry[] = [];
		for (const { key } of keys) {
			const entry = await this.read(key);
			if (entry) entries.push(entry);
		}
		return entries;
	}

	async history(key: string): Promise<MemoryRevision[]> {
		return this.storage
			.exec<RevisionRow>(
				"SELECT record FROM workspace_memory_revisions WHERE key = ? ORDER BY revision",
				key,
			)
			.map((row) => JSON.parse(row.record) as MemoryRevision);
	}

	async review(
		revisionId: string,
		decision: "approve" | "reject",
		reviewer: Actor,
		note?: string,
	): Promise<MemoryRevision> {
		const [row] = this.storage.exec<RevisionRow>(
			"SELECT record FROM workspace_memory_revisions WHERE revision_id = ?",
			revisionId,
		);
		if (!row) throw new Error(`Unknown memory revision ${revisionId}`);
		const revision = JSON.parse(row.record) as MemoryRevision;
		if (revision.review !== "pending")
			throw new Error(`Revision ${revisionId} was already ${revision.review}`);
		revision.review = decision === "approve" ? "approved" : "rejected";
		revision.reviewedBy = reviewer.id;
		revision.reviewedAt = new Date().toISOString();
		if (note) revision.reviewNote = note;
		this.storage.run(
			"UPDATE workspace_memory_revisions SET review = ?, record = ? WHERE revision_id = ?",
			revision.review,
			JSON.stringify(revision),
			revisionId,
		);
		return revision;
	}

	async rollback(
		key: string,
		toRevisionId: string,
		provenance: MemoryProvenance,
	): Promise<MemoryRevision> {
		const [row] = this.storage.exec<RevisionRow>(
			"SELECT record FROM workspace_memory_revisions WHERE key = ? AND revision_id = ?",
			key,
			toRevisionId,
		);
		if (!row)
			throw new Error(`Revision ${toRevisionId} is not a revision of ${key}`);
		const target = JSON.parse(row.record) as MemoryRevision;
		return this.append(
			{
				key,
				value: target.value,
				provenance,
				review: target.review === "approved" ? "approved" : "pending",
			},
			toRevisionId,
		);
	}
}
