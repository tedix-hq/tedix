import {
	INLINE_THRESHOLD_BYTES,
	sha256HexSafe,
	validateArtifactPath,
} from "@tedix/db/queries/skill-run-artifacts";
import {
	getSkillRunArtifactStorageRow,
	insertSkillRunArtifactOnce,
	type SkillRunArtifactStorageRow,
} from "./db";
import { logSkillRuntimeWarning } from "./control-log";

export interface ImmutableArtifactInput {
	path: string;
	value?: unknown;
	mimeType?: string;
	outcome?: "pending" | "success" | "failure";
	attempt?: number;
}

export interface ImmutableArtifactResult {
	ok: true;
	id: string;
	sizeBytes: number;
	storage: "inline" | "r2";
	/** Digest of the bytes actually stored at this path (the first writer's). */
	sha256: string | null;
	/**
	 * True when a later writer presented *different* bytes for a path that is
	 * already sealed. The stored evidence is unchanged (first writer wins); this
	 * flags that something tried to rewrite history. Always false when either
	 * digest is unknown (pre-content-addressing rows).
	 */
	divergent: boolean;
}

function settle(
	existing: SkillRunArtifactStorageRow,
	incomingSha256: string | null,
	runId: string,
): ImmutableArtifactResult {
	const divergent =
		existing.sha256 !== null &&
		incomingSha256 !== null &&
		existing.sha256 !== incomingSha256;
	if (divergent) {
		logSkillRuntimeWarning("artifact.immutable_divergence", { runId });
	}
	return {
		ok: true,
		id: existing.id,
		sizeBytes: existing.size_bytes,
		storage: existing.content_r2_key ? "r2" : "inline",
		sha256: existing.sha256,
		divergent,
	};
}

/**
 * Atomically preserve the first small inline value for a run/path.
 *
 * Sealed-on-first-write: the row is never updated, so its `sha256` is bound to
 * the exact bytes admitted the first time and can never drift. A replay that
 * presents identical bytes is a no-op; a replay that presents *different* bytes
 * leaves the evidence untouched and returns `divergent: true` — the signal that
 * a re-write of sealed history was attempted.
 */
export async function recordArtifactOnceForRun(
	db: D1Database,
	runId: string,
	input: ImmutableArtifactInput,
	bucket?: R2Bucket,
): Promise<ImmutableArtifactResult> {
	validateArtifactPath(input.path);
	const effectiveMime = input.mimeType ?? "application/json";
	const serialized =
		effectiveMime === "application/json"
			? JSON.stringify(input.value ?? null)
			: typeof input.value === "string"
				? input.value
				: JSON.stringify(input.value ?? null);
	const sizeBytes = new TextEncoder().encode(serialized).byteLength;
	const sha256 = await sha256HexSafe(serialized);

	const selectExisting = () =>
		getSkillRunArtifactStorageRow(db, runId, input.path);

	const existingBefore = await selectExisting();
	if (existingBefore) {
		return settle(existingBefore, sha256, runId);
	}
	const id = crypto.randomUUID();
	let contentInline: string | null = serialized;
	let contentR2Key: string | null = null;
	if (sizeBytes > INLINE_THRESHOLD_BYTES) {
		if (!bucket) throw new Error("ARTIFACT_IMMUTABLE_R2_UNAVAILABLE");
		contentInline = null;
		contentR2Key = `${runId}/immutable/${id}`;
		await bucket.put(contentR2Key, serialized, {
			httpMetadata: { contentType: effectiveMime },
			customMetadata: {
				runId,
				path: input.path,
				immutable: "true",
				...(sha256 ? { sha256 } : {}),
			},
		});
	}
	const inserted = await insertSkillRunArtifactOnce(db, {
		id,
		runId,
		path: input.path,
		mimeType: effectiveMime,
		sizeBytes,
		contentInline,
		contentR2Key,
		sha256,
		attempt: input.attempt ?? 1,
		outcome: input.outcome ?? "success",
	});
	if (inserted) {
		return {
			ok: true,
			id,
			sizeBytes,
			storage: contentR2Key ? "r2" : "inline",
			sha256,
			divergent: false,
		};
	}
	if (contentR2Key && bucket) await bucket.delete(contentR2Key).catch(() => {});
	const existing = await selectExisting();
	if (!existing) throw new Error("ARTIFACT_IMMUTABLE_INSERT_LOST");
	return settle(existing, sha256, runId);
}
