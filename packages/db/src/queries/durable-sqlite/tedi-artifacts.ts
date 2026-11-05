/**
 * Tenant-store variant of the `tedi_artifacts` surface — the artifact reads in
 * `../kernel-runtime-events.ts` and the claim/publish writes in
 * `../cognitive-runtime.ts`.
 *
 * Artifact bodies never lived in D1 either (`uri` points at R2), so the
 * "bodies stay in R2" plane rule changes nothing here; the rows are pure
 * metadata and provenance. The only semantic difference is atomicity:
 * `db.transaction()` (`transactionSync`) replaces `db.batch()`.
 *
 * `TediArtifactOwnershipConflictError` is imported, not redeclared, so a
 * caller catching the platform error type still matches tenant-plane throws.
 */

import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { tediArtifacts } from "../../schema/cognitive-runtime";
import { chunkForBoundParams } from "../../utils/batch";
import {
	type TediArtifactInsert,
	type TediArtifactRow,
	TediArtifactOwnershipConflictError,
} from "../cognitive-runtime";
import type { TenantStoreDb } from "./tenant-store";

export type { TediArtifactInsert, TediArtifactRow };
export { TediArtifactOwnershipConflictError };

/** D1's bound-parameter cap; kept so both planes emit the same statements. */
const RUN_ID_CHUNK = 50;

export async function listTediArtifacts(
	db: TenantStoreDb,
	input: {
		tediId: string;
		conversationId?: string;
		runId?: string;
		messageId?: string;
		kind?: TediArtifactRow["kind"];
		name?: string;
		before?: string;
		limit: number;
	},
): Promise<TediArtifactRow[]> {
	const conditions = [
		eq(tediArtifacts.tediId, input.tediId),
		...(input.name ? [eq(tediArtifacts.name, input.name)] : []),
		...(input.conversationId
			? [eq(tediArtifacts.conversationId, input.conversationId)]
			: []),
		...(input.runId ? [eq(tediArtifacts.runId, input.runId)] : []),
		...(input.messageId ? [eq(tediArtifacts.messageId, input.messageId)] : []),
		...(input.kind ? [eq(tediArtifacts.kind, input.kind)] : []),
		...(input.before ? [lt(tediArtifacts.createdAt, input.before)] : []),
	];
	return db
		.select()
		.from(tediArtifacts)
		.where(and(...conditions))
		.orderBy(desc(tediArtifacts.createdAt))
		.limit(input.limit);
}

export async function listTediArtifactsForRuns(
	db: TenantStoreDb,
	input: {
		organizationId?: string;
		tediId: string;
		runIds: string[];
		limit: number;
	},
): Promise<TediArtifactRow[]> {
	if (input.runIds.length === 0) return [];
	const rows: TediArtifactRow[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.runIds)],
		RUN_ID_CHUNK,
	)) {
		rows.push(
			...db
				.select()
				.from(tediArtifacts)
				.where(
					and(
						...(input.organizationId
							? [eq(tediArtifacts.organizationId, input.organizationId)]
							: []),
						eq(tediArtifacts.tediId, input.tediId),
						inArray(tediArtifacts.runId, chunk),
					),
				)
				.orderBy(desc(tediArtifacts.createdAt))
				.limit(input.limit)
				.all(),
		);
	}
	// Re-establish the single-statement contract across chunks: newest first,
	// limited over the merged set.
	rows.sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
	);
	return rows.slice(0, input.limit);
}

/** Read one artifact by its stable id and owning tedi, optionally org-scoped. */
export async function getTediArtifactById(
	db: TenantStoreDb,
	input: { organizationId?: string; tediId: string; artifactId: string },
): Promise<TediArtifactRow | undefined> {
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(
			and(
				...(input.organizationId
					? [eq(tediArtifacts.organizationId, input.organizationId)]
					: []),
				eq(tediArtifacts.tediId, input.tediId),
				eq(tediArtifacts.id, input.artifactId),
			),
		)
		.limit(1);
	return row;
}

export async function upsertTediArtifact(
	db: TenantStoreDb,
	input: TediArtifactInsert,
): Promise<TediArtifactRow> {
	const [row] = await db
		.insert(tediArtifacts)
		.values(input)
		.onConflictDoUpdate({
			target: tediArtifacts.id,
			set: {
				conversationId: input.conversationId,
				runId: input.runId,
				messageId: input.messageId,
				kind: input.kind,
				name: input.name,
				mimeType: input.mimeType,
				uri: input.uri,
				sizeBytes: input.sizeBytes,
				metadata: input.metadata,
			},
			setWhere: and(
				eq(tediArtifacts.organizationId, input.organizationId),
				eq(tediArtifacts.tediId, input.tediId),
				isNull(tediArtifacts.accessClassification),
			),
		})
		.returning();
	if (!row) throw new TediArtifactOwnershipConflictError(input.id);
	return row;
}

/**
 * Create the immutable identity/content/provenance claim before publishing R2
 * bytes. Retries may read the identical claim, but can never rewrite or
 * downgrade it.
 */
export async function claimTediArtifact(
	db: TenantStoreDb,
	input: TediArtifactInsert,
): Promise<{ artifact: TediArtifactRow; created: boolean }> {
	return db.transaction((tx) => {
		const [created] = tx
			.insert(tediArtifacts)
			.values({
				...input,
				createdAt: input.createdAt ?? new Date().toISOString(),
			})
			.onConflictDoNothing({ target: tediArtifacts.id })
			.returning()
			.all();
		if (created) return { artifact: created, created: true };
		const [existing] = tx
			.select()
			.from(tediArtifacts)
			.where(
				and(
					eq(tediArtifacts.organizationId, input.organizationId),
					eq(tediArtifacts.id, input.id),
				),
			)
			.limit(1)
			.all();
		if (
			!existing ||
			existing.tediId !== input.tediId ||
			existing.conversationId !== (input.conversationId ?? null) ||
			existing.runId !== (input.runId ?? null) ||
			existing.messageId !== (input.messageId ?? null) ||
			existing.kind !== input.kind ||
			existing.name !== input.name ||
			existing.mimeType !== (input.mimeType ?? null) ||
			existing.uri !== input.uri ||
			existing.sizeBytes !== (input.sizeBytes ?? null) ||
			JSON.stringify(existing.metadata ?? null) !==
				JSON.stringify(input.metadata ?? null) ||
			existing.contentDigest !== input.contentDigest ||
			existing.accessClassification !== input.accessClassification ||
			existing.producerExecutionId !== (input.producerExecutionId ?? null) ||
			existing.accessEnvelope !== (input.accessEnvelope ?? null) ||
			(input.createdAt !== undefined && existing.createdAt !== input.createdAt)
		) {
			throw new TediArtifactOwnershipConflictError(input.id);
		}
		return { artifact: existing, created: false };
	});
}

/** Publish only the exact pending immutable claim after storage verification. */
export async function markTediArtifactPublished(
	db: TenantStoreDb,
	input: {
		id: string;
		organizationId: string;
		tediId: string;
		contentDigest: string | null;
	},
): Promise<TediArtifactRow | null> {
	const [published] = await db
		.update(tediArtifacts)
		.set({ publicationState: "ready" })
		.where(
			and(
				eq(tediArtifacts.id, input.id),
				eq(tediArtifacts.organizationId, input.organizationId),
				eq(tediArtifacts.tediId, input.tediId),
				input.contentDigest === null
					? isNull(tediArtifacts.contentDigest)
					: eq(tediArtifacts.contentDigest, input.contentDigest),
				eq(tediArtifacts.publicationState, "pending"),
			),
		)
		.returning();
	return published ?? null;
}

export async function getTediArtifact(
	db: TenantStoreDb,
	input:
		| { tediId: string; artifactId: string }
		| { organizationId: string; artifactId: string },
): Promise<TediArtifactRow | null> {
	const ownerCondition =
		"organizationId" in input
			? eq(tediArtifacts.organizationId, input.organizationId)
			: eq(tediArtifacts.tediId, input.tediId);
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(and(ownerCondition, eq(tediArtifacts.id, input.artifactId)))
		.limit(1);
	return row ?? null;
}

/** Exact global-id lookup used only to fence create-only ownership claims. */
export async function getTediArtifactClaim(
	db: TenantStoreDb,
	artifactId: string,
): Promise<TediArtifactRow | null> {
	const [row] = await db
		.select()
		.from(tediArtifacts)
		.where(eq(tediArtifacts.id, artifactId))
		.limit(1);
	return row ?? null;
}
