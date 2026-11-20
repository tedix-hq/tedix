import { hashValue } from "./hash";
import type { MemoryAdapter, MemoryRevision } from "./types";

/** One JSON revision per line, with each key's history oldest first. */
export async function exportMemory(memory: MemoryAdapter): Promise<string> {
	const lines: string[] = [];
	for (const { key } of await memory.list()) {
		for (const revision of await memory.history(key)) {
			lines.push(JSON.stringify(revision));
		}
	}
	return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * Copy history into absent keys. The caller identifies the source store and
 * excludes concurrent destination writes. Validation precedes every write;
 * storage failures can still leave a partially imported bundle.
 */
export async function importMemory(
	memory: MemoryAdapter,
	bundle: string,
	store: string,
): Promise<number> {
	if (!store.trim()) throw new Error("Memory import needs a source store");
	const revisions: MemoryRevision[] = bundle
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
	const heads = new Map<string, number>();
	const originals = new Map<string, MemoryRevision>();
	for (const row of revisions) {
		if (
			!row ||
			typeof row.key !== "string" ||
			!row.key.trim() ||
			typeof row.revisionId !== "string" ||
			!row.revisionId ||
			originals.has(row.revisionId) ||
			row.revision !== (heads.get(row.key) ?? 0) + 1 ||
			!("value" in row) ||
			typeof row.writtenAt !== "string" ||
			typeof row.provenance?.actor?.id !== "string" ||
			typeof row.provenance.actor.kind !== "string" ||
			typeof row.provenance.source?.surface !== "string" ||
			![row.reviewedBy, row.reviewedAt, row.reviewNote].every(
				(value) => value === undefined || typeof value === "string",
			) ||
			(row.provenance.importedFrom !== undefined &&
				(!Array.isArray(row.provenance.importedFrom) ||
					!row.provenance.importedFrom.every(
						(origin) =>
							typeof origin?.store === "string" &&
							typeof origin.revisionId === "string",
					))) ||
			!["pending", "approved", "rejected"].includes(row.review)
		) {
			throw new Error("Invalid memory revision or history order");
		}
		if ((await hashValue(row.value)) !== row.hash) {
			throw new Error(
				`Memory hash mismatch for ${row.key} revision ${row.revision}`,
			);
		}
		if (row.rolledBackFrom !== undefined) {
			const target = originals.get(row.rolledBackFrom);
			if (!target || target.key !== row.key || target.hash !== row.hash) {
				throw new Error(`Invalid memory rollback for ${row.key}`);
			}
		}
		heads.set(row.key, row.revision);
		originals.set(row.revisionId, row);
	}
	for (const key of heads.keys()) {
		if (await memory.read(key))
			throw new Error(`Memory key already exists: ${key}`);
	}
	const localIds = new Map<string, string>();
	for (const row of revisions) {
		const { revisionId, revision: _revision, hash: _hash, ...input } = row;
		const saved = await memory.write({
			...input,
			provenance: {
				...row.provenance,
				importedFrom: [
					...(row.provenance.importedFrom ?? []),
					{ store, revisionId },
				],
			},
			...(row.rolledBackFrom !== undefined
				? { rolledBackFrom: localIds.get(row.rolledBackFrom)! }
				: {}),
		});
		if (saved.hash !== row.hash || saved.revision !== row.revision) {
			throw new Error(`Memory adapter changed imported history for ${row.key}`);
		}
		localIds.set(revisionId, saved.revisionId);
	}
	return revisions.length;
}
