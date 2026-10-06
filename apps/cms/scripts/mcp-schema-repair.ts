#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "@tedix/api-contract/utils/is-record";

type D1Result<T> = {
	results: T[];
	success: boolean;
	meta?: {
		changes?: number;
		duration?: number;
		rows_read?: number;
		rows_written?: number;
	};
};

type SiteBuilderTool = {
	inputSchema?: unknown;
	name: string;
	outputSchema?: unknown;
};

type ToolRow = {
	input_schema: string | null;
	output_schema: string | null;
	surface: "base_app" | "catalog";
	tool: string;
};

type PlannedUpdate = {
	column: "input_schema" | "output_schema";
	currentLength: number;
	nextLength: number;
	surface: ToolRow["surface"];
	tool: string;
};

const DEFAULT_SCHEMA_TOOLS = [
	"get_site_overview",
	"content_list",
	"list_content_byline_entries",
	"list_content_authors",
	"content_update",
	"content_publish",
	"content_unpublish",
	"content_discard_draft",
	"content_get",
	"schema_list_block_types",
	"content_schedule",
	"content_unschedule",
	"read_hot_theme",
	"write_hot_theme",
	"list_hot_theme_revisions",
	"rollback_hot_theme",
	"provision_theme_artifact_repo",
	"theme_artifact_seed_status",
	"theme_artifact_seed_cancel",
	"theme_list_files",
	"theme_read_file",
	"theme_write_file",
	"theme_write_files",
	"theme_diff_template",
	"theme_fleet_status",
	"theme_resync_template",
	"theme_preview_start",
	"theme_preview_status",
	"theme_preview_stop",
	"theme_preview_exec",
	"theme_preview_exec_status",
	"theme_preview_exec_cancel",
	"theme_build",
	"theme_build_status",
	"theme_build_cancel",
	"theme_deploy",
	"theme_deploy_status",
	"theme_list_versions",
	"theme_rollback",
] as const;

const { values } = parseArgs({
	options: {
		apply: { default: false, type: "boolean" },
		"database-name": { type: "string" },
		"connection-label": { type: "string" },
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
		"site-builder-url": {
			type: "string",
		},
		tools: { default: DEFAULT_SCHEMA_TOOLS.join(","), type: "string" },
	},
	strict: false,
});

const siteBuilderUrl = String(values["site-builder-url"] ?? "");
const databaseName = String(values["database-name"] ?? "");
const apply = Boolean(values.apply);
const apiCwd = fileURLToPath(new URL("../../api", import.meta.url));
const tools = String(values.tools)
	.split(",")
	.map((tool) => tool.trim())
	.filter(Boolean);

if (values.help) {
	console.log(`Usage: bun run cms:mcp:schema-repair [options]

Repairs existing CMS catalog/base app input_schema and output_schema rows from
live Site Builder MCP tools/list. This is the fallback when Tedix MCP OAuth is
unavailable; prefer catalog.reconcile_app when operator MCP auth works.

Options:
  --apply                 Write production D1 rows. Omit for dry-run.
  --json                  Print machine-readable JSON.
  --tools <a,b,c>         Tool names to repair. Default: agent-critical theme/content tools.
  --site-builder-url <url>      Required Site Builder MCP endpoint.
  --connection-label <slug> Required target tenant connection label.
  --database-name <name>  Required D1 database name or apps/api binding.

Needs the installation's Cloudflare credentials in the environment
(CLOUDFLARE_API_TOKEN with D1 edit access, plus CLOUDFLARE_ACCOUNT_ID) for the
remote D1 calls, which resolve the database through apps/api/wrangler.jsonc,
and PLATFORM_SERVICE_TOKEN for the Site Builder calls. Provide the endpoint,
tenant connection label and database target explicitly:
  bun run cms:mcp:schema-repair -- --site-builder-url <url> --connection-label <slug> --database-name <name> --json
`);
	process.exit(0);
}

if (!siteBuilderUrl || !values["connection-label"] || !databaseName) {
	fail(
		"--site-builder-url, --connection-label, and --database-name are required; use --help for usage",
	);
}

function fail(message: string): never {
	throw new Error(message);
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function toolListLiteral(toolNames: readonly string[]): string {
	return toolNames.map(sqlString).join(", ");
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalJson(value[key])]),
	);
}

function stableSchemaString(
	schema: unknown,
	toolName: string,
	column: PlannedUpdate["column"],
): string | undefined {
	if (schema === undefined) return undefined;
	if (!isRecord(schema)) {
		fail(`Site Builder tool ${toolName} does not expose an object ${column}`);
	}
	return JSON.stringify(canonicalJson(schema));
}

function canonicalStoredSchemaString(schema: string | null): string | null {
	if (schema === null) return null;
	return JSON.stringify(canonicalJson(JSON.parse(schema)));
}

async function siteBuilderToolsList(): Promise<SiteBuilderTool[]> {
	const token = Bun.env.PLATFORM_SERVICE_TOKEN;
	if (!token) {
		fail(
			"PLATFORM_SERVICE_TOKEN is required for Site Builder MCP schema repair",
		);
	}

	const response = await fetch(siteBuilderUrl, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"X-Tedix-Connection-Label": String(values["connection-label"]),
		},
		body: JSON.stringify({
			id: crypto.randomUUID(),
			jsonrpc: "2.0",
			method: "tools/list",
		}),
	});

	const responseText = await response.text();
	let body: {
		error?: { message?: string };
		result?: { tools?: SiteBuilderTool[] };
	};
	try {
		body = responseText
			? (JSON.parse(responseText) as {
					error?: { message?: string };
					result?: { tools?: SiteBuilderTool[] };
				})
			: { error: { message: response.statusText } };
	} catch {
		body = { error: { message: responseText || response.statusText } };
	}

	if (!response.ok || body.error) {
		fail(
			`Site Builder MCP tools/list failed (${response.status}): ${
				body.error?.message ?? response.statusText
			}`,
		);
	}

	return body.result?.tools ?? [];
}

function runD1<T>(sql: string): D1Result<T>[] {
	const child = spawnSync(
		"bunx",
		[
			"wrangler",
			"d1",
			"execute",
			databaseName,
			"--remote",
			"--json",
			"--command",
			sql,
		],
		{
			cwd: apiCwd,
			encoding: "utf8",
			maxBuffer: 1024 * 1024 * 20,
		},
	);

	if (child.status !== 0) {
		fail(`wrangler d1 execute failed:\n${child.stderr || child.stdout}`);
	}

	const parsed = JSON.parse(child.stdout) as D1Result<T>[];
	for (const result of parsed) {
		if (!result.success) fail(`D1 query failed: ${child.stdout}`);
	}
	return parsed;
}

if (tools.length === 0) fail("At least one tool must be provided");

const liveTools = await siteBuilderToolsList();
const liveToolsByName = new Map(liveTools.map((tool) => [tool.name, tool]));
const inputSchemasByTool = new Map<string, string>();
const outputSchemasByTool = new Map<string, string>();

for (const toolName of tools) {
	const tool = liveToolsByName.get(toolName);
	if (!tool) fail(`Site Builder MCP tools/list did not include ${toolName}`);
	const inputSchema = stableSchemaString(
		tool.inputSchema,
		toolName,
		"input_schema",
	);
	if (inputSchema !== undefined) inputSchemasByTool.set(toolName, inputSchema);
	const outputSchema = stableSchemaString(
		tool.outputSchema,
		toolName,
		"output_schema",
	);
	if (outputSchema !== undefined)
		outputSchemasByTool.set(toolName, outputSchema);
}

const selectedTools = toolListLiteral(tools);
const currentRows = runD1<ToolRow>(`
SELECT 'catalog' AS surface, mt.tool_name AS tool, mt.input_schema, mt.output_schema
FROM app_catalog_mcp_tools mt
WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
  AND mt.removed_at IS NULL
  AND mt.tool_name IN (${selectedTools})
UNION ALL
SELECT 'base_app' AS surface, t.tool_id AS tool, t.input_schema, t.output_schema
FROM app_tools t
WHERE t.app_id = (SELECT id FROM apps WHERE slug='cms')
  AND t.tool_id IN (${selectedTools})
ORDER BY surface, tool;
`)[0]?.results;

const expectedRowCount = tools.length * 2;
if (currentRows.length !== expectedRowCount) {
	fail(
		`Expected ${expectedRowCount} D1 schema rows for ${tools.join(", ")}, found ${currentRows.length}`,
	);
}

const plannedUpdates: PlannedUpdate[] = [];
for (const row of currentRows) {
	for (const [column, schemasByTool] of [
		["input_schema", inputSchemasByTool],
		["output_schema", outputSchemasByTool],
	] as const) {
		const nextSchema = schemasByTool.get(row.tool);
		if (nextSchema === undefined) continue;
		const currentSchema = row[column];
		if (canonicalStoredSchemaString(currentSchema) === nextSchema) continue;
		plannedUpdates.push({
			column,
			currentLength: currentSchema?.length ?? 0,
			nextLength: nextSchema.length,
			surface: row.surface,
			tool: row.tool,
		});
	}
}

let writeSummary:
	| {
			changes: number;
			statements: number;
	  }
	| undefined;

if (apply && plannedUpdates.length > 0) {
	const now = new Date().toISOString();
	const statements: string[] = [];
	for (const update of plannedUpdates) {
		const schemasByTool =
			update.column === "input_schema"
				? inputSchemasByTool
				: outputSchemasByTool;
		const nextSchema = schemasByTool.get(update.tool);
		if (!nextSchema) fail(`No ${update.column} available for ${update.tool}`);
		if (update.surface === "catalog") {
			statements.push(
				`UPDATE app_catalog_mcp_tools SET ${update.column}=${sqlString(nextSchema)}, schema_synced_at=${sqlString(now)}, last_seen_at=${sqlString(now)} WHERE catalog_app_id=(SELECT id FROM app_catalog WHERE slug='cms') AND tool_name=${sqlString(update.tool)} AND removed_at IS NULL;`,
			);
		} else {
			statements.push(
				`UPDATE app_tools SET ${update.column}=${sqlString(nextSchema)}, schema_synced_at=${sqlString(now)}, updated_at=${sqlString(now)} WHERE app_id=(SELECT id FROM apps WHERE slug='cms') AND tool_id=${sqlString(update.tool)};`,
			);
		}
	}

	const results = runD1<unknown>(statements.join("\n"));
	writeSummary = {
		changes: results.reduce(
			(sum, result) => sum + Number(result.meta?.changes ?? 0),
			0,
		),
		statements: statements.length,
	};
}

const output = {
	applied: apply,
	databaseName,
	ok: true,
	plannedUpdates,
	siteBuilderUrl,
	tools,
	writeSummary,
};

if (values.json) {
	console.log(JSON.stringify(output, null, 2));
} else {
	const verb = apply ? "Applied" : "Planned";
	console.log(
		`${verb} CMS MCP schema repair: ${plannedUpdates.length} row(s) ${apply ? "changed" : "would change"} for ${tools.length} tool(s).`,
	);
	if (writeSummary) {
		console.log(
			`D1 statements: ${writeSummary.statements}; changed rows: ${writeSummary.changes}.`,
		);
	}
}
