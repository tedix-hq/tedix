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
 * organization's assignment (outputs without a workspace); see
 * {@link WorkspaceAssignments}.
 *
 * Organization memory does not move: it stays in the organization database
 * with today's permissions, untouched by the migration.
 */

export type MigrationDomain =
	| "outputs"
	| "resources"
	| "chat"
	| "runs"
	| "artifacts";

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
	 * log partition that holds no conversation table still answers.
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
/**
 * Conversation ids are unique per organization, not globally: another
 * organization's Home thread may carry the same id, so the pair is matched.
 */
const CONVERSATION_IN_ANY_WORKSPACE =
	"(organization_id || '|' || conversation_id) IN (:anyConversations)";

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
];

/**
 * Per-organization choices the data cannot make by itself. Written by hand
 * before the cutover and checked into the bundle manifest so the reconciler
 * can repeat the same decision.
 */
export interface WorkspaceAssignments {
	[organizationId: string]: {
		/** Workspace that receives outputs whose `workspace_id` is null. */
		unassignedOutputsHome: string;
		/**
		 * The organization has outputs to place but no workspace: create one
		 * named `unassignedOutputsHome` (a Home workspace) during the export.
		 */
		createHome?: boolean;
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
	{
		table: "memory_*",
		reason:
			"organization memory stays organization-wide, in the organization database, with today's permissions",
	},
];

export function mappingFor(table: string): TableMapping {
	const mapping = WORKSPACE_TABLES.find((entry) => entry.table === table);
	if (!mapping) throw new Error(`No workspace mapping for table ${table}`);
	return mapping;
}

/** The jurisdiction every workspace object must report. */
export const REQUIRED_JURISDICTION = "eu";
