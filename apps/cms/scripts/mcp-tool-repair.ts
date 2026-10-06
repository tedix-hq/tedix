#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
	_meta?: unknown;
	annotations?: unknown;
	description?: string;
	execution?: { taskSupport?: unknown };
	icons?: unknown;
	inputSchema?: unknown;
	name: string;
	outputSchema?: unknown;
	title?: string;
};

type IdRow = {
	app_id: string | null;
	catalog_app_id: string | null;
};

type ExistingToolRow = {
	surface: "base_app" | "catalog";
	tool: string;
};

type RepairPlan = {
	action: "create" | "update";
	surface: ExistingToolRow["surface"];
	tool: string;
};

const DEFAULT_TOOLS = ["get_site_overview"];

const { values } = parseArgs({
	options: {
		apply: { default: false, type: "boolean" },
		"app-slug": { default: "cms", type: "string" },
		"catalog-slug": { default: "cms", type: "string" },
		"database-name": { type: "string" },
		"connection-label": { type: "string" },
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
		"site-builder-url": {
			type: "string",
		},
		tools: { default: DEFAULT_TOOLS.join(","), type: "string" },
	},
	strict: false,
});

const apply = Boolean(values.apply);
const appSlug = String(values["app-slug"]);
const catalogSlug = String(values["catalog-slug"]);
const databaseName = String(values["database-name"] ?? "");
const json = Boolean(values.json);
const siteBuilderUrl = String(values["site-builder-url"] ?? "");
const tools = String(values.tools)
	.split(",")
	.map((tool) => tool.trim())
	.filter(Boolean);
const apiCwd = fileURLToPath(new URL("../../api", import.meta.url));

if (values.help) {
	console.log(`Usage: bun run cms:mcp:tool-repair [options]

Repairs missing or stale CMS catalog/base app tool rows from the live Site Builder MCP
tools/list surface. This is a production-D1 fallback for when the preferred
catalog.reconcile_app path is unavailable from the current operator session.

Options:
  --apply                 Write production D1 rows. Omit for dry-run.
  --json                  Print machine-readable JSON.
  --tools <a,b,c>         Tool names to repair. Default: get_site_overview.
  --catalog-slug <slug>   Catalog app slug. Default: cms.
  --app-slug <slug>       Base app slug. Default: cms.
  --site-builder-url <url>      Required Site Builder MCP endpoint.
  --connection-label <slug> Required target tenant connection label.
  --database-name <name>  Required D1 database name or apps/api binding.

Needs the installation's Cloudflare credentials in the environment
(CLOUDFLARE_API_TOKEN with D1 edit access, plus CLOUDFLARE_ACCOUNT_ID) for the
remote D1 calls, which resolve the database through apps/api/wrangler.jsonc,
and PLATFORM_SERVICE_TOKEN for the Site Builder calls. Provide the endpoint,
tenant connection label and database target explicitly:
  bun run cms:mcp:tool-repair -- --site-builder-url <url> --connection-label <slug> --database-name <name> --json
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

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!isRecord(value)) return value ?? null;

	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortJson(value[key])]),
	);
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value ?? null));
}

async function sha256Json(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function sqlString(value: string | null | undefined): string {
	return value == null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function toolListLiteral(toolNames: readonly string[]): string {
	return toolNames.map((tool) => sqlString(tool)).join(", ");
}

function titleFromToolName(toolName: string): string {
	return toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeToolTitle(title: unknown): string | null {
	return typeof title === "string" && title.length > 0 ? title : null;
}

function normalizeToolIcons(icons: unknown): unknown[] | null {
	return Array.isArray(icons) ? icons : null;
}

function normalizeToolAnnotations(
	annotations: unknown,
): Record<string, unknown> | null {
	return isRecord(annotations) ? annotations : null;
}

function normalizeToolMeta(meta: unknown): Record<string, unknown> | null {
	return isRecord(meta) ? meta : null;
}

function normalizeExecutionTaskSupport(execution: unknown): string | null {
	if (!isRecord(execution)) return null;
	const taskSupport = execution.taskSupport;
	return taskSupport === "forbidden" ||
		taskSupport === "optional" ||
		taskSupport === "required"
		? taskSupport
		: null;
}

function normalizeInputSchema(schema: unknown): Record<string, unknown> {
	return isRecord(schema)
		? schema
		: { type: "object", properties: {}, additionalProperties: false };
}

function normalizeOutputSchema(
	schema: unknown,
	annotations: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (isRecord(schema)) return schema;
	return annotations?.readOnlyHint === true
		? { type: "object", properties: {}, additionalProperties: true }
		: null;
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
			maxBuffer: 1024 * 1024 * 30,
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

async function siteBuilderToolsList(): Promise<SiteBuilderTool[]> {
	const token = Bun.env.PLATFORM_SERVICE_TOKEN;
	if (!token)
		fail("PLATFORM_SERVICE_TOKEN is required for CMS MCP tool repair");

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
			? (JSON.parse(responseText) as typeof body)
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

if (tools.length === 0) fail("At least one tool must be provided");

const ids = runD1<IdRow>(`
SELECT
  (SELECT id FROM app_catalog WHERE slug=${sqlString(catalogSlug)}) AS catalog_app_id,
  (SELECT id FROM apps WHERE slug=${sqlString(appSlug)}) AS app_id;
`)[0]?.results[0];

if (!ids?.catalog_app_id)
	fail(`Catalog app not found for slug: ${catalogSlug}`);
if (!ids.app_id) fail(`Base app not found for slug: ${appSlug}`);

const existingRows = runD1<ExistingToolRow>(`
SELECT 'catalog' AS surface, tool_name AS tool
FROM app_catalog_mcp_tools
WHERE catalog_app_id=${sqlString(ids.catalog_app_id)}
  AND removed_at IS NULL
  AND tool_name IN (${toolListLiteral(tools)})
UNION ALL
SELECT 'base_app' AS surface, tool_id AS tool
FROM app_tools
WHERE app_id=${sqlString(ids.app_id)}
  AND tool_id IN (${toolListLiteral(tools)});
`)[0]?.results;
const existing = new Set(
	existingRows.map((row) => `${row.surface}:${row.tool}`),
);

const liveTools = await siteBuilderToolsList();
const liveToolsByName = new Map(liveTools.map((tool) => [tool.name, tool]));
const now = new Date().toISOString();
const plans: RepairPlan[] = [];
const statements: string[] = [];

for (const toolName of tools) {
	const tool = liveToolsByName.get(toolName);
	if (!tool) fail(`Site Builder MCP tools/list did not include ${toolName}`);

	const inputSchema = normalizeInputSchema(tool.inputSchema);
	const annotations = normalizeToolAnnotations(tool.annotations);
	const outputSchema = normalizeOutputSchema(tool.outputSchema, annotations);
	const title = normalizeToolTitle(tool.title);
	const appTitle = title ?? titleFromToolName(toolName);
	const icons = normalizeToolIcons(tool.icons);
	const executionTaskSupport = normalizeExecutionTaskSupport(tool.execution);
	const meta = normalizeToolMeta(tool._meta);
	const sourceRef = `${ids.catalog_app_id}:${toolName}`;
	const sourceHash = await sha256Json({
		toolName,
		title,
		description: tool.description ?? null,
		inputSchema,
		outputSchema,
		icons,
		executionTaskSupport,
		annotations,
		meta,
	});

	const inputSchemaText = JSON.stringify(inputSchema);
	const outputSchemaText = outputSchema ? JSON.stringify(outputSchema) : null;
	const iconsText = icons ? JSON.stringify(icons) : null;
	const annotationsText = annotations ? JSON.stringify(annotations) : null;
	const metaText = meta ? JSON.stringify(meta) : null;
	const configText = JSON.stringify({
		transport: "mcp",
		mcpServerUrl: siteBuilderUrl,
		mcpToolName: toolName,
		timeout: 120_000,
		mcpServerId: ids.catalog_app_id,
	});

	plans.push({
		action: existing.has(`catalog:${toolName}`) ? "update" : "create",
		surface: "catalog",
		tool: toolName,
	});
	plans.push({
		action: existing.has(`base_app:${toolName}`) ? "update" : "create",
		surface: "base_app",
		tool: toolName,
	});

	statements.push(`
INSERT INTO app_catalog_mcp_tools (
  id, catalog_app_id, tool_name, title, description, input_schema, output_schema,
  icons, execution_task_support, annotations, meta, detected_at, last_seen_at,
  schema_dialect, schema_source, schema_source_ref, schema_source_hash,
  schema_synced_at, removed_at
)
VALUES (
  ${sqlString(randomUUID())}, ${sqlString(ids.catalog_app_id)}, ${sqlString(toolName)},
  ${sqlString(title)}, ${sqlString(tool.description ?? null)}, ${sqlString(inputSchemaText)},
  ${sqlString(outputSchemaText)}, ${sqlString(iconsText)}, ${sqlString(executionTaskSupport)},
  ${sqlString(annotationsText)}, ${sqlString(metaText)}, ${sqlString(now)}, ${sqlString(now)},
  'json-schema-2020-12', 'mcp', ${sqlString(sourceRef)}, ${sqlString(sourceHash)},
  ${sqlString(now)}, NULL
)
ON CONFLICT(catalog_app_id, tool_name) DO UPDATE SET
  title=excluded.title,
  description=excluded.description,
  input_schema=excluded.input_schema,
  output_schema=excluded.output_schema,
  icons=excluded.icons,
  execution_task_support=excluded.execution_task_support,
  annotations=excluded.annotations,
  meta=excluded.meta,
  last_seen_at=excluded.last_seen_at,
  schema_dialect=excluded.schema_dialect,
  schema_source=excluded.schema_source,
  schema_source_ref=excluded.schema_source_ref,
  schema_source_hash=excluded.schema_source_hash,
  schema_synced_at=excluded.schema_synced_at,
  removed_at=NULL;
`);

	statements.push(`
INSERT INTO app_tools (
  id, app_id, tool_type_id, tool_id, title, description, input_schema,
  output_schema, config, icons, execution_task_support, annotations, meta,
  schema_dialect, schema_source, schema_source_ref, schema_source_hash,
  schema_synced_at, enabled, sort_order, visibility, created_at, updated_at
)
VALUES (
  ${sqlString(randomUUID())}, ${sqlString(ids.app_id)}, 'mcp', ${sqlString(toolName)},
  ${sqlString(appTitle)}, ${sqlString(tool.description ?? null)}, ${sqlString(inputSchemaText)},
  ${sqlString(outputSchemaText)}, ${sqlString(configText)}, ${sqlString(iconsText)},
  ${sqlString(executionTaskSupport)}, ${sqlString(annotationsText)}, ${sqlString(metaText)},
  'json-schema-2020-12', 'mcp', ${sqlString(sourceRef)}, ${sqlString(sourceHash)},
  ${sqlString(now)}, 1, 0, 'public', ${sqlString(now)}, ${sqlString(now)}
)
ON CONFLICT(app_id, tool_id) DO UPDATE SET
  tool_type_id='mcp',
  title=excluded.title,
  description=excluded.description,
  input_schema=excluded.input_schema,
  output_schema=excluded.output_schema,
  config=excluded.config,
  icons=excluded.icons,
  execution_task_support=excluded.execution_task_support,
  annotations=excluded.annotations,
  meta=excluded.meta,
  schema_dialect=excluded.schema_dialect,
  schema_source=excluded.schema_source,
  schema_source_ref=excluded.schema_source_ref,
  schema_source_hash=excluded.schema_source_hash,
  schema_synced_at=excluded.schema_synced_at,
  enabled=1,
  visibility='public',
  updated_at=excluded.updated_at;
`);
}

let finalCounts: {
	base_enabled_tools: number;
	catalog_active_tools: number;
} | null = null;

if (apply) {
	statements.push(`
UPDATE app_catalog
SET
  mcp_tool_count=(
    SELECT COUNT(*)
    FROM app_catalog_mcp_tools
    WHERE catalog_app_id=${sqlString(ids.catalog_app_id)}
      AND removed_at IS NULL
  ),
  health_status='healthy',
  last_synced_at=${sqlString(now)},
  updated_at=${sqlString(now)}
WHERE id=${sqlString(ids.catalog_app_id)};
`);
	statements.push(`
UPDATE apps
SET updated_at=${sqlString(now)}
WHERE id=${sqlString(ids.app_id)};
`);
	statements.push(`
SELECT
  (SELECT COUNT(*) FROM app_catalog_mcp_tools WHERE catalog_app_id=${sqlString(ids.catalog_app_id)} AND removed_at IS NULL) AS catalog_active_tools,
  (SELECT COUNT(*) FROM app_tools WHERE app_id=${sqlString(ids.app_id)} AND enabled=1) AS base_enabled_tools;
`);

	const result = runD1<typeof finalCounts>(statements.join("\n"));
	finalCounts = result.at(-1)?.results?.[0] ?? null;
}

const summary = {
	apply,
	appId: ids.app_id,
	appSlug,
	catalogAppId: ids.catalog_app_id,
	catalogSlug,
	finalCounts,
	plans,
	siteBuilderUrl,
	tools,
};

if (json) {
	console.log(JSON.stringify(summary, null, 2));
} else {
	console.log(
		`${apply ? "Applied" : "Planned"} CMS MCP tool repair for ${tools.join(", ")}.`,
	);
	for (const plan of plans) {
		console.log(`- ${plan.surface}: ${plan.tool} -> ${plan.action}`);
	}
	if (finalCounts) {
		console.log(
			`Catalog active tools: ${finalCounts.catalog_active_tools}; base enabled tools: ${finalCounts.base_enabled_tools}`,
		);
	}
}
