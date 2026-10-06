/**
 * Regression for the fail-closed safety gate on the isolate `r2_sql_query`
 * tool. The R2 SQL warehouse (`default.mcp_tool_calls`) is platform-wide with
 * no row-level security, and arbitrary SQL cannot be safely scoped to one
 * tenant by inspection (a single `OR <predicate>` widens the result set). So
 * the gate hard-blocks all row-returning SQL and allows only schema
 * introspection (SHOW / DESCRIBE / EXPLAIN, never EXPLAIN ANALYZE).
 * Also covers `buildR2SqlIntrospection`, which composes the self-describing
 * SHOW/DESCRIBE statements from a fixed action (the table name is the only
 * tedi-controlled fragment and is syntactically validated).
 * Run: `bun run src/r2-sql-scope.test.ts`.
 */

import assert from "node:assert/strict";
import {
	buildR2SqlIntrospection,
	buildScopedR2Sql,
	checkR2SqlOrgScope,
} from "./r2-sql-scope";

const ORG = "org-abc-123";

const allow = (sql: string) => {
	const result = checkR2SqlOrgScope(sql, ORG);
	assert.equal(result.ok, true, `expected ALLOW for: ${sql}`);
};
const deny = (sql: string) => {
	const result = checkR2SqlOrgScope(sql, ORG);
	assert.equal(result.ok, false, `expected DENY for: ${sql}`);
};

// ── Allowed: schema introspection (no tenant rows) ───────────────────────────
allow("SHOW TABLES");
allow("show tables");
allow("DESCRIBE default.mcp_tool_calls");
allow("EXPLAIN SELECT * FROM default.mcp_tool_calls");
allow("/* lead comment */ SHOW TABLES");
allow("SHOW TABLES;"); // single trailing semicolon is fine
allow("  DESCRIBE default.mcp_tool_calls  ");

// ── Denied: every row-returning query (the tool's whole risk surface) ────────
deny("SELECT * FROM default.mcp_tool_calls");
deny(`SELECT * FROM default.mcp_tool_calls WHERE organization_id = '${ORG}'`);
deny(
	`SELECT tool_name FROM default.mcp_tool_calls WHERE organization_id='${ORG}'`,
);
deny(
	`WITH t AS (SELECT * FROM default.mcp_tool_calls WHERE organization_id = '${ORG}') SELECT * FROM t`,
);

// ── Denied: the bypasses the previous regex guard let through ────────────────
// (org self-equality + a non-org OR predicate widened to all rows.)
deny(
	`SELECT * FROM default.mcp_tool_calls WHERE organization_id = '${ORG}' OR 1=1`,
);
deny(
	`SELECT * FROM default.mcp_tool_calls WHERE organization_id = '${ORG}' OR success = true`,
);
deny(
	`SELECT * FROM default.mcp_tool_calls WHERE organization_id = '${ORG}' OR organization_id = 'org-victim'`,
);

// ── Denied: EXPLAIN ANALYZE executes the query ───────────────────────────────
deny("EXPLAIN ANALYZE SELECT * FROM default.mcp_tool_calls");
deny("explain   analyze SELECT 1");

// ── Denied: stacked / multi-statement (introspection used to smuggle rows) ───
deny("SHOW TABLES; SELECT * FROM default.mcp_tool_calls");
deny("SELECT 1; SELECT 2");
deny("DESCRIBE default.mcp_tool_calls; DROP TABLE x");

// ── Denied: comment-smuggled row query ───────────────────────────────────────
deny("/* SHOW TABLES */ SELECT * FROM default.mcp_tool_calls");

// ── Denied: subquery / aliased row query ─────────────────────────────────────
deny(
	`SELECT a.tool_name FROM (SELECT * FROM default.mcp_tool_calls) a WHERE a.organization_id = '${ORG}'`,
);

// ── Introspection allowed regardless of org id (no tenant rows) ──────────────
assert.equal(checkR2SqlOrgScope("SHOW TABLES", undefined).ok, true);
// ── Row query still denied even with an org id present ───────────────────────
assert.equal(
	checkR2SqlOrgScope(
		`SELECT * FROM default.mcp_tool_calls WHERE organization_id = '${ORG}'`,
		ORG,
	).ok,
	false,
);

// ── buildScopedR2Sql: structured row queries are org-injected & safe ─────────
const TABLE = "default.mcp_tool_calls";
const OPTS = { defaultLimit: 25, maxLimit: 100 };
// `org` has no default here, so an explicit `undefined` actually reaches the fn.
const build = (
	q: Parameters<typeof buildScopedR2Sql>[0],
	org: string | undefined,
) => buildScopedR2Sql(q, org, TABLE, OPTS);
const sqlOf = (q: Parameters<typeof buildScopedR2Sql>[0]): string => {
	const r = build(q, ORG);
	if (!r.ok) throw new Error(`expected OK, got: ${r.error}`);
	return r.sql;
};
const denied = (
	q: Parameters<typeof buildScopedR2Sql>[0],
	org: string | undefined = ORG,
) =>
	assert.equal(
		build(q, org).ok,
		false,
		`expected DENY for: ${JSON.stringify(q)}`,
	);

// org is always injected (correct warehouse column, quoted), even for empty query
assert.equal(
	sqlOf({}),
	`SELECT * FROM ${TABLE} WHERE "organizationId" = '${ORG}' LIMIT 25`,
);

// columns, equality filters, group/order/limit compose with AND only.
// Identifiers are quoted (camelCase warehouse schema: toolName/appId/…) and
// aggregates are supported in select AND order_by.
{
	const sql = sqlOf({
		select: ["toolName", "count(*)"],
		where: { success: true, appId: "app-1" },
		groupBy: ["toolName"],
		orderBy: ["count(*) desc"],
		limit: 10,
	});
	assert.ok(sql.includes(`"organizationId" = '${ORG}'`));
	assert.ok(sql.includes('"success" = TRUE'));
	assert.ok(sql.includes(`"appId" = 'app-1'`));
	assert.ok(sql.includes('GROUP BY "toolName"'));
	assert.ok(sql.includes("ORDER BY count(*) DESC"), `order_by: ${sql}`);
	assert.ok(sql.includes('SELECT "toolName", count(*)'), `select: ${sql}`);
	assert.ok(sql.endsWith("LIMIT 10"));
	// the only boolean combinator is AND — no user-supplied OR is possible
	assert.ok(!/\bOR\b/i.test(sql), "no OR in composed SQL");
}

// order_by a quoted column with direction
assert.ok(
	sqlOf({ orderBy: ["timestamp desc"] }).includes('ORDER BY "timestamp" DESC'),
);

// fail closed without an org id (direct call — no default-param masking)
assert.equal(buildScopedR2Sql({}, undefined, TABLE, OPTS).ok, false);

// organizationId cannot be overridden via where (camelCase or snake)
denied({ where: { organizationId: "org-victim" } });
denied({ where: { organization_id: "org-victim" } });

// string values are escaped (no injection): a quote-break attempt stays a literal
{
	const sql = sqlOf({ where: { toolName: "x' OR '1'='1" } });
	assert.ok(
		sql.includes(`"toolName" = 'x'' OR ''1''=''1'`),
		`value is escaped, not interpreted: ${sql}`,
	);
}

// injection via identifiers is rejected
denied({ select: ["1; DROP TABLE x"] });
denied({ select: ["* FROM other"] });
denied({ where: { "a OR 1=1": "x" } });
denied({ groupBy: ["toolName); DELETE"] });
denied({ orderBy: ["toolName; DROP"] });
denied({ table: "secret.other_tenant_table; --" });

// The configured table is accepted, but another syntactically valid platform
// resource is denied even though every row query injects the caller's org.
assert.equal(
	build({ table: "default.mcp_tool_calls", select: ["appId"] }, ORG).ok,
	true,
);
denied({ table: "default.other_tenant_metrics" });

// limit clamped to maxLimit
assert.ok(
	sqlOf({ limit: 99999 }).endsWith("LIMIT 100"),
	"limit clamped to max",
);

// ── buildR2SqlIntrospection: self-describing, runtime-composed SHOW/DESCRIBE ──
// The analytics tool is self-describing via a fixed action; the composed
// statement stays within the SHOW/DESCRIBE set the fail-closed gate allows and
// never returns tenant rows.
{
	const tables = buildR2SqlIntrospection({ action: "list_tables" }, TABLE);
	assert.equal(
		tables.ok,
		false,
		"tenant runtimes cannot enumerate the catalog",
	);

	const cols = buildR2SqlIntrospection({ action: "describe_columns" }, TABLE);
	assert.equal(cols.ok, true);
	assert.equal(cols.ok && cols.sql, `DESCRIBE ${TABLE}`);
	assert.equal(cols.ok && checkR2SqlOrgScope(cols.sql, ORG).ok, true);

	const explicit = buildR2SqlIntrospection(
		{ action: "describe_columns", table: "default.other_metrics" },
		TABLE,
	);
	assert.equal(explicit.ok, false, "other platform resources stay hidden");
}

// the table identifier is the only tedi-controlled fragment and cannot smuggle SQL
assert.equal(
	buildR2SqlIntrospection(
		{ action: "describe_columns", table: "x; DROP TABLE y" },
		TABLE,
	).ok,
	false,
);
assert.equal(
	buildR2SqlIntrospection(
		{ action: "describe_columns", table: "x WHERE 1=1" },
		TABLE,
	).ok,
	false,
);
assert.equal(
	buildR2SqlIntrospection(
		{ action: "describe_columns", table: "a; SELECT * FROM mcp_tool_calls --" },
		TABLE,
	).ok,
	false,
);
// unknown action is rejected (no statement composed)
assert.equal(
	buildR2SqlIntrospection({ action: "drop_everything" as never }, TABLE).ok,
	false,
);

console.log("r2-sql-scope.test.ts OK");
