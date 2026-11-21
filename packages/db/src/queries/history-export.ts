/** Raw storage rows for evidence, without Drizzle's timestamp/JSON coercion. */
export type HistoryRow = Record<string, unknown>;
export type HistoryRead = (
	sql: string,
	params: (string | number | null)[],
) => Promise<HistoryRow[]>;

export interface HistoryTable {
	table: string;
	time: string | null;
	owner: string;
	indirect?: "skill_runs" | "tedis";
	epoch?: boolean;
	logs: boolean;
	/** False for a table the main database no longer has. */
	main?: false;
}

/** Tenant history plus the dictionaries/checkpoints needed to interpret it. */
export const HISTORY_TABLES: readonly HistoryTable[] = [
	{
		table: "audit_events",
		time: "timestamp",
		owner: "organization_id",
		epoch: true,
		logs: true,
	},
	{
		table: "audit_metadata_refs",
		time: null,
		owner: "organization_id",
		logs: true,
	},
	{
		table: "tedi_runtime_events",
		time: "created_at",
		owner: "organization_id",
		logs: true,
	},
	{
		table: "kernel_runtime_events",
		time: "created_at",
		owner: "organization_id",
		logs: true,
	},
	{
		table: "skill_run_artifacts",
		time: "created_at",
		owner: "run_id",
		indirect: "skill_runs",
		logs: true,
	},
	{
		table: "external_agent_attributions",
		time: "occurred_at",
		owner: "organization_id",
		logs: true,
	},
	{ table: "tedi_call_costs", time: "created_at", owner: "org_id", logs: true },
	{
		table: "kernel_request_events",
		time: "created_at",
		owner: "organization_id",
		logs: true,
	},
	{
		table: "tedi_usage_events",
		time: "created_at",
		owner: "tedi_id",
		indirect: "tedis",
		logs: true,
	},
	{
		table: "widget_events",
		time: "created_at",
		owner: "organization_id",
		logs: true,
	},
	// Change records live in each organization's log store; only rows the
	// logs databases may hold are read here.
	{
		table: "gateway_change_records",
		time: "recorded_at",
		owner: "organization_id",
		logs: true,
		main: false,
	},
	{ table: "work_events", time: "occurred_at", owner: "org_id", logs: false },
];

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** The transport is supplied by the operator; all SQL stays in this owner. */
export function createHistoryReader(read: HistoryRead) {
	return {
		async owners(table: "skill_runs" | "tedis", organization: string) {
			const ids: string[] = [];
			let after = "";
			while (true) {
				const rows = await read(
					`SELECT id FROM ${quote(table)} WHERE organization_id = ? AND id > ? ORDER BY id LIMIT 500`,
					[organization, after],
				);
				for (const row of rows) ids.push(String(row.id));
				if (rows.length < 500) return ids;
				after = String(rows.at(-1)!.id);
			}
		},
		async highWater(table: HistoryTable) {
			const rows = await read(
				`SELECT COALESCE(MAX(rowid), 0) AS high_water FROM ${quote(table.table)}`,
				[],
			);
			const value = rows[0]?.high_water;
			if (typeof value !== "number" || !Number.isSafeInteger(value))
				throw new Error("Invalid history high water");
			return value;
		},
		page(
			table: HistoryTable,
			params: {
				organization: string;
				from: string;
				to: string;
				after: number;
				highWater: number;
				owners?: string[];
			},
		) {
			const owner = table.indirect
				? `${quote(table.owner)} IN (SELECT value FROM json_each(?))`
				: `${quote(table.owner)} = ?`;
			const values: (string | number | null)[] = [
				table.indirect
					? JSON.stringify(params.owners ?? [])
					: params.organization,
				params.after,
				params.highWater,
			];
			let range = "";
			if (table.time) {
				const time = table.epoch
					? quote(table.time)
					: `julianday(${quote(table.time)})`;
				const bound = table.epoch ? "?" : "julianday(?)";
				range = ` AND ${time} >= ${bound} AND ${time} < ${bound}`;
				values.push(
					table.epoch ? Date.parse(params.from) / 1000 : params.from,
					table.epoch ? Date.parse(params.to) / 1000 : params.to,
				);
			}
			return read(
				`SELECT rowid AS __rowid, * FROM ${quote(table.table)} WHERE ${owner} AND rowid > ? AND rowid <= ?${range} ORDER BY rowid LIMIT 500`,
				values,
			);
		},
	};
}
