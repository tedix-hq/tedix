import type {
	PortableTediDomainSchema,
	PortableTediEdgeSchema,
	PortableTediFactSchema,
	PortableTediRationaleSchema,
	PortableTediSkillSchema,
} from "@tedix/api-contract/schemas/portable-tedi";
import { portableTediDestinationId } from "@tedix/api-contract/utils/portable-tedi";
import type * as z from "zod";
import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { assertBulkFactAdmission } from "../memory-graph/facts";
import { skillEntries } from "../../schema/cognitive";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../../schema/memory-graph";
import { tediRationaleRecords } from "../../schema/rationale-records";
import { batchNonEmpty } from "../../utils/batch";

type Domain = z.infer<typeof PortableTediDomainSchema>;
type Fact = z.infer<typeof PortableTediFactSchema>;
type Edge = z.infer<typeof PortableTediEdgeSchema>;
type Skill = z.infer<typeof PortableTediSkillSchema>;
type Rationale = z.infer<typeof PortableTediRationaleSchema>;

export interface PortableTediImportTarget {
	organizationId: string;
	tediId: string;
	tediSlug: string;
	sourceTediId: string;
}

const MAX_PAGE_ROWS = 100;
// D1 permits at most 100 bound parameters per statement. Skill and fact rows
// have dozens of columns, so two rows stay inside that ceiling.
const INSERT_CHUNK_ROWS = 2;

function chunks<T>(rows: T[]): T[][] {
	if (rows.length > MAX_PAGE_ROWS) {
		throw new RangeError("Portable import page exceeds 100 rows");
	}
	const groups: T[][] = [];
	for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
		groups.push(rows.slice(start, start + INSERT_CHUNK_ROWS));
	}
	return groups;
}

const mappedId = (
	target: PortableTediImportTarget,
	section:
		| "memoryDomains"
		| "memoryFacts"
		| "memoryEdges"
		| "skills"
		| "rationale",
	id: string,
) => portableTediDestinationId(target.tediId, section, id);

/** Domain names are org-unique, so imported names live under the new tedi slug. */
export async function insertPortableTediDomainsPage(
	db: DbQueryClient,
	target: PortableTediImportTarget,
	rows: Domain[],
): Promise<number> {
	const mapped: Array<typeof memoryDomains.$inferInsert> = await Promise.all(
		rows.map(async (row) => ({
			...row,
			id: await mappedId(target, "memoryDomains", row.id),
			organizationId: target.organizationId,
			name: `${target.tediSlug}/${row.name}`,
			parentId: row.parentId
				? await mappedId(target, "memoryDomains", row.parentId)
				: null,
		})),
	);
	const statements = chunks(mapped).map((group) =>
		db
			.insert(memoryDomains)
			.values(group)
			.onConflictDoNothing({ target: memoryDomains.id }),
	);
	if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	return rows.length;
}

/** Imported facts stay private to the destination tedi. Projection IDs rebuild. */
export async function insertPortableTediFactsPage(
	db: DbQueryClient,
	target: PortableTediImportTarget,
	rows: Fact[],
	operatorAuthority: boolean,
): Promise<number> {
	assertBulkFactAdmission(rows.length, { operatorAuthority });
	const mapped: Array<typeof memoryFacts.$inferInsert> = await Promise.all(
		rows.map(async (row) => ({
			...row,
			id: await mappedId(target, "memoryFacts", row.id),
			organizationId: target.organizationId,
			tediId: target.tediId,
			domainId: row.domainId
				? await mappedId(target, "memoryDomains", row.domainId)
				: null,
			promotedFrom: row.promotedFrom
				? await mappedId(target, "memoryFacts", row.promotedFrom)
				: null,
			embeddingId: null,
			memoryScope: "tedi" as const,
			visibility: "private" as const,
			factType: row.factType as (typeof memoryFacts.$inferInsert)["factType"],
		})),
	);
	const statements = chunks(mapped).map((group) =>
		db
			.insert(memoryFacts)
			.values(group)
			.onConflictDoNothing({ target: memoryFacts.id }),
	);
	if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	return rows.length;
}

export async function insertPortableTediEdgesPage(
	db: DbQueryClient,
	target: PortableTediImportTarget,
	rows: Edge[],
): Promise<number> {
	const mapped: Array<typeof memoryEdges.$inferInsert> = await Promise.all(
		rows.map(async (row) => ({
			...row,
			id: await mappedId(target, "memoryEdges", row.id),
			sourceFactId: await mappedId(target, "memoryFacts", row.sourceFactId),
			targetFactId: await mappedId(target, "memoryFacts", row.targetFactId),
		})),
	);
	const statements = chunks(mapped).map((group) =>
		db
			.insert(memoryEdges)
			.values(group)
			.onConflictDoNothing({ target: memoryEdges.id }),
	);
	if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	return rows.length;
}

/** Source app IDs and tool bindings never become destination authority. */
export async function insertPortableTediSkillsPage(
	db: DbQueryClient,
	target: PortableTediImportTarget,
	rows: Skill[],
): Promise<number> {
	const mapped: Array<typeof skillEntries.$inferInsert> = await Promise.all(
		rows.map(async (row) => ({
			...row,
			id: await mappedId(target, "skills", row.id),
			organizationId: target.organizationId,
			tediId: target.tediId,
			domainId: row.domainId
				? await mappedId(target, "memoryDomains", row.domainId)
				: null,
			slug: row.slug ? `${target.tediSlug}-${row.slug}` : null,
			supersedesId: row.supersedesId
				? await mappedId(target, "skills", row.supersedesId)
				: null,
			// Source-skill FK links are filled in after all skill pages land.
			sourceSkillId: null,
			proposedByTediId:
				row.proposedByTediId === target.sourceTediId ? target.tediId : null,
			appId: null,
			toolIds: null,
			visibility: "private" as const,
		})),
	);
	const statements = chunks(mapped).map((group) =>
		db
			.insert(skillEntries)
			.values(group)
			.onConflictDoNothing({ target: skillEntries.id }),
	);
	if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	return rows.length;
}

/** Run only after all skill rows have landed; self-FK links may point forward. */
export async function linkPortableTediSkillsPage(
	db: DbQueryClient,
	target: PortableTediImportTarget,
	rows: Skill[],
): Promise<number> {
	for (const group of chunks(rows)) {
		const links = await Promise.all(
			group
				.filter((row) => row.sourceSkillId)
				.map(async (row) => ({
					id: await mappedId(target, "skills", row.id),
					sourceSkillId: await mappedId(target, "skills", row.sourceSkillId!),
				})),
		);
		const statements = links.map((link) =>
			db
				.update(skillEntries)
				.set({ sourceSkillId: link.sourceSkillId })
				.where(
					and(
						eq(skillEntries.id, link.id),
						eq(skillEntries.organizationId, target.organizationId),
						eq(skillEntries.tediId, target.tediId),
					),
				),
		);
		if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	}
	return rows.length;
}

/** Rationale links to old runs/Work remain historical text, not live grants. */
export async function insertPortableTediRationalePage(
	db: DbQueryClient,
	target: PortableTediImportTarget,
	rows: Rationale[],
): Promise<number> {
	const mapped: Array<typeof tediRationaleRecords.$inferInsert> =
		await Promise.all(
			rows.map(async (row) => ({
				...row,
				id: await mappedId(target, "rationale", row.id),
				orgId: target.organizationId,
				tediId: target.tediId,
				blameChain: row.blameChain
					? await Promise.all(
							row.blameChain.map(async (entry) => ({
								...entry,
								id:
									entry.id && entry.component === "brain_fact"
										? await mappedId(target, "memoryFacts", entry.id)
										: entry.id && entry.component === "skill"
											? await mappedId(target, "skills", entry.id)
											: entry.id && entry.component === "graph_edge"
												? await mappedId(target, "memoryEdges", entry.id)
												: entry.id,
							})),
						)
					: null,
			})),
		);
	const statements = chunks(mapped).map((group) =>
		db
			.insert(tediRationaleRecords)
			.values(group)
			.onConflictDoNothing({ target: tediRationaleRecords.id }),
	);
	if (statements.length > 0) await db.batch(batchNonEmpty(statements));
	return rows.length;
}
