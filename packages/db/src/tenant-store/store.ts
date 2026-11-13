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
import {
	tenantStoreIdentity,
	tenantStoreImportBatches,
	memoryStoreIdentity,
} from "./schema";
import { memoryOwnerId, memoryStoreName } from "./memory-owner";
import {
	MemoryOwnerScopeSchema,
	type MemoryOwnerScope,
} from "@tedix/api-contract/schemas/memory-graph";
import {
	tenantKernelConversations,
	tenantKernelRuntimeEvents,
	tenantKernelRuntimeRuns,
	tenantKernelToolResults,
	tenantTediArtifacts,
} from "./chat-schema";
import {
	tenantOsOutputRevisions,
	tenantOsOutputs,
	tenantOsWorkspaceResources,
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

export interface TenantStoreDeltaBatch {
	batchId: string;
	table: string;
	changes: Array<{
		before: TenantStoreImportRow | null;
		after: TenantStoreImportRow | null;
	}>;
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
		os_workspace_resources: tenantOsWorkspaceResources,
		kernel_conversations: tenantKernelConversations,
		kernel_runtime_runs: tenantKernelRuntimeRuns,
		kernel_runtime_events: tenantKernelRuntimeEvents,
		kernel_tool_results: tenantKernelToolResults,
		tedi_artifacts: tenantTediArtifacts,
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

	/** Internal data RPC; gateway callers must authorize the owner and fact policy first. */
	ownedMemory(
		requested: MemoryOwnerScope,
		query: MemoryQuery,
	): Promise<unknown> {
		const owner = MemoryOwnerScopeSchema.parse(requested);
		if (this.ctx.id.name !== memoryStoreName(owner))
			throw new Error("Memory owner does not match this object");
		if (this.db.select().from(tenantStoreIdentity).get())
			throw new Error("Workspace data cannot be reclassified as owned memory");
		const identity = this.db.select().from(memoryStoreIdentity).get();
		if (identity) {
			if (
				identity.organizationId !== owner.organizationId ||
				identity.kind !== owner.kind ||
				identity.ownerId !== memoryOwnerId(owner)
			)
				throw new Error("Memory owner does not match the stored identity");
		} else {
			this.db
				.insert(memoryStoreIdentity)
				.values({
					slot: 1,
					organizationId: owner.organizationId,
					kind: owner.kind,
					ownerId: memoryOwnerId(owner),
					createdAt: new Date().toISOString(),
				})
				.run();
		}
		return executeMemoryQuery(
			selectMemoryStore({
				plane: "do-local-sqlite",
				storage: this.ctx.storage,
			}),
			{ organizationId: owner.organizationId },
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
	async importRows(
		scope: TenantScope,
		batch: TenantStoreImportBatch,
	): Promise<TenantStoreImportResult> {
		return this.importRowsSync(scope, batch);
	}

	/** Subclasses can atomically commit migration state with the imported rows. */
	protected importRowsSync(
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

	/** A frozen-source delta may replace only the exact staged rows it names. */
	protected applyImportDeltaSync(
		scope: TenantScope,
		batch: TenantStoreDeltaBatch,
		beforeWrite: () => void,
	): TenantStoreImportResult {
		const bound = this.bindScope(scope);
		const table = this.#definition.importTables[batch.table];
		if (
			!table ||
			!batch.batchId?.trim() ||
			!Array.isArray(batch.changes) ||
			batch.changes.length < 1 ||
			batch.changes.length > TENANT_STORE_IMPORT_MAX_ROWS
		)
			throw new Error("Invalid tenant delta batch");
		const config = getTableConfig(table);
		if (!config.columns.some((c) => c.name === "id" && c.primary))
			throw new Error("Delta requires an id primary key");
		const receipt = this.db
			.select()
			.from(tenantStoreImportBatches)
			.where(eq(tenantStoreImportBatches.batchId, batch.batchId))
			.get();
		if (receipt) {
			if (receipt.tableName !== batch.table)
				throw new Error("Delta batch id belongs to another table");
			return {
				batchId: batch.batchId,
				table: batch.table,
				rowCount: receipt.rowCount,
				status: "duplicate",
			};
		}
		const columns = new Set(config.columns.map((c) => c.name));
		const ids = new Set<string>();
		const changes = batch.changes.map(({ before, after }) => {
			const id = (before ?? after)?.id;
			if (
				typeof id !== "string" ||
				!id ||
				ids.has(id) ||
				(before && after && before.id !== after.id)
			)
				throw new Error("Delta requires unique stable row ids");
			ids.add(id);
			for (const row of [before, after]) {
				if (!row) continue;
				buildInsert(config.name, columns, bound, row);
				if (Object.keys(row).length !== columns.size)
					throw new Error("Delta requires full rows from matching schemas");
			}
			return { id, before, after };
		});
		return this.ctx.storage.transactionSync(() => {
			beforeWrite();
			for (const { id, before, after } of changes) {
				const current = this.ctx.storage.sql
					.exec<TenantStoreImportRow>(
						`SELECT * FROM "${config.name}" WHERE id = ?`,
						id,
					)
					.toArray()[0];
				if (
					before
						? !current ||
							[...columns].some((c) => !sameImportValue(before[c], current[c]))
						: current !== undefined
				)
					throw new Error(`Delta conflict in ${batch.table} row ${id}`);
				if (before && after) {
					const names = [...columns].filter((name) => name !== "id");
					this.ctx.storage.sql.exec(
						`UPDATE "${config.name}" SET ${names.map((name) => `"${name}" = ?`).join(", ")} WHERE id = ?`,
						...names.map((name) => after[name] ?? null),
						id,
					);
				} else if (before) {
					// Children absent from the source bundle may be native; never cascade into them.
					for (const child of Object.values(this.#definition.importTables)) {
						const childConfig = getTableConfig(child);
						for (const key of childConfig.foreignKeys) {
							const ref = key.reference();
							if (getTableConfig(ref.foreignTable).name !== config.name)
								continue;
							const found = this.ctx.storage.sql
								.exec(
									`SELECT 1 AS present FROM "${childConfig.name}" WHERE ${ref.columns.map((column) => `"${column.name}" = ?`).join(" AND ")} LIMIT 1`,
									...ref.foreignColumns.map(
										(column) => before[column.name] ?? null,
									),
								)
								.toArray();
							if (found.length)
								throw new Error(
									`Delta deletion has remaining dependents in ${childConfig.name}`,
								);
						}
					}
					this.ctx.storage.sql.exec(
						`DELETE FROM "${config.name}" WHERE id = ?`,
						id,
					);
				} else if (after) {
					const insert = buildInsert(config.name, columns, bound, after);
					this.ctx.storage.sql.exec(insert.query, ...insert.values);
				}
			}
			this.db
				.insert(tenantStoreImportBatches)
				.values({
					batchId: batch.batchId,
					tableName: batch.table,
					rowCount: changes.length,
					importedAt: new Date().toISOString(),
				})
				.run();
			return {
				batchId: batch.batchId,
				table: batch.table,
				rowCount: changes.length,
				status: "imported",
			};
		});
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

function sameImportValue(a: unknown, b: unknown): boolean {
	if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
		const left = new Uint8Array(a),
			right = new Uint8Array(b);
		return left.length === right.length && left.every((v, i) => v === right[i]);
	}
	return a === b;
}
