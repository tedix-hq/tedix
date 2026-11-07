/**
 * The one mapping between today's shared database and a workspace object.
 *
 * Every table a workspace owns after the cutover is listed here once: where
 * its rows come from, which rows belong to one workspace, and how the
 * reconciler orders and hashes them. `export`, `import` and `reconcile` all
 * read this file and nothing else decides what moves.
 *
 * Target tables carry the same SQL names and columns as the source: the
 * workspace object's query leaves (`packages/db/src/queries/durable-sqlite/`)
 * are written against the same Drizzle schema objects as the shared-database
 * leaves. Rows are copied as stored, so JSON and boolean encodings survive.
 *
 * Rows that have no workspace column are tied to one by a join on their
 * conversation (runs, run events, tool results, artifacts) or by the
 * organization's assignment (memory, outputs without a workspace); see
 * {@link WorkspaceAssignments}.
 */

export type MigrationDomain =
	| "outputs"
	| "resources"
	| "chat"
	| "runs"
	| "artifacts"
	| "memory";

/** Where a source table's rows can live before the cutover. */
export type SourceStore = "main" | "logs";

export interface TableMapping {
	/** SQL table name, identical on both sides. */
	table: string;
	domain: MigrationDomain;
	/** Columns that identify a row; also the reconciler's sort order. */
	primaryKey: readonly string[];
	/**
	 * SQL predicate selecting one workspace's rows. `:org` and `:ws` are the
	 * organization and workspace ids; `:conversations` is the list of the
	 * workspace's conversation ids, resolved from the main store first so a
	 * log partition that holds no conversation table still answers. `memory`
	 * tables are organization-wide and are exported only for the
	 * organization's memory home workspace.
	 */
	where: string;
	/**
	 * SQL predicate selecting every row that moves at all, for the
	 * nothing-left-behind total. `:anyConversations` is the list of every
	 * conversation that belongs to some workspace. Rows outside it stay in
	 * the core on purpose (organization Home threads and their runs).
	 */
	moves: string;
	/** Stores to read; `logs` means every log partition as well as main. */
	stores: readonly SourceStore[];
	/**
	 * Columns whose value is rewritten to the owning workspace when the row
	 * is assigned to a workspace it did not name (outputs without a workspace).
	 */
	workspaceColumn?: string;
}

const CONVERSATION_IN_WORKSPACE = "conversation_id IN (:conversations)";
const CONVERSATION_IN_ANY_WORKSPACE = "conversation_id IN (:anyConversations)";

export const WORKSPACE_TABLES: readonly TableMapping[] = [
	{
		// The workspace's own directory row; the core keeps its copy for routing.
		table: "os_workspaces",
		domain: "outputs",
		primaryKey: ["id"],
		where: "organization_id = :org AND id = :ws",
		moves: "1 = 1",
		stores: ["main"],
	},
	{
		table: "os_outputs",
		domain: "outputs",
		primaryKey: ["id"],
		where: "organization_id = :org AND workspace_id = :ws",
		moves: "1 = 1",
		stores: ["main"],
		workspaceColumn: "workspace_id",
	},
	{
		table: "os_output_revisions",
		domain: "outputs",
		primaryKey: ["id"],
		where:
			"organization_id = :org AND output_id IN (SELECT id FROM os_outputs WHERE organization_id = :org AND workspace_id = :ws)",
		moves: "1 = 1",
		stores: ["main"],
	},
	{
		table: "os_workspace_resources",
		domain: "resources",
		primaryKey: ["id"],
		where: "organization_id = :org AND workspace_id = :ws",
		moves: "1 = 1",
		stores: ["main"],
	},
	{
		table: "kernel_conversations",
		domain: "chat",
		primaryKey: ["id"],
		where: "organization_id = :org AND workspace_id = :ws",
		moves: "workspace_id IS NOT NULL",
		stores: ["main"],
	},
	{
		table: "kernel_runtime_runs",
		moves: CONVERSATION_IN_ANY_WORKSPACE,
		domain: "runs",
		primaryKey: ["id"],
		where: `organization_id = :org AND ${CONVERSATION_IN_WORKSPACE}`,
		stores: ["main"],
	},
	{
		table: "kernel_runtime_events",
		moves: CONVERSATION_IN_ANY_WORKSPACE,
		domain: "runs",
		primaryKey: ["id"],
		where: `organization_id = :org AND ${CONVERSATION_IN_WORKSPACE}`,
		stores: ["main", "logs"],
	},
	{
		table: "kernel_tool_results",
		moves: CONVERSATION_IN_ANY_WORKSPACE,
		domain: "runs",
		primaryKey: ["id"],
		where: `organization_id = :org AND ${CONVERSATION_IN_WORKSPACE}`,
		stores: ["main"],
	},
	{
		table: "tedi_artifacts",
		moves: CONVERSATION_IN_ANY_WORKSPACE,
		domain: "artifacts",
		primaryKey: ["id"],
		where: `organization_id = :org AND ${CONVERSATION_IN_WORKSPACE}`,
		stores: ["main"],
	},
	...memoryTables(),
];

/**
 * Memory is organization-wide today (no workspace column). The whole set
 * moves into the organization's memory home workspace; cross-workspace reads
 * go through the gateway after the cutover.
 */
function memoryTables(): TableMapping[] {
	const orgOnly = "organization_id = :org";
	const memory = (
		table: string,
		where: string = orgOnly,
		primaryKey: readonly string[] = ["id"],
	) => ({
		table,
		domain: "memory" as const,
		primaryKey,
		where,
		moves: "1 = 1",
		stores: ["main"] as const,
	});
	// Three tables carry no organization column; their owner row does.
	const viaFacts = (column: string) =>
		`${column} IN (SELECT id FROM memory_facts WHERE organization_id = :org)`;
	return [
		memory("memory_domains"),
		memory("memory_facts"),
		memory("memory_edges", viaFacts("source_fact_id")),
		memory("memory_entities"),
		memory("memory_entity_mentions"),
		memory("memory_entity_aliases"),
		memory("memory_entity_resolution_heads", orgOnly, ["mention_id"]),
		memory("memory_entity_resolution_decisions"),
		memory("memory_entity_resolutions"),
		memory("memory_fact_citations", orgOnly, [
			"consolidated_fact_id",
			"cited_fact_id",
		]),
		memory("memory_fact_citation_backfills", orgOnly, ["organization_id"]),
		memory(
			"tedi_expertise",
			"domain_id IN (SELECT id FROM memory_domains WHERE organization_id = :org)",
		),
		memory("tedi_curiosity_queue"),
		memory("tedi_optimization_signals"),
	];
}

/**
 * Per-organization choices the data cannot make by itself. Written by hand
 * before the cutover and checked into the bundle manifest so the reconciler
 * can repeat the same decision.
 */
export interface WorkspaceAssignments {
	[organizationId: string]: {
		/** Workspace that receives the organization's memory tables. */
		memoryHome: string;
		/** Workspace that receives outputs whose `workspace_id` is null. */
		unassignedOutputsHome?: string;
	};
}

/** Tables that stay in the shared core after the cutover, with the reason. */
export const TABLES_THAT_STAY: ReadonlyArray<{
	table: string;
	reason: string;
}> = [
	{
		table: "skill_runs",
		reason:
			"factory runs belong to the organization and a tedi, not a workspace",
	},
	{
		table: "skill_run_artifacts",
		reason: "owned by skill_runs",
	},
	{
		table: "tedi_runtime_events",
		reason: "a tedi's own ledger; a tedi runs as a guest in many workspaces",
	},
	{
		table: "kernel_conversations (workspace_id IS NULL)",
		reason: "organization Home threads stay org-wide",
	},
];

export function mappingFor(table: string): TableMapping {
	const mapping = WORKSPACE_TABLES.find((entry) => entry.table === table);
	if (!mapping) throw new Error(`No workspace mapping for table ${table}`);
	return mapping;
}

/** The jurisdiction every workspace object must report. */
export const REQUIRED_JURISDICTION = "eu";
