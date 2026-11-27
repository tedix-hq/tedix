import {
	and,
	asc,
	eq,
	gt,
	gte,
	lt,
	lte,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { anyIds, coreStore } from "../core-store/dialect";

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
	{ table: "work_events", time: "occurred_at", owner: "org_id", logs: false },
];

/** Callback transports compile D1 builders without opening a local database. */
export function createHistoryReader(source: HistoryRead | DbQueryClient) {
	const db: Pick<DbQueryClient, "select"> =
		typeof source === "function"
			? (new QueryBuilder() as unknown as Pick<DbQueryClient, "select">)
			: source;
	const postgres = coreStore(db) === "postgres";
	const sequence = sql.identifier(postgres ? "sequence" : "rowid");
	const read = async (
		query: SQLWrapper & { toSQL(): { sql: string; params: unknown[] } },
	): Promise<HistoryRow[]> => {
		const built = query.toSQL();
		const rows =
			typeof source === "function"
				? await source(built.sql, built.params as (string | number | null)[])
				: await source.all<HistoryRow>(query.getSQL());
		return postgres
			? rows.map((row) =>
					Object.hasOwn(row, "__rowid")
						? { ...row, __rowid: Number(row.__rowid) }
						: row,
				)
			: rows;
	};
	return {
		async owners(table: "skill_runs" | "tedis", organization: string) {
			const ids: string[] = [];
			let after = "";
			while (true) {
				const rows = await read(
					db
						.select({ id: sql`id` })
						.from(sql`${sql.identifier(table)}`)
						.where(
							and(eq(sql`organization_id`, organization), gt(sql`id`, after)),
						)
						.orderBy(asc(sql`id`))
						.limit(500),
				);
				for (const row of rows) ids.push(String(row.id));
				if (rows.length < 500) return ids;
				after = String(rows.at(-1)!.id);
			}
		},
		async highWater(table: HistoryTable) {
			const rows = await read(
				db
					.select({
						high_water: sql`coalesce(max(${sequence}), 0)`.as("high_water"),
					})
					.from(sql`${sql.identifier(table.table)}`),
			);
			const value = postgres
				? Number(rows[0]?.high_water)
				: rows[0]?.high_water;
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
			const owner = sql.identifier(table.owner);
			const conditions = [
				table.indirect
					? anyIds(db, owner, params.owners ?? [])
					: eq(owner, params.organization),
				gt(sequence, params.after),
				lte(sequence, params.highWater),
			];
			if (table.time) {
				const column = sql.identifier(table.time);
				const time = table.epoch
					? column
					: postgres
						? sql`CAST(${column} AS timestamptz)`
						: sql`julianday(${column})`;
				const bound = (value: string) =>
					table.epoch
						? Date.parse(value) / 1000
						: postgres
							? sql`CAST(${value} AS timestamptz)`
							: sql`julianday(${value})`;
				conditions.push(
					gte(time, bound(params.from)),
					lt(time, bound(params.to)),
				);
			}
			// Execute without Drizzle row decoding: archives retain physical column names and storage values.
			return read(
				db
					.select({ __rowid: sql`${sequence}`.as("__rowid"), row: sql`*` })
					.from(sql`${sql.identifier(table.table)}`)
					.where(and(...conditions))
					.orderBy(asc(sequence))
					.limit(500),
			);
		},
	};
}
