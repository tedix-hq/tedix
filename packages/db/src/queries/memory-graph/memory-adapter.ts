import { hashValue } from "@tedix/agent-governance/hash";
import type {
	Actor,
	MemoryAdapter,
	MemoryEntry,
	MemoryProvenance,
	MemoryRevision,
	MemoryReviewState,
	MemoryWriteInput,
} from "@tedix/agent-governance/types";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { prefixedColumns } from "../../utils/select";
import { memoryFacts, type MemoryFact } from "../../schema/memory-graph";
import { normalizeTenantScope, type TenantScope } from "../../tenant-scope";

/** Evidence-only facts are accepted as evidence, not as instructions. */
export function factReviewState(
	status: MemoryFact["reviewStatus"],
): MemoryReviewState {
	switch (status) {
		case "confirmed":
		case "evidence_only":
			return "approved";
		case "rejected":
		case "restricted":
		case "stale":
		case "disputed":
		case "superseded":
			return "rejected";
		default:
			return "pending";
	}
}
const factStatus = {
	pending: "pending",
	approved: "confirmed",
	rejected: "rejected",
} as const;
const contentFor = (value: unknown): string =>
	typeof value === "string" ? value : JSON.stringify(value);
const byId = sql`${memoryFacts} INDEXED BY sqlite_autoindex_memory_facts_1`;
const bySource = sql`${memoryFacts} INDEXED BY idx_memory_facts_org_source_id`;

/** Organization store only. Workspace and personal owners use separate stores.
 * History stays in metadata so no extra rows enter existing recall or graph edges.
 * Callers authorize the organization and operation before constructing this adapter.
 */
export class OrganizationMemoryAdapter implements MemoryAdapter {
	private readonly organizationId: string;
	constructor(
		private readonly db: DbQueryClient,
		scope: TenantScope,
	) {
		if (scope.workspaceId !== undefined)
			throw new Error("Organization memory cannot open a workspace store");
		this.organizationId = normalizeTenantScope(scope).organizationId;
	}
	private async fact(key: string): Promise<MemoryFact | undefined> {
		const [fact] = await this.db
			.select(prefixedColumns(memoryFacts, "fact"))
			.from(byId)
			.where(
				and(
					eq(memoryFacts.id, key),
					eq(memoryFacts.organizationId, this.organizationId),
				),
			);
		return fact;
	}
	private async revisions(fact: MemoryFact): Promise<MemoryRevision[]> {
		const history = structuredClone(
			(fact.metadata?.memoryAdapterRevisions ??
				[]) as unknown as MemoryRevision[],
		);
		let current = history.at(-1);
		// Capture a legacy fact, or an edit made through an existing fact writer.
		if (!current || contentFor(current.value) !== fact.content) {
			const hash = await hashValue(fact.content);
			current = {
				key: fact.id,
				revisionId: JSON.stringify([fact.id, hash, history.length + 1]),
				revision: history.length + 1,
				value: fact.content,
				hash,
				writtenAt: fact.updatedAt ?? fact.createdAt ?? "",
				provenance: {
					actor: {
						// Legacy ownership is not evidence of authorship.
						id: "memory-graph",
						kind: "system",
						organizationId: this.organizationId,
					},
					source: {
						surface: fact.source ?? "memory-graph",
						...(fact.sourceSessionId ? { traceId: fact.sourceSessionId } : {}),
					},
				},
				review: factReviewState(fact.reviewStatus),
			};
			history.push(current);
		}
		current.review = factReviewState(fact.reviewStatus);
		return history;
	}
	private async entry(fact: MemoryFact): Promise<MemoryEntry> {
		const revisions = await this.revisions(fact);
		const approved = [...revisions]
			.reverse()
			.find((r) => r.review === "approved");
		return {
			key: fact.id,
			current: revisions.at(-1)!,
			...(approved ? { approved } : {}),
		};
	}
	private async save(
		fact: MemoryFact,
		revisions: MemoryRevision[],
		updates: Partial<MemoryFact> = {},
	): Promise<void> {
		// Preserve competing content, metadata and review edits with a CAS.
		// Conflicts are surfaced to the caller.
		const [saved] = await this.db
			.update(memoryFacts)
			.set({
				...updates,
				metadata: {
					...fact.metadata,
					memoryAdapterRevisions: JSON.parse(
						JSON.stringify(revisions),
					) as JsonValue,
				},
			})
			.where(
				and(
					eq(memoryFacts.id, fact.id),
					eq(memoryFacts.organizationId, this.organizationId),
					sql`${memoryFacts.content} IS ${fact.content}`,
					sql`${memoryFacts.reviewStatus} IS ${fact.reviewStatus}`,
					sql`${memoryFacts.metadata} IS ${fact.metadata === null ? null : JSON.stringify(fact.metadata)}`,
					sql`${memoryFacts.updatedAt} IS ${fact.updatedAt}`,
				),
			)
			.returning({ id: memoryFacts.id });
		if (!saved) throw new Error("Memory fact changed concurrently");
	}
	private async append(
		input: MemoryWriteInput,
		rolledBackFrom?: string,
	): Promise<MemoryRevision> {
		if (!input.key.trim()) throw new Error("Memory key must be nonempty");
		const snapshot = JSON.parse(JSON.stringify(input)) as MemoryWriteInput;
		if (!("value" in snapshot)) throw new Error("Memory value must be JSON");
		const hash = await hashValue(snapshot.value);
		const fact = await this.fact(snapshot.key);
		const revisions = fact ? await this.revisions(fact) : [];
		const revision: MemoryRevision = {
			key: snapshot.key,
			revisionId: JSON.stringify([snapshot.key, crypto.randomUUID()]),
			revision: revisions.length + 1,
			value: snapshot.value,
			hash,
			writtenAt: new Date().toISOString(),
			provenance: snapshot.provenance,
			review: snapshot.review ?? "pending",
			...(rolledBackFrom ? { rolledBackFrom } : {}),
		};
		revisions.push(revision);
		const updates = {
			content: contentFor(snapshot.value),
			reviewStatus: factStatus[revision.review],
			updatedAt: revision.writtenAt,
		};
		if (fact) await this.save(fact, revisions, updates);
		else
			await this.db.insert(memoryFacts).values({
				id: snapshot.key,
				organizationId: this.organizationId,
				...updates,
				factType: "technical",
				memoryScope: "org",
				visibility: "org",
				source: snapshot.provenance.source.surface,
				metadata: {
					memoryAdapterRevisions: JSON.parse(
						JSON.stringify(revisions),
					) as JsonValue,
				},
			});
		return revision;
	}
	write(input: MemoryWriteInput): Promise<MemoryRevision> {
		return this.append(input);
	}
	async read(key: string): Promise<MemoryEntry | null> {
		const fact = await this.fact(key);
		return fact ? this.entry(fact) : null;
	}
	async history(key: string): Promise<MemoryRevision[]> {
		const fact = await this.fact(key);
		return fact ? this.revisions(fact) : [];
	}
	async list(prefix = ""): Promise<MemoryEntry[]> {
		const entries: MemoryEntry[] = [];
		// The contract returns all matching keys. Enumerate with bounded index
		// seeks, including NULL sources separately to retain tuple ordering.
		for (const nullSource of [true, false]) {
			let cursor: MemoryFact | undefined;
			while (true) {
				const page: MemoryFact[] = await this.db
					.select(prefixedColumns(memoryFacts, "fact"))
					.from(bySource)
					.where(
						and(
							eq(memoryFacts.organizationId, this.organizationId),
							nullSource
								? isNull(memoryFacts.source)
								: sql`${memoryFacts.source} >= ''`,
							cursor
								? nullSource
									? sql`${memoryFacts.id} > ${cursor.id}`
									: sql`(${memoryFacts.source}, ${memoryFacts.id}) > (${cursor.source}, ${cursor.id})`
								: undefined,
						),
					)
					.orderBy(asc(memoryFacts.source), asc(memoryFacts.id))
					.limit(100);
				for (const fact of page)
					if (fact.id.startsWith(prefix)) entries.push(await this.entry(fact));
				if (page.length < 100) break;
				cursor = page.at(-1);
			}
		}
		return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}
	private revisionKey(revisionId: string): string | undefined {
		try {
			const value: unknown = JSON.parse(revisionId);
			return Array.isArray(value) && typeof value[0] === "string"
				? value[0]
				: undefined;
		} catch {
			return undefined;
		}
	}
	async review(
		revisionId: string,
		decision: "approve" | "reject",
		reviewer: Actor,
		note?: string,
	): Promise<MemoryRevision> {
		const key = this.revisionKey(revisionId);
		const fact = key === undefined ? undefined : await this.fact(key);
		const revisions = fact ? await this.revisions(fact) : [];
		const revision = revisions.find((r) => r.revisionId === revisionId);
		if (!fact || !revision)
			throw new Error(`Unknown memory revision ${revisionId}`);
		if (revision.review !== "pending")
			throw new Error(`Revision ${revisionId} was already ${revision.review}`);
		revision.review = decision === "approve" ? "approved" : "rejected";
		revision.reviewedBy = reviewer.id;
		revision.reviewedAt = new Date().toISOString();
		if (note) revision.reviewNote = note;
		await this.save(
			fact,
			revisions,
			revision === revisions.at(-1)
				? { reviewStatus: factStatus[revision.review] }
				: {},
		);
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
