import { hashValue } from "@tedix/agent-governance/hash";
import type {
	Actor,
	MemoryAdapter,
	MemoryEntry,
	MemoryProvenance,
	MemoryRevision,
	MemoryWriteInput,
} from "@tedix/agent-governance/types";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	tediMemoryDocuments,
	type TediMemoryDocumentRow,
} from "../schema/tedi-memory";
import {
	appendTediMemoryDocumentVersion,
	getCurrentTediMemoryDocument,
	type AppendTediMemoryVersionParams,
} from "./tedi-memory";

type Scope = { organizationId: string; tediId: string };
// The slash cannot occur in a native note name, including a note named core.
export const tediMemoryKey = (kind: "core" | "note", name: string) =>
	kind === "core" ? "core/" : name;
const document = (key: string) => ({
	kind: key === "core/" ? ("core" as const) : ("note" as const),
	name: key === "core/" ? "core" : key,
});
const valueOf = (
	row: Pick<
		TediMemoryDocumentRow,
		"kind" | "sections" | "description" | "content" | "removed"
	>,
) =>
	row.kind === "core"
		? (row.sections ?? {})
		: row.removed
			? null
			: { description: row.description ?? "", content: row.content ?? "" };

/** Personal store, isolated by organization and tedi; document versions are revisions. */
export class TediMemoryAdapter implements MemoryAdapter {
	constructor(
		private readonly db: DbQueryClient,
		private readonly scope: Scope,
	) {}
	private predicate() {
		return and(
			eq(tediMemoryDocuments.organizationId, this.scope.organizationId),
			eq(tediMemoryDocuments.tediId, this.scope.tediId),
		);
	}
	private async revision(row: TediMemoryDocumentRow): Promise<MemoryRevision> {
		if (row.revision) return structuredClone(row.revision);
		const value = valueOf(row);
		return {
			revisionId: row.id,
			key: tediMemoryKey(row.kind, row.name),
			revision: row.version,
			value,
			hash: await hashValue(value),
			writtenAt: row.createdAt,
			review: "pending",
			provenance: {
				actor: {
					id: row.authorId,
					kind: row.authorType === "reflection" ? "tedi" : row.authorType,
					organizationId: row.organizationId,
				},
				source: {
					surface:
						row.authorType === "reflection"
							? "tedi_memory_reflection"
							: "tedi_memory",
				},
			},
		};
	}
	/** Native writers retain their CAS, summaries and version-retention limits. */
	async appendDocument(
		params: AppendTediMemoryVersionParams,
		input?: MemoryWriteInput,
	): Promise<MemoryRevision | null> {
		if (
			params.organizationId !== this.scope.organizationId ||
			params.tediId !== this.scope.tediId
		)
			throw new Error("Memory document is outside this store");
		const revision = input
			? {
					...structuredClone(input),
					revisionId: params.id,
					revision: params.baseVersion + 1,
					hash: await hashValue(input.value),
					writtenAt: input.writtenAt ?? params.createdAt,
					review: input.review ?? "pending",
				}
			: await this.revision({
					...params,
					version: params.baseVersion + 1,
					revision: null,
					sections: params.sections ?? null,
					description: params.description ?? null,
					content: params.content ?? null,
					removed: params.removed ?? false,
				});
		return (await appendTediMemoryDocumentVersion(this.db, {
			...params,
			revision,
		}))
			? revision
			: null;
	}
	async write(input: MemoryWriteInput): Promise<MemoryRevision> {
		const target = { ...this.scope, ...document(input.key) };
		const current = await getCurrentTediMemoryDocument(this.db, target);
		const value = input.value as {
			description?: unknown;
			content?: unknown;
		} | null;
		const description =
			typeof value?.description === "string" ? value.description : null;
		const content = typeof value?.content === "string" ? value.content : null;
		const sections =
			target.kind === "core" ? (input.value as Record<string, string>) : null;
		const revision = await this.appendDocument(
			{
				...target,
				id: crypto.randomUUID(),
				baseVersion: current?.version ?? 0,
				sections,
				description,
				content,
				removed: input.value === null,
				charCount:
					target.kind === "core"
						? Object.values(sections ?? {}).join("").length
						: (content?.length ?? 0),
				authorId: input.provenance.actor.id,
				authorType: input.provenance.actor.kind === "user" ? "user" : "tedi",
				changeSummary: input.rolledBackFrom
					? "Restored memory revision"
					: "Wrote memory revision",
				createdAt: input.writtenAt ?? new Date().toISOString(),
				keepVersions: Number.MAX_SAFE_INTEGER,
			},
			input,
		);
		if (!revision) throw new Error("Memory document changed concurrently");
		return revision;
	}
	async history(key: string): Promise<MemoryRevision[]> {
		const rows = await this.db
			.select()
			.from(tediMemoryDocuments)
			.where(
				and(
					this.predicate(),
					eq(tediMemoryDocuments.kind, document(key).kind),
					eq(tediMemoryDocuments.name, document(key).name),
				),
			)
			.orderBy(asc(tediMemoryDocuments.version));
		return Promise.all(rows.map((row) => this.revision(row)));
	}
	async read(key: string): Promise<MemoryEntry | null> {
		const history = await this.history(key);
		const current = history.at(-1);
		if (!current) return null;
		const approved = [...history]
			.reverse()
			.find((r) => r.review === "approved");
		return { key, current, ...(approved ? { approved } : {}) };
	}
	async list(prefix = ""): Promise<MemoryEntry[]> {
		const rows = await this.db
			.selectDistinct({
				kind: tediMemoryDocuments.kind,
				name: tediMemoryDocuments.name,
			})
			.from(tediMemoryDocuments)
			.where(this.predicate())
			.orderBy(asc(tediMemoryDocuments.name));
		return Promise.all(
			rows
				.map((row) => tediMemoryKey(row.kind, row.name))
				.filter((key) => key.startsWith(prefix))
				.sort()
				.map(async (key) => (await this.read(key))!),
		);
	}
	async review(
		revisionId: string,
		decision: "approve" | "reject",
		reviewer: Actor,
		note?: string,
	): Promise<MemoryRevision> {
		const [row] = await this.db
			.select()
			.from(tediMemoryDocuments)
			.where(and(this.predicate(), eq(tediMemoryDocuments.id, revisionId)));
		if (!row) throw new Error(`Unknown memory revision ${revisionId}`);
		const revision = await this.revision(row);
		if (revision.review !== "pending")
			throw new Error(`Revision ${revisionId} was already ${revision.review}`);
		revision.review = decision === "approve" ? "approved" : "rejected";
		revision.reviewedBy = reviewer.id;
		revision.reviewedAt = new Date().toISOString();
		if (note) revision.reviewNote = note;
		const [saved] = await this.db
			.update(tediMemoryDocuments)
			.set({ revision })
			.where(
				and(
					this.predicate(),
					eq(tediMemoryDocuments.id, revisionId),
					sql`${tediMemoryDocuments.revision} IS ${row.revision === null ? null : JSON.stringify(row.revision)}`,
				),
			)
			.returning({ id: tediMemoryDocuments.id });
		if (!saved) throw new Error("Memory review changed concurrently");
		return revision;
	}
	async rollback(
		key: string,
		toRevisionId: string,
		provenance: MemoryProvenance,
	): Promise<MemoryRevision> {
		const target = (await this.history(key)).find(
			(r) => r.revisionId === toRevisionId,
		);
		if (!target)
			throw new Error(`Revision ${toRevisionId} is not a revision of ${key}`);
		return this.write({
			key,
			value: target.value,
			provenance,
			review: target.review === "approved" ? "approved" : "pending",
			rolledBackFrom: target.revisionId,
		});
	}
}
