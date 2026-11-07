/**
 * TenantStore: one SQLite Durable Object per workspace.
 *
 * The object migrates its own database when it wakes, binds itself to the
 * first scope it serves, and rejects any other scope afterwards. Domain RPC
 * methods (outputs, runs, memory) are added by the tenant-port stories; each
 * one must start with `this.bindScope(scope)`.
 */
import { DurableObject } from "cloudflare:workers";
import { eq, getColumns } from "drizzle-orm";
import {
	drizzle,
	type DrizzleSqliteDODatabase,
} from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { tenantStoreMigrations } from "./migrations";
import {
	tediExpertise,
	tediCuriosityQueue,
	tediOptimizationSignals,
} from "./memory-schema/memory-state";
import {
	executeMemoryQuery,
	type MemoryQuery,
} from "../queries/memory-graph/tenant-rpc";
import { selectMemoryStore } from "../queries/memory-graph/tenant-store";
import {
	memoryDomains,
	memoryFacts,
	memoryEdges,
} from "./memory-schema/memory-graph";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityAliases,
	memoryEntityResolutionHeads,
	memoryEntityResolutionDecisions,
	memoryEntityResolutions,
} from "./memory-schema/memory-entities";
import {
	memoryFactCitations,
	memoryFactCitationBackfills,
} from "./memory-schema/memory-fact-citations";
import {
	requireWorkspaceScope,
	tenantStoreName,
	type WorkspaceTenantScope,
} from "./router";
import { tenantStoreIdentity, tenantStoreImportBatches } from "./schema";
import {
	tenantOsOutputRevisions,
	tenantOsOutputs,
	tenantOsWorkspaces,
} from "./outputs-schema";
import type { TenantScope } from "../tenant-scope";

/** Rows per import call; each row is one statement inside one transaction. */
export const TENANT_STORE_IMPORT_MAX_ROWS = 1000;

/** A raw SQLite row keyed by SQL column name, as the copy pipeline reads it. */
export type TenantStoreImportRow = Record<
	string,
	string | number | null | ArrayBuffer
>;

export interface TenantStoreImportBatch {
	/** Stable per source chunk; a repeated ID returns the first receipt. */
	batchId: string;
	/** SQL name of a table in the store definition's `importTables`. */
	table: string;
	rows: TenantStoreImportRow[];
}

export interface TenantStoreImportResult {
	batchId: string;
	table: string;
	rowCount: number;
	status: "imported" | "duplicate";
}

/** The one workspace an object serves and when it was first bound. */
export interface TenantStoreIdentity extends WorkspaceTenantScope {
	createdAt: string;
}

export interface TenantStoreDescription extends TenantStoreIdentity {
	migrations: string[];
}

/** Schema chain and import targets one TenantStore class serves. */
export interface TenantStoreDefinition {
	migrations: Record<string, string>;
	/** Tables the migration pipeline may bulk-load, keyed by SQL table name. */
	importTables: Record<string, SQLiteTable>;
}

/** Tenant ports register their tables here as they land. */
export const tenantStoreDefinition: TenantStoreDefinition = {
	migrations: tenantStoreMigrations,
	importTables: {
		os_workspaces: tenantOsWorkspaces,
		os_outputs: tenantOsOutputs,
		os_output_revisions: tenantOsOutputRevisions,
		memory_domains: memoryDomains,
		tedi_expertise: tediExpertise,
		tedi_curiosity_queue: tediCuriosityQueue,
		tedi_optimization_signals: tediOptimizationSignals,
		memory_facts: memoryFacts,
		memory_edges: memoryEdges,
		memory_entities: memoryEntities,
		memory_entity_mentions: memoryEntityMentions,
		memory_entity_aliases: memoryEntityAliases,
		memory_entity_resolution_heads: memoryEntityResolutionHeads,
		memory_entity_resolution_decisions: memoryEntityResolutionDecisions,
		memory_entity_resolutions: memoryEntityResolutions,
		memory_fact_citations: memoryFactCitations,
		memory_fact_citation_backfills: memoryFactCitationBackfills,
	},
};

/** Scope columns that imported rows must match when a table has them. */
const SCOPE_COLUMNS = {
	organization_id: "organizationId",
	org_id: "organizationId",
	workspace_id: "workspaceId",
} as const satisfies Record<string, keyof WorkspaceTenantScope>;

export class TenantStore<Env = unknown> extends DurableObject<Env> {
	protected readonly db: DrizzleSqliteDODatabase;
	readonly #definition: TenantStoreDefinition;

	constructor(
		ctx: DurableObjectState,
		env: Env,
		definition: TenantStoreDefinition = tenantStoreDefinition,
	) {
		super(ctx, env);
		this.#definition = definition;
		this.db = drizzle(ctx.storage);
		// Migrate on wake; no request runs against an old schema.
		void ctx.blockConcurrencyWhile(async () => {
			migrate(this.db, { migrations: definition.migrations });
		});
	}

	memory(scope: TenantScope, query: MemoryQuery): Promise<unknown> {
		const bound = this.bindScope(scope);
		return executeMemoryQuery(
			selectMemoryStore({
				plane: "do-local-sqlite",
				storage: this.ctx.storage,
			}),
			bound,
			query,
		);
	}

	/** The bound scope, creation time and applied migrations. */
	describe(scope: TenantScope): TenantStoreDescription {
		const identity = this.bindScope(scope);
		const migrations = this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM __drizzle_migrations ORDER BY id",
			)
			.toArray()
			.map((row) => row.name);
		return { ...identity, migrations };
	}

	/**
	 * Load one chunk of rows copied from the current store, all or nothing.
	 * Values are written as stored (no Drizzle mapping), so JSON and boolean
	 * columns keep their source encoding.
	 */
	importRows(
		scope: TenantScope,
		batch: TenantStoreImportBatch,
	): TenantStoreImportResult {
		const bound = this.bindScope(scope);
		if (!batch.batchId?.trim()) {
			throw new Error("TenantStore import requires batchId");
		}
		const table = this.#definition.importTables[batch.table];
		if (!table) {
			throw new Error(`TenantStore cannot import table ${batch.table}`);
		}
		if (batch.rows.length > TENANT_STORE_IMPORT_MAX_ROWS) {
			throw new Error(
				`TenantStore import batch exceeds ${TENANT_STORE_IMPORT_MAX_ROWS} rows`,
			);
		}

		const receipt = this.db
			.select()
			.from(tenantStoreImportBatches)
			.where(eq(tenantStoreImportBatches.batchId, batch.batchId))
			.get();
		if (receipt) {
			if (receipt.tableName !== batch.table) {
				throw new Error(
					`TenantStore import batch ${batch.batchId} was already used for ${receipt.tableName}`,
				);
			}
			return {
				batchId: receipt.batchId,
				table: receipt.tableName,
				rowCount: receipt.rowCount,
				status: "duplicate",
			};
		}

		const { name: tableName } = getTableConfig(table);
		const knownColumns = new Set(
			Object.values(getColumns(table)).map((column) => column.name),
		);
		const statements = batch.rows.map((row) =>
			buildInsert(tableName, knownColumns, bound, row),
		);
		const importedAt = new Date().toISOString();
		this.ctx.storage.transactionSync(() => {
			for (const { query, values } of statements) {
				this.ctx.storage.sql.exec(query, ...values);
			}
			this.db
				.insert(tenantStoreImportBatches)
				.values({
					batchId: batch.batchId,
					tableName: batch.table,
					rowCount: statements.length,
					importedAt,
				})
				.run();
		});
		return {
			batchId: batch.batchId,
			table: batch.table,
			rowCount: statements.length,
			status: "imported",
		};
	}

	/**
	 * Bind this object to its first scope and reject any other scope.
	 * Every RPC method must call this before touching data.
	 */
	protected bindScope(scope: TenantScope): TenantStoreIdentity {
		const requested = requireWorkspaceScope(scope);
		const expectedName = this.ctx.id.name;
		if (
			expectedName !== undefined &&
			expectedName !== tenantStoreName(requested)
		) {
			throw new Error("TenantStore scope does not match this object");
		}
		let identity = this.db.select().from(tenantStoreIdentity).get();
		if (!identity) {
			identity = {
				slot: 1,
				...requested,
				createdAt: new Date().toISOString(),
			};
			this.db.insert(tenantStoreIdentity).values(identity).run();
		}
		if (
			identity.organizationId !== requested.organizationId ||
			identity.workspaceId !== requested.workspaceId
		) {
			throw new Error("TenantStore scope does not match this object");
		}
		return {
			organizationId: identity.organizationId,
			workspaceId: identity.workspaceId,
			createdAt: identity.createdAt,
		};
	}
}

function buildInsert(
	tableName: string,
	knownColumns: ReadonlySet<string>,
	scope: WorkspaceTenantScope,
	row: TenantStoreImportRow,
): { query: string; values: (string | number | null | ArrayBuffer)[] } {
	const columns = Object.keys(row);
	if (columns.length === 0) {
		throw new Error(`TenantStore import row for ${tableName} is empty`);
	}
	for (const column of columns) {
		if (!knownColumns.has(column)) {
			throw new Error(
				`TenantStore import: ${tableName} has no column ${column}`,
			);
		}
		const value = row[column];
		if (
			value !== null &&
			typeof value !== "string" &&
			typeof value !== "number" &&
			!(value instanceof ArrayBuffer)
		) {
			throw new Error(
				`TenantStore import: ${tableName}.${column} has an unsupported value`,
			);
		}
	}
	for (const [column, key] of Object.entries(SCOPE_COLUMNS)) {
		if (knownColumns.has(column) && row[column] !== scope[key]) {
			throw new Error(
				`TenantStore import: ${tableName}.${column} is outside this workspace`,
			);
		}
	}
	return {
		query: `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		values: columns.map((column) => row[column] ?? null),
	};
}
