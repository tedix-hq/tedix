/**
 * Fail-closed safety gate for the isolate `r2_sql_query` tool.
 *
 * The default warehouse table (`default.mcp_tool_calls`) is platform-wide and
 * carries an `organization_id` column. R2 SQL has no row-level security and the
 * catalog token can be account-scoped, so a row-returning query that is not
 * pinned to the caller's org would read other tenants' captured tool-call
 * payloads.
 *
 * Arbitrary SQL CANNOT be safely constrained to one tenant by inspection: a
 * single `OR <predicate>` (e.g. `... organization_id = 'self' OR 1=1`) widens
 * the result set past any `organization_id = self` check, and comments,
 * sub-selects, aliases, and stacked statements defeat regex matching. So this
 * gate does not try to validate row queries — it hard-blocks them. Only schema
 * introspection (SHOW / DESCRIBE / EXPLAIN), which returns catalog/plan
 * metadata rather than tenant rows, is allowed through.
 *
 * Tenant-scoped row analytics must come from a constrained query builder that
 * the runtime composes itself (validated identifiers + escaped equality values
 * + an always-injected `organization_id = currentOrg`), never from
 * tedi-supplied SQL. Until that exists, row queries fail closed.
 */
export function checkR2SqlOrgScope(
	sql: string,
	_orgId: string | undefined,
): { ok: true } | { ok: false; error: string } {
	// Strip a single leading block comment, then trim.
	const stripped = sql.replace(/^\s*\/\*[\s\S]*?\*\//, "").trim();

	// Reject stacked / multi-statement queries (a single trailing ';' is fine).
	if (stripped.replace(/;\s*$/, "").includes(";")) {
		return { ok: false, error: "multi-statement queries are not allowed" };
	}
	const head = stripped.replace(/;\s*$/, "");

	// Schema introspection returns catalog/plan metadata, not tenant rows.
	if (/^(show|describe)\b/i.test(head)) return { ok: true };
	if (/^explain\b/i.test(head)) {
		// EXPLAIN ANALYZE executes the plan and can return tenant rows.
		if (/\banalyze\b/i.test(head)) {
			return {
				ok: false,
				error: "EXPLAIN ANALYZE is not allowed (it executes the query)",
			};
		}
		return { ok: true };
	}

	// Row-returning queries (SELECT / WITH / anything else): hard-blocked.
	// Tenant-scoped row analytics go through buildScopedR2Sql instead.
	return {
		ok: false,
		error:
			"row-returning SQL is not permitted on this tool; only SHOW / DESCRIBE / EXPLAIN are allowed. For row analytics, use the structured query fields (select/where/group_by/order_by), which are automatically scoped to your organization.",
	};
}

/**
 * Structured schema-introspection request. Tenant runtimes may describe only
 * their configured analytics resource; warehouse-wide discovery stays on the
 * operator plane.
 */
export interface R2SqlIntrospection {
	/** Only the configured tenant analytics resource may be described. */
	action: "list_tables" | "describe_columns";
	/** Required for `describe_columns`. Defaults to the analytics table. */
	table?: string;
}

/**
 * Structured, tenant-scoped row query. The runtime composes the SQL itself —
 * the tedi never supplies raw SQL for row data — so widening is structurally
 * impossible: identifiers are syntactically validated, equality values are
 * escaped literals, the only boolean combinator is AND, and
 * `organization_id = '<currentOrg>'` is always injected and cannot be overridden.
 */
export interface R2SqlRowQuery {
	/** Table to read. Defaults to the configured analytics table. */
	table?: string;
	/** Columns or simple aggregates (count/sum/avg/min/max). Defaults to `*`. */
	select?: string[];
	/** Equality filters, AND-joined. `organization_id` is rejected (auto-injected). */
	where?: Record<string, string | number | boolean>;
	groupBy?: string[];
	/** e.g. `created_at desc`. */
	orderBy?: string[];
	limit?: number;
}

const SQL_IDENT = /^[a-z_][a-z0-9_]*$/i;
const SQL_DOTTED = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/i;
const SQL_AGG = /^(count|sum|avg|min|max)\(\s*(\*|[a-z_][a-z0-9_]*)\s*\)$/i;

function quoteSqlString(value: string): string {
	// SQL-standard single-quote escaping (double the quote). Combined with the
	// identifier validation elsewhere, this prevents value-side injection.
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The tenant-scoping column on the analytics warehouse. The R2 Iceberg schema
 * uses camelCase identifiers (`organizationId`, `toolName`, …) which SQL folds
 * to lowercase unless double-quoted, so every identifier is quoted.
 */
const ORG_COLUMN = "organizationId";

// Double-quote a validated identifier so camelCase/reserved-word columns
// (`"organizationId"`, `"timestamp"`) resolve exactly. The name is pre-validated
// to /^[a-z_][a-z0-9_]*$/i — no embedded quotes — so quoting is injection-safe.
function quoteIdent(name: string): string {
	return `"${name}"`;
}

// Quote a select / order-by expression: `*` stays, `count(*)` stays, `agg(col)`
// becomes `agg("col")`, and a plain identifier becomes `"col"`. Returns null if
// the expression is neither a valid identifier nor a supported aggregate.
function quoteColumnExpr(expr: string): string | null {
	if (expr === "*") return "*";
	if (SQL_IDENT.test(expr)) return quoteIdent(expr);
	const agg = SQL_AGG.exec(expr);
	if (agg) {
		const fn = agg[1]!.toLowerCase();
		const inner = agg[2]!;
		return `${fn}(${inner === "*" ? "*" : quoteIdent(inner)})`;
	}
	return null;
}

/**
 * Compose a DESCRIBE for the configured resource. The deprecated list action
 * fails closed so older callers cannot enumerate platform-wide tables.
 */
export function buildR2SqlIntrospection(
	request: R2SqlIntrospection,
	defaultTable: string,
): { ok: true; sql: string } | { ok: false; error: string } {
	if (request.action === "list_tables") {
		return {
			ok: false,
			error: "warehouse catalog discovery is not available to tenant runtimes",
		};
	}
	if (request.action === "describe_columns") {
		const table = request.table ?? defaultTable;
		if (!SQL_DOTTED.test(table)) {
			return { ok: false, error: `invalid table: ${table}` };
		}
		if (table !== defaultTable) {
			return {
				ok: false,
				error: "only the configured tenant analytics resource may be described",
			};
		}
		return { ok: true, sql: `DESCRIBE ${table}` };
	}
	return {
		ok: false,
		error: `unknown introspection action: ${request.action}`,
	};
}

export function buildScopedR2Sql(
	query: R2SqlRowQuery,
	orgId: string | undefined,
	defaultTable: string,
	opts: { defaultLimit: number; maxLimit: number },
): { ok: true; sql: string } | { ok: false; error: string } {
	if (!orgId) {
		return {
			ok: false,
			error: "organization not resolved; cannot scope query",
		};
	}
	if (orgId.includes("'") || orgId.includes("\0")) {
		return { ok: false, error: "invalid organization id" };
	}

	const table = query.table ?? defaultTable;
	if (!SQL_DOTTED.test(table)) {
		return { ok: false, error: `invalid table: ${table}` };
	}
	if (table !== defaultTable) {
		return {
			ok: false,
			error: "only the configured tenant analytics resource may be queried",
		};
	}

	const selectInput =
		query.select && query.select.length > 0 ? query.select : ["*"];
	const select: string[] = [];
	for (const expr of selectInput) {
		const quoted = quoteColumnExpr(expr);
		if (!quoted) {
			return { ok: false, error: `invalid select expression: ${expr}` };
		}
		select.push(quoted);
	}

	const predicates: string[] = [
		`${quoteIdent(ORG_COLUMN)} = ${quoteSqlString(orgId)}`,
	];
	for (const [column, value] of Object.entries(query.where ?? {})) {
		if (!SQL_IDENT.test(column)) {
			return { ok: false, error: `invalid filter column: ${column}` };
		}
		const lowered = column.toLowerCase();
		if (lowered === "organizationid" || lowered === "organization_id") {
			return {
				ok: false,
				error: `${ORG_COLUMN} is injected automatically and cannot be overridden`,
			};
		}
		let literal: string;
		if (typeof value === "boolean") {
			literal = value ? "TRUE" : "FALSE";
		} else if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				return { ok: false, error: `invalid numeric filter for ${column}` };
			}
			literal = String(value);
		} else if (typeof value === "string") {
			if (value.includes("\0")) {
				return { ok: false, error: `invalid filter value for ${column}` };
			}
			literal = quoteSqlString(value);
		} else {
			return { ok: false, error: `unsupported filter type for ${column}` };
		}
		predicates.push(`${quoteIdent(column)} = ${literal}`);
	}

	let groupByClause = "";
	if (query.groupBy && query.groupBy.length > 0) {
		const cols: string[] = [];
		for (const column of query.groupBy) {
			if (!SQL_IDENT.test(column)) {
				return { ok: false, error: `invalid group_by column: ${column}` };
			}
			cols.push(quoteIdent(column));
		}
		groupByClause = ` GROUP BY ${cols.join(", ")}`;
	}

	let orderByClause = "";
	if (query.orderBy && query.orderBy.length > 0) {
		const parts: string[] = [];
		for (const entry of query.orderBy) {
			const trimmed = entry.trim();
			let exprPart = trimmed;
			let direction = "";
			const dir = /\s+(asc|desc)$/i.exec(trimmed);
			if (dir) {
				direction = ` ${dir[1]!.toUpperCase()}`;
				exprPart = trimmed.slice(0, dir.index).trim();
			}
			const quoted = quoteColumnExpr(exprPart);
			if (!quoted) {
				return { ok: false, error: `invalid order_by: ${entry}` };
			}
			parts.push(`${quoted}${direction}`);
		}
		orderByClause = ` ORDER BY ${parts.join(", ")}`;
	}

	const limit = Math.min(
		Math.max(1, Math.floor(query.limit ?? opts.defaultLimit)),
		opts.maxLimit,
	);

	const sql = `SELECT ${select.join(", ")} FROM ${table} WHERE ${predicates.join(
		" AND ",
	)}${groupByClause}${orderByClause} LIMIT ${limit}`;
	return { ok: true, sql };
}
