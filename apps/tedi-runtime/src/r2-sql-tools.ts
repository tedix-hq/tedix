import { tool, type ToolSet } from "ai";
import * as z from "zod";
import {
	buildR2SqlIntrospection,
	buildScopedR2Sql,
	checkR2SqlOrgScope,
	type R2SqlIntrospection,
	type R2SqlRowQuery,
} from "./r2-sql-scope";

interface R2SqlDependencies {
	getConfig(): {
		accountId?: string;
		table: string;
		token?: string;
		warehouse?: string;
	};
	getOrgId(): string | undefined;
}

/**
 * `r2_sql_query` tool input. One of three safe modes:
 *  - `action`: describe the configured tenant analytics resource only.
 *  - structured row-query fields consumed by `buildScopedR2Sql`.
 */
type R2SqlQueryInput = R2SqlRowQuery & {
	action?: R2SqlIntrospection["action"];
};

export function createR2SqlTools(deps: R2SqlDependencies): ToolSet {
	async function r2SqlQueryTool(input: R2SqlQueryInput): Promise<unknown> {
		const config = deps.getConfig();
		const configured = Boolean(
			config.accountId && config.token && config.warehouse,
		);
		if (!configured) {
			return {
				ok: false,
				configured: false,
				table: config.table,
				error: "not_configured",
				required: ["R2_SQL_WAREHOUSE", "CF_R2_SQL_TOKEN"],
			};
		}
		// Two safe modes:
		//  - structured `action`: describe the configured analytics resource only.
		//  - structured row query: the runtime composes the SQL and always injects
		//    organization_id = currentOrg, so widening is structurally impossible.
		const hasStructured = Boolean(
			input.select ||
			input.where ||
			input.groupBy ||
			input.orderBy ||
			input.table ||
			typeof input.limit === "number",
		);
		let query: string;
		if (input.action) {
			const introspection = buildR2SqlIntrospection(
				{ action: input.action, table: input.table },
				config.table,
			);
			if (!introspection.ok) {
				return { ok: false, configured: true, error: introspection.error };
			}
			// Defence in depth: the composed statement must still satisfy the
			// fail-closed gate (SHOW/DESCRIBE only — never a row path).
			const orgScope = checkR2SqlOrgScope(introspection.sql, deps.getOrgId());
			if (!orgScope.ok) {
				return { ok: false, configured: true, error: orgScope.error };
			}
			query = introspection.sql;
		} else if (hasStructured) {
			const built = buildScopedR2Sql(
				{
					table: input.table,
					select: input.select,
					where: input.where,
					groupBy: input.groupBy,
					orderBy: input.orderBy,
					limit: input.limit,
				},
				deps.getOrgId(),
				config.table,
				{ defaultLimit: 25, maxLimit: 100 },
			);
			if (!built.ok) {
				return { ok: false, configured: true, error: built.error };
			}
			query = built.sql;
		} else {
			return {
				ok: false,
				configured: true,
				error:
					"provide `action: describe_columns` or structured row-query fields (select/where/group_by/order_by)",
			};
		}
		const response = await fetch(
			`https://api.sql.cloudflarestorage.com/api/v1/accounts/${config.accountId}/r2-sql/query/${config.warehouse}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ query }),
			},
		);
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			return {
				ok: false,
				configured: true,
				status: response.status,
				error: detail.slice(0, 1000),
			};
		}
		const json = (await response.json().catch(() => ({}))) as {
			success?: boolean;
			errors?: Array<string | { message?: string }>;
			result?: { rows?: unknown[] } | unknown[];
			rows?: unknown[];
		};
		if (json.success === false) {
			return {
				ok: false,
				configured: true,
				error: (json.errors ?? [])
					.map((error) =>
						typeof error === "string" ? error : (error.message ?? ""),
					)
					.filter(Boolean)
					.join("; "),
			};
		}
		const rows = Array.isArray(json.result)
			? json.result
			: Array.isArray(json.result?.rows)
				? json.result.rows
				: Array.isArray(json.rows)
					? json.rows
					: [];
		return { ok: true, configured: true, table: config.table, query, rows };
	}

	return {
		r2_sql_query: tool({
			description:
				"Query the configured tenant analytics resource when available. Describe that resource or use structured select/where/group_by/order_by fields for bounded rows automatically scoped to YOUR organization. Warehouse catalog discovery, other platform resources, and raw SQL are unavailable.",
			inputSchema: z.object({
				action: z
					.enum(["describe_columns"])
					.optional()
					.describe("Describe the configured tenant analytics resource."),
				table: z
					.string()
					.optional()
					.describe(
						"Row mode / describe_columns: table to read; defaults to the analytics table.",
					),
				select: z
					.array(z.string())
					.optional()
					.describe(
						"Row mode: columns or count/sum/avg/min/max(col). Default *.",
					),
				where: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
					.optional()
					.describe(
						"Row mode: equality filters (AND-joined). organization_id is injected automatically and cannot be set.",
					),
				groupBy: z.array(z.string()).optional(),
				orderBy: z
					.array(z.string())
					.optional()
					.describe('Row mode: e.g. ["created_at desc"].'),
				limit: z.number().int().positive().max(100).optional(),
			}),
			execute: async (input) => r2SqlQueryTool(input),
		}),
	};
}
