import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import {
	type NewOsBlueprintRevisionRow,
	type NewOsBlueprintRow,
	type OsBlueprintRevisionRow,
	type OsBlueprintRow,
	osBlueprintRevisions,
	osBlueprints,
} from "../../schema/os-workspaces";
import { getAffectedRows } from "../../utils/d1-result";
import { prefixedColumns } from "../../utils/select";

export interface OsBlueprintScopeParams {
	organizationId: string;
	blueprintId: string;
}

export interface ListOsBlueprintsOptions {
	status?: OsBlueprintRow["status"];
	limit?: number;
}

export interface UpdateOsBlueprintPatch {
	name?: string;
	description?: string | null;
	status?: OsBlueprintRow["status"];
	visibility?: OsBlueprintRow["visibility"];
}

export interface CreateOsBlueprintRevisionParams {
	/** Caller-generated UUID for the new revision row. */
	id: string;
	organizationId: string;
	blueprintId: string;
	/** JSON string (`OsBlueprintDefinition`): declared gadgets plus the version-pinned `requirements` declaration. */
	definition: string;
	createdByKind: OsBlueprintRevisionRow["createdByKind"];
	createdById: string;
	/**
	 * Optimistic concurrency guard: when set, the write lands only if the
	 * blueprint's highest revision still equals this value.
	 */
	expectedRevision?: number;
}

export type CreateOsBlueprintRevisionResult =
	| { ok: true; revision: OsBlueprintRevisionRow }
	| { ok: false; reason: "blueprint_not_found" | "revision_conflict" };

export type PublishOsBlueprintRevisionResult =
	| { ok: true; blueprint: OsBlueprintRow }
	| { ok: false; reason: "revision_not_found" };

export type OsBlueprintVisibility = OsBlueprintRow["visibility"];

/** One cross-organization gallery listing row; nothing beyond these fields crosses the tenant boundary. */
export interface CatalogOsBlueprintListing {
	blueprint: OsBlueprintRow;
	/** The owning organization's display name. */
	organizationName: string;
	/** Gadget count declared by the current published revision's definition. */
	gadgetCount: number;
	/** `published_at` of the current revision; null when the stamp is missing. */
	publishedAt: string | null;
}

export interface CatalogOsBlueprintSource {
	blueprint: OsBlueprintRow;
	/** The owning organization's display name (for provenance). */
	organizationName: string;
}

export async function createOsBlueprint(
	db: DbQueryClient,
	blueprint: NewOsBlueprintRow,
): Promise<OsBlueprintRow> {
	const [row] = await db.insert(osBlueprints).values(blueprint).returning();
	if (!row) {
		throw new Error("OS blueprint insert returned no row");
	}
	return row;
}

export async function getOsBlueprint(
	db: DbQueryClient,
	params: OsBlueprintScopeParams,
): Promise<OsBlueprintRow | undefined> {
	const [row] = await db
		.select()
		.from(osBlueprints)
		.where(
			and(
				eq(osBlueprints.organizationId, params.organizationId),
				eq(osBlueprints.id, params.blueprintId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsBlueprints(
	db: DbQueryClient,
	organizationId: string,
	options: ListOsBlueprintsOptions = {},
): Promise<OsBlueprintRow[]> {
	const conditions = [eq(osBlueprints.organizationId, organizationId)];
	if (options.status) {
		conditions.push(eq(osBlueprints.status, options.status));
	}
	return db
		.select()
		.from(osBlueprints)
		.where(and(...conditions))
		.orderBy(asc(osBlueprints.name))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 500));
}

export async function updateOsBlueprint(
	db: DbQueryClient,
	params: OsBlueprintScopeParams,
	patch: UpdateOsBlueprintPatch,
): Promise<OsBlueprintRow | undefined> {
	const [row] = await db
		.update(osBlueprints)
		.set({ ...patch, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osBlueprints.organizationId, params.organizationId),
				eq(osBlueprints.id, params.blueprintId),
			),
		)
		.returning();
	return row;
}

export async function deleteOsBlueprint(
	db: DbQueryClient,
	params: OsBlueprintScopeParams,
): Promise<boolean> {
	const result = await db
		.delete(osBlueprints)
		.where(
			and(
				eq(osBlueprints.organizationId, params.organizationId),
				eq(osBlueprints.id, params.blueprintId),
			),
		);
	return getAffectedRows(result) > 0;
}

export interface ImportOsBlueprintParams {
	/** New blueprint row with `currentRevisionId` preset to the revision's id. */
	blueprint: NewOsBlueprintRow;
	/** Revision-1 row whose id matches the preset pointer. */
	revision: NewOsBlueprintRevisionRow;
}

/**
 * Persist an imported blueprint and its revision 1 atomically.
 *
 * Both rows ride ONE `db.batch()` (D1 has no `BEGIN`; `batch` IS the
 * transaction primitive), so a lost unique-name race fails the batch and leaves
 * nothing behind — never an empty blueprint with no revision. The caller maps
 * the violation to CONFLICT. `definition` must already be the serialization of a
 * PARSED definition; this statement owns storage, not validation.
 */
export async function importOsBlueprint(
	db: DbQueryClient,
	params: ImportOsBlueprintParams,
): Promise<{ blueprint: OsBlueprintRow; revision: OsBlueprintRevisionRow }> {
	const [blueprintRows, revisionRows] = await db.batch([
		db.insert(osBlueprints).values(params.blueprint).returning(),
		db.insert(osBlueprintRevisions).values(params.revision).returning(),
	]);
	const blueprint = blueprintRows[0];
	const revision = revisionRows[0];
	if (!blueprint || !revision) {
		throw new Error("OS blueprint import returned no row");
	}
	return { blueprint, revision };
}

export async function getOsBlueprintRevision(
	db: DbQueryClient,
	params: { organizationId: string; revisionId: string },
): Promise<OsBlueprintRevisionRow | undefined> {
	const [row] = await db
		.select()
		.from(osBlueprintRevisions)
		.where(
			and(
				eq(osBlueprintRevisions.organizationId, params.organizationId),
				eq(osBlueprintRevisions.id, params.revisionId),
			),
		)
		.limit(1);
	return row;
}

export async function listOsBlueprintRevisions(
	db: DbQueryClient,
	params: OsBlueprintScopeParams,
	options: { limit?: number } = {},
): Promise<OsBlueprintRevisionRow[]> {
	return db
		.select()
		.from(osBlueprintRevisions)
		.where(
			and(
				eq(osBlueprintRevisions.organizationId, params.organizationId),
				eq(osBlueprintRevisions.blueprintId, params.blueprintId),
			),
		)
		.orderBy(desc(osBlueprintRevisions.revision))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}

/**
 * Append the next blueprint revision and advance `current_revision_id`,
 * atomically, mirroring `createOsGadgetRevision`: one `db.batch()` whose
 * insert is an `INSERT ... SELECT` sourced from the blueprint row (existence +
 * tenant scope + optional expected-revision CAS all inside the statement), and
 * whose pointer update is fenced on `changes() = 1`. A CAS miss is a typed
 * result, not a throw.
 */
export async function createOsBlueprintRevision(
	db: DbQueryClient,
	params: CreateOsBlueprintRevisionParams,
): Promise<CreateOsBlueprintRevisionResult> {
	const now = new Date().toISOString();
	const currentMaxRevision = sql<number>`coalesce((select max(${osBlueprintRevisions.revision}) from ${osBlueprintRevisions} where ${osBlueprintRevisions.blueprintId} = ${params.blueprintId}), 0)`;
	const sourceConditions = [
		eq(osBlueprints.id, params.blueprintId),
		eq(osBlueprints.organizationId, params.organizationId),
	];
	if (params.expectedRevision !== undefined) {
		sourceConditions.push(
			sql`${currentMaxRevision} = ${params.expectedRevision}`,
		);
	}
	const insertRevision = db
		.insert(osBlueprintRevisions)
		.select(
			db
				.select({
					id: sql<string>`${params.id}`.as("id"),
					organizationId: sql<string>`${params.organizationId}`.as(
						"organization_id",
					),
					blueprintId: sql<string>`${params.blueprintId}`.as("blueprint_id"),
					revision: sql<number>`${currentMaxRevision} + 1`.as("revision"),
					definition: sql<string>`${params.definition}`.as("definition"),
					createdByKind: sql<
						OsBlueprintRevisionRow["createdByKind"]
					>`${params.createdByKind}`.as("created_by_kind"),
					createdById: sql<string>`${params.createdById}`.as("created_by_id"),
					createdAt: sql<string>`${now}`.as("created_at"),
					publishedAt: sql<string | null>`null`.as("published_at"),
				})
				.from(osBlueprints)
				.where(and(...sourceConditions)),
		)
		.returning();
	const advancePointer = db
		.update(osBlueprints)
		.set({ currentRevisionId: params.id, updatedAt: now })
		.where(
			and(
				eq(osBlueprints.id, params.blueprintId),
				eq(osBlueprints.organizationId, params.organizationId),
				sql`changes() = 1`,
			),
		);
	const [revisionRows] = await db.batch([insertRevision, advancePointer]);
	const revision = revisionRows[0];
	if (revision) {
		return { ok: true, revision };
	}
	const blueprint = await getOsBlueprint(db, {
		organizationId: params.organizationId,
		blueprintId: params.blueprintId,
	});
	return {
		ok: false,
		reason: blueprint ? "revision_conflict" : "blueprint_not_found",
	};
}

/**
 * Mark one revision published and move the blueprint to `published` with its
 * pointer on that revision. One `db.batch()`: the revision stamp lands first,
 * and the blueprint update is fenced on `changes() = 1` so it applies only
 * when the revision exists in this organization under this blueprint.
 */
export async function publishOsBlueprintRevision(
	db: DbQueryClient,
	params: {
		organizationId: string;
		blueprintId: string;
		revisionId: string;
	},
): Promise<PublishOsBlueprintRevisionResult> {
	const now = new Date().toISOString();
	const stampRevision = db
		.update(osBlueprintRevisions)
		.set({ publishedAt: now })
		.where(
			and(
				eq(osBlueprintRevisions.organizationId, params.organizationId),
				eq(osBlueprintRevisions.blueprintId, params.blueprintId),
				eq(osBlueprintRevisions.id, params.revisionId),
			),
		);
	const publishBlueprint = db
		.update(osBlueprints)
		.set({
			status: "published",
			currentRevisionId: params.revisionId,
			updatedAt: now,
		})
		.where(
			and(
				eq(osBlueprints.organizationId, params.organizationId),
				eq(osBlueprints.id, params.blueprintId),
				sql`changes() = 1`,
			),
		)
		.returning();
	const [, blueprintRows] = await db.batch([stampRevision, publishBlueprint]);
	const blueprint = blueprintRows[0];
	if (!blueprint) {
		return { ok: false, reason: "revision_not_found" };
	}
	return { ok: true, blueprint };
}

/**
 * Set catalog visibility on one blueprint, tenant-scoped. Lifecycle gating
 * (only a published blueprint may change visibility) belongs to the caller —
 * this statement owns only the tenant-bound write.
 */
export async function setOsBlueprintVisibility(
	db: DbQueryClient,
	params: OsBlueprintScopeParams,
	visibility: OsBlueprintVisibility,
): Promise<OsBlueprintRow | undefined> {
	const [row] = await db
		.update(osBlueprints)
		.set({ visibility, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(osBlueprints.organizationId, params.organizationId),
				eq(osBlueprints.id, params.blueprintId),
			),
		)
		.returning();
	return row;
}

/**
 * The cross-organization blueprint gallery: catalog-visible AND published
 * blueprints only, joined with the owning organization's display name and the
 * current revision's declared gadget count. Deliberately NOT tenant-scoped —
 * every selected field is safe to show to any authenticated tenant.
 *
 * The join select uses `prefixedColumns` plus explicit aliases so no two
 * output columns share a name (the D1 batch-composition rule).
 */
export async function listCatalogOsBlueprints(
	db: DbQueryClient,
	options: { limit?: number } = {},
): Promise<CatalogOsBlueprintListing[]> {
	return db
		.select({
			blueprint: prefixedColumns(osBlueprints, "blueprint"),
			organizationName: sql<string>`${organizations.name}`.as(
				"organization_name",
			),
			gadgetCount:
				sql<number>`coalesce(json_array_length(${osBlueprintRevisions.definition}, '$.gadgets'), 0)`.as(
					"gadget_count",
				),
			publishedAt: sql<string | null>`${osBlueprintRevisions.publishedAt}`.as(
				"revision_published_at",
			),
		})
		.from(osBlueprints)
		.innerJoin(organizations, eq(organizations.id, osBlueprints.organizationId))
		.innerJoin(
			osBlueprintRevisions,
			eq(osBlueprintRevisions.id, osBlueprints.currentRevisionId),
		)
		.where(
			and(
				eq(osBlueprints.visibility, "catalog"),
				eq(osBlueprints.status, "published"),
			),
		)
		.orderBy(desc(osBlueprints.updatedAt), asc(osBlueprints.id))
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}

/**
 * Resolve one blueprint across organizations, but ONLY when its owning
 * organization explicitly published it to the catalog: the
 * `visibility = 'catalog' AND status = 'published'` predicate is the tenant
 * boundary here, so a private blueprint from another organization resolves to
 * `undefined` exactly like a nonexistent id.
 */
export async function getCatalogOsBlueprint(
	db: DbQueryClient,
	blueprintId: string,
): Promise<CatalogOsBlueprintSource | undefined> {
	const [row] = await db
		.select({
			blueprint: prefixedColumns(osBlueprints, "blueprint"),
			organizationName: sql<string>`${organizations.name}`.as(
				"organization_name",
			),
		})
		.from(osBlueprints)
		.innerJoin(organizations, eq(organizations.id, osBlueprints.organizationId))
		.where(
			and(
				eq(osBlueprints.id, blueprintId),
				eq(osBlueprints.visibility, "catalog"),
				eq(osBlueprints.status, "published"),
			),
		)
		.limit(1);
	return row;
}

// A gallery import's blueprint copy is NOT written here: it rides the same
// `db.batch()` as the workspace it instantiates (`instantiateOsBlueprint`'s
// `blueprintCopy`), so a lost workspace-name race can no longer leave an orphan
// blueprint committed in the importing organization.
