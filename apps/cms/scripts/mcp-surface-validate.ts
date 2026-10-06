#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readSiteBuilderRpcEnvelope } from "./site-builder-rpc";
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

type ValidationResult = {
	catalog?: {
		activeTools: number;
		mcpToolCount: number | null;
		missingExpectedContentOperatorTools: string[];
		missingExpectedThemeTools: string[];
	};
	d1?: {
		baseAppEnabledTools: number;
		baseAppTools: number;
		staleCatalogInputSchemaTools: string[];
		staleCatalogOutputSchemaTools: string[];
		staleInputSchemaAppTools: string[];
		staleOutputSchemaAppTools: string[];
		missingOrDisabledAppTools: string[];
		operatorSchemaIssues: Array<{
			issue: string;
			surface: "base_app" | "catalog";
			tool: string;
		}>;
		themeArtifactSchemaIssues: Array<{
			issue: string;
			surface: "base_app" | "catalog";
			tool: string;
		}>;
		proxyDirectToolRows: Array<{ directToolRows: number; slug: string }>;
	};
	issues: string[];
	ok: boolean;
	siteBuilder?: {
		missingExpectedContentOperatorTools: string[];
		missingExpectedThemeTools: string[];
		authorReadback?: {
			count: number | null;
			durationMs: number;
			fastPath: string | null;
			nativeStatus: number | null;
			source: string;
		};
		bylineReadback?: {
			count: number | null;
			durationMs: number;
			fastPath: string | null;
			filterStrategy: string | null;
			scannedItems: number | null;
			status: "ok" | "skipped";
		};
		operatorReadback?: {
			collectionCount: number | null;
			databaseRuntime: string | null;
			durationMs: number;
			fastPath: string | null;
			mediaRuntime: string | null;
			orgSlug: string | null;
		};
		previewStatus?: unknown;
		toolCount: number;
	};
};

const EXPECTED_THEME_CONTROL_TOOLS = [
	"read_hot_theme",
	"write_hot_theme",
	"list_hot_theme_revisions",
	"rollback_hot_theme",
	"provision_theme_artifact_repo",
	"read_theme_artifact_file",
	"checkout_theme_artifact_source",
	"commit_theme_artifact_files",
	"theme_artifact_commit_status",
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
	"theme_publish_receipt",
	"theme_verify_public_routes",
	"theme_workspace_status",
	"theme_list_versions",
	"theme_rollback",
] as const;

const EXPECTED_PREVIEW_LIFECYCLE_TOOLS = [
	"theme_preview_start",
	"theme_preview_status",
	"theme_preview_stop",
] as const;

const EXPECTED_CONTENT_OPERATOR_TOOLS = [
	"get_site_overview",
	"content_list",
	"list_content_byline_entries",
	"list_content_authors",
	"content_schedule",
	"content_unschedule",
] as const;

const { values } = parseArgs({
	options: {
		"database-name": { type: "string" },
		"connection-label": { type: "string" },
		help: { default: false, type: "boolean" },
		json: { default: false, type: "boolean" },
		"require-fast-path": { default: false, type: "boolean" },
		"skip-d1": { default: false, type: "boolean" },
		"skip-operator-readback": { default: false, type: "boolean" },
		"skip-preview-status": { default: false, type: "boolean" },
		"skip-site-builder": { default: false, type: "boolean" },
		"site-builder-url": {
			type: "string",
		},
	},
	strict: false,
});

const siteBuilderUrl = String(values["site-builder-url"] ?? "");
const databaseName = String(values["database-name"] ?? "");
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const MCP_CLIENT_CAPABILITIES_META_KEY =
	"io.modelcontextprotocol/clientCapabilities";
const apiCwd = fileURLToPath(new URL("../../api", import.meta.url));

if (values.help) {
	console.log(`Usage: bun run cms:mcp:validate [options]

Validates the CMS MCP publication chain:
  Site Builder MCP tools/list -> app_catalog_mcp_tools -> base cms app_tools
and verifies tenant proxy apps still keep zero direct tool rows. The D1 pass
also checks the operator schemas tedis rely on for native content filtering,
site orientation, author discovery, byline-credit readback, and scheduled publishing.

Options:
  --json                  Print machine-readable JSON.
  --require-fast-path     Fail unless read-only operator tools return the sandbox-free fast-path header.
  --skip-site-builder           Skip live Site Builder MCP tools/list.
  --skip-operator-readback Skip live get_site_overview readback.
  --skip-preview-status   Skip live Site Builder theme_preview_status call.
  --skip-d1               Skip production D1 catalog/app readback.
  --site-builder-url <url>      Required Site Builder MCP endpoint.
  --connection-label <slug> Required target tenant connection label.
  --database-name <name>  Required D1 database name or apps/api binding.

Needs the installation's Cloudflare credentials in the environment
(CLOUDFLARE_API_TOKEN with D1 edit access, plus CLOUDFLARE_ACCOUNT_ID) for the
remote D1 calls, which resolve the database through apps/api/wrangler.jsonc,
and PLATFORM_SERVICE_TOKEN for the Site Builder calls. Provide the endpoint,
tenant connection label and database target explicitly:
  bun run cms:mcp:validate -- --site-builder-url <url> --connection-label <slug> --database-name <name> --json
`);
	process.exit(0);
}

if (
	!values["skip-site-builder"] &&
	(!siteBuilderUrl || !values["connection-label"])
) {
	fail(
		"--site-builder-url and --connection-label are required unless --skip-site-builder is set",
	);
}
if (!values["skip-d1"] && !databaseName) {
	fail("--database-name is required unless --skip-d1 is set");
}

function fail(message: string): never {
	throw new Error(message);
}

function expectedListLiteral(): string {
	return EXPECTED_THEME_CONTROL_TOOLS.map((tool) => `'${tool}'`).join(", ");
}

function contentOperatorListLiteral(): string {
	return EXPECTED_CONTENT_OPERATOR_TOOLS.map((tool) => `'${tool}'`).join(", ");
}

function previewLifecycleListLiteral(): string {
	return EXPECTED_PREVIEW_LIFECYCLE_TOOLS.map((tool) => `'${tool}'`).join(", ");
}

function allExpectedToolListLiteral(): string {
	return Array.from(
		new Set([
			...EXPECTED_THEME_CONTROL_TOOLS,
			...EXPECTED_CONTENT_OPERATOR_TOOLS,
		]),
	)
		.map((tool) => `'${tool}'`)
		.join(", ");
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

function canonicalSchemaString(schema: unknown): string | null {
	if (!isRecord(schema)) return null;
	return JSON.stringify(canonicalJson(schema));
}

async function siteBuilderRpcProbe<T>(
	method: string,
	params?: unknown,
): Promise<{ durationMs: number; fastPath: string | null; result: T }> {
	const token = Bun.env.PLATFORM_SERVICE_TOKEN;
	if (!token) {
		fail("PLATFORM_SERVICE_TOKEN is required for Site Builder MCP validation");
	}

	const requestId = crypto.randomUUID();
	const startedAt = Date.now();
	const rpcParams = {
		...(isRecord(params) ? params : {}),
		_meta: {
			[MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
			[MCP_CLIENT_CAPABILITIES_META_KEY]: { extensions: {} },
		},
	};
	const targetName =
		method === "tools/call" && typeof rpcParams.name === "string"
			? rpcParams.name
			: undefined;
	const response = await fetch(siteBuilderUrl, {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
			"Mcp-Method": method,
			...(targetName ? { "Mcp-Name": targetName } : {}),
			"X-Tedix-Connection-Label": String(values["connection-label"]),
		},
		body: JSON.stringify({
			id: requestId,
			jsonrpc: "2.0",
			method,
			params: rpcParams,
		}),
	});
	const durationMs = Date.now() - startedAt;

	// Studio negotiates JSON vs SSE per request (mountMcp responseMode "auto"),
	// so the body must be read through the negotiating reader, not JSON.parse.
	const body = await readSiteBuilderRpcEnvelope(response, requestId);

	if (!response.ok || body.error) {
		fail(
			`Site Builder MCP ${method} failed (${response.status}): ${
				body.error?.message ?? response.statusText
			}`,
		);
	}
	if (
		method === "tools/call" &&
		(!isRecord(body.result) || body.result.resultType !== "complete")
	) {
		fail(
			`Site Builder MCP tools/call returned an invalid resultType: ${
				isRecord(body.result)
					? String(body.result.resultType)
					: "missing result"
			}`,
		);
	}

	return {
		durationMs,
		fastPath: response.headers.get("X-Tedix-CMS-Fast-Path"),
		result: body.result as T,
	};
}

async function siteBuilderRpc<T>(method: string, params?: unknown): Promise<T> {
	return (await siteBuilderRpcProbe<T>(method, params)).result;
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

function missingExpected(
	expected: readonly string[],
	names: Iterable<string>,
): string[] {
	const present = new Set(names);
	return expected.filter((tool) => !present.has(tool));
}

const issues: string[] = [];
const result: ValidationResult = { issues, ok: false };
let liveToolsByName: Map<string, SiteBuilderTool> | undefined;

if (!values["skip-site-builder"]) {
	const discovery = await siteBuilderRpc<{
		supportedVersions?: string[];
	}>("server/discover", {});
	if (!discovery.supportedVersions?.includes(MCP_PROTOCOL_VERSION)) {
		fail(
			`Site Builder MCP server/discover did not advertise ${MCP_PROTOCOL_VERSION}`,
		);
	}
	const list = await siteBuilderRpc<{ tools: SiteBuilderTool[] }>("tools/list");
	liveToolsByName = new Map(list.tools.map((tool) => [tool.name, tool]));
	const toolNames = list.tools.map((tool) => tool.name);
	const missingThemeTools = missingExpected(
		EXPECTED_THEME_CONTROL_TOOLS,
		toolNames,
	);
	const missingContentOperatorTools = missingExpected(
		EXPECTED_CONTENT_OPERATOR_TOOLS,
		toolNames,
	);
	if (missingThemeTools.length > 0) {
		issues.push(
			`Site Builder MCP missing theme-control tools: ${missingThemeTools.join(", ")}`,
		);
	}
	if (missingContentOperatorTools.length > 0) {
		issues.push(
			`Site Builder MCP missing content-operator tools: ${missingContentOperatorTools.join(", ")}`,
		);
	}

	result.siteBuilder = {
		toolCount: list.tools.length,
		missingExpectedThemeTools: missingThemeTools,
		missingExpectedContentOperatorTools: missingContentOperatorTools,
	};

	if (!values["skip-preview-status"]) {
		const status = await siteBuilderRpc("tools/call", {
			name: "theme_preview_status",
			arguments: {},
		});
		result.siteBuilder.previewStatus = status;
	}

	if (!values["skip-operator-readback"]) {
		const readback = await siteBuilderRpcProbe<{
			content?: Array<{ text?: string; type?: string }>;
			structuredContent?: unknown;
		}>("tools/call", {
			name: "get_site_overview",
			arguments: {
				includeMenus: false,
				includePlugins: false,
				includeTaxonomies: false,
				maxFieldsPerCollection: 4,
			},
		});
		const text = readback.result.content?.[0]?.text;
		let overview: Record<string, unknown> | undefined;
		try {
			overview =
				typeof text === "string"
					? (JSON.parse(text) as Record<string, unknown>)
					: undefined;
		} catch {
			overview = undefined;
		}

		const collections = Array.isArray(overview?.collections)
			? overview.collections
			: null;
		const mediaRuntime =
			overview?.mediaRuntime &&
			typeof overview.mediaRuntime === "object" &&
			!Array.isArray(overview.mediaRuntime)
				? String(
						(overview.mediaRuntime as Record<string, unknown>)
							.responsiveSrcsetStatus ?? "",
					) || null
				: null;
		const databaseRuntime =
			overview?.databaseRuntime &&
			typeof overview.databaseRuntime === "object" &&
			!Array.isArray(overview.databaseRuntime)
				? String(
						(overview.databaseRuntime as Record<string, unknown>)
							.currentBackend ?? "",
					) || null
				: null;

		if (!overview?.orgSlug) {
			issues.push(
				"Site Builder MCP get_site_overview readback did not return orgSlug",
			);
		}
		if (!collections) {
			issues.push(
				"Site Builder MCP get_site_overview readback did not return collections",
			);
		}
		if (!Array.isArray(overview?.operatorHints)) {
			issues.push(
				"Site Builder MCP get_site_overview readback did not return operatorHints",
			);
		}
		if (!mediaRuntime) {
			issues.push(
				"Site Builder MCP get_site_overview readback did not return mediaRuntime",
			);
		}
		if (!databaseRuntime) {
			issues.push(
				"Site Builder MCP get_site_overview readback did not return databaseRuntime",
			);
		}
		if (values["require-fast-path"] && readback.fastPath !== "sandbox-free") {
			issues.push(
				`Site Builder MCP get_site_overview did not use sandbox-free fast path (header=${readback.fastPath ?? "missing"})`,
			);
		}

		result.siteBuilder.operatorReadback = {
			collectionCount: collections?.length ?? null,
			databaseRuntime,
			durationMs: readback.durationMs,
			fastPath: readback.fastPath,
			mediaRuntime,
			orgSlug: typeof overview?.orgSlug === "string" ? overview.orgSlug : null,
		};

		const authorReadback = await siteBuilderRpcProbe<{
			content?: Array<{ text?: string; type?: string }>;
			structuredContent?: unknown;
		}>("tools/call", {
			name: "list_content_authors",
			arguments: { collection: "posts" },
		});
		const authorText = authorReadback.result.content?.[0]?.text;
		let authorPayload: Record<string, unknown> | undefined;
		try {
			authorPayload =
				typeof authorText === "string"
					? (JSON.parse(authorText) as Record<string, unknown>)
					: undefined;
		} catch {
			authorPayload = undefined;
		}
		const authorData = isRecord(authorPayload?.data)
			? authorPayload.data
			: authorPayload;
		const authorItems = Array.isArray(authorData?.items)
			? authorData.items
			: null;
		const tedixMeta = isRecord(authorData?._tedix)
			? authorData._tedix
			: isRecord(authorPayload?._tedix)
				? authorPayload._tedix
				: null;
		const authorSource =
			typeof tedixMeta?.source === "string" ? tedixMeta.source : "native";
		const nativeStatus =
			typeof tedixMeta?.nativeStatus === "number"
				? tedixMeta.nativeStatus
				: null;

		if (!authorItems) {
			issues.push(
				"Site Builder MCP list_content_authors readback did not return data.items",
			);
		}
		if (
			authorItems?.some((item) => {
				if (!isRecord(item)) return true;
				if (typeof item.id !== "string") return true;
				if (authorSource === "native") return false;
				return (
					typeof item.filterableByAuthorId !== "boolean" ||
					typeof item.source !== "string"
				);
			})
		) {
			issues.push(
				"Site Builder MCP list_content_authors readback returned items without tedi-safe source/filter metadata",
			);
		}
		if (
			authorSource !== "native" &&
			authorSource !== "content_list_authorId_fallback" &&
			authorSource !== "content_list_byline_fallback"
		) {
			issues.push(
				`Site Builder MCP list_content_authors returned unexpected source: ${authorSource}`,
			);
		}
		if (
			values["require-fast-path"] &&
			authorReadback.fastPath !== "sandbox-free"
		) {
			issues.push(
				`Site Builder MCP list_content_authors did not use sandbox-free fast path (header=${authorReadback.fastPath ?? "missing"})`,
			);
		}

		result.siteBuilder.authorReadback = {
			count: authorItems?.length ?? null,
			durationMs: authorReadback.durationMs,
			fastPath: authorReadback.fastPath,
			nativeStatus,
			source: authorSource,
		};

		const bylineCandidate = authorItems?.find(
			(item) =>
				isRecord(item) &&
				item.filterableByAuthorId === false &&
				(typeof item.bylineId === "string" || typeof item.id === "string"),
		);
		if (isRecord(bylineCandidate)) {
			const bylineId =
				typeof bylineCandidate.bylineId === "string"
					? bylineCandidate.bylineId
					: String(bylineCandidate.id);
			const bylineReadback = await siteBuilderRpcProbe<{
				content?: Array<{ text?: string; type?: string }>;
			}>("tools/call", {
				name: "list_content_byline_entries",
				arguments: {
					collection: "posts",
					bylineId,
					limit: 3,
					scanLimit: 50,
				},
			});
			const bylineText = bylineReadback.result.content?.[0]?.text;
			let bylinePayload: Record<string, unknown> | undefined;
			try {
				bylinePayload =
					typeof bylineText === "string"
						? (JSON.parse(bylineText) as Record<string, unknown>)
						: undefined;
			} catch {
				bylinePayload = undefined;
			}
			const bylineData = isRecord(bylinePayload?.data)
				? bylinePayload.data
				: bylinePayload;
			const bylineItems = Array.isArray(bylineData?.items)
				? bylineData.items
				: null;
			const bylineMeta = isRecord(bylineData?._tedix)
				? bylineData._tedix
				: null;
			const filterStrategy =
				typeof bylineMeta?.filterStrategy === "string"
					? bylineMeta.filterStrategy
					: null;
			const scannedItems =
				typeof bylineMeta?.scannedItems === "number"
					? bylineMeta.scannedItems
					: null;
			if (!bylineItems) {
				issues.push(
					"Site Builder MCP list_content_byline_entries readback did not return data.items",
				);
			}
			if (filterStrategy !== "bounded_hydrated_byline_scan") {
				issues.push(
					`Site Builder MCP list_content_byline_entries returned unexpected filter strategy: ${filterStrategy ?? "missing"}`,
				);
			}
			if (
				values["require-fast-path"] &&
				bylineReadback.fastPath !== "sandbox-free"
			) {
				issues.push(
					`Site Builder MCP list_content_byline_entries did not use sandbox-free fast path (header=${bylineReadback.fastPath ?? "missing"})`,
				);
			}
			result.siteBuilder.bylineReadback = {
				count: bylineItems?.length ?? null,
				durationMs: bylineReadback.durationMs,
				fastPath: bylineReadback.fastPath,
				filterStrategy,
				scannedItems,
				status: "ok",
			};
		} else {
			result.siteBuilder.bylineReadback = {
				count: null,
				durationMs: 0,
				fastPath: null,
				filterStrategy: null,
				scannedItems: null,
				status: "skipped",
			};
		}
	}
}

if (!values["skip-d1"]) {
	const expectedTools = expectedListLiteral();
	const allExpectedTools = allExpectedToolListLiteral();
	const contentOperatorTools = contentOperatorListLiteral();
	const previewLifecycleTools = previewLifecycleListLiteral();
	const [
		catalog,
		catalogThemeTools,
		catalogContentOperatorTools,
		appCounts,
		missingAppRows,
		staleCatalogOutputSchemas,
		staleAppOutputSchemas,
		proxyRows,
		schemaRows,
	] = runD1<{
		active_tools?: number;
		base_app_enabled_tools?: number;
		base_app_tools?: number;
		direct_tool_rows?: number;
		enabled?: number;
		input_schema?: string | null;
		issue?: string;
		mcp_tool_count?: number | null;
		output_schema?: string | null;
		slug?: string;
		surface?: "base_app" | "catalog";
		tool_id?: string;
		tool_name?: string;
		tool_rows?: number;
	}>(`
SELECT ac.mcp_tool_count, COUNT(mt.id) AS active_tools
FROM app_catalog ac
LEFT JOIN app_catalog_mcp_tools mt
  ON mt.catalog_app_id = ac.id AND mt.removed_at IS NULL
WHERE ac.slug = 'cms'
GROUP BY ac.id, ac.mcp_tool_count;

SELECT mt.tool_name
FROM app_catalog_mcp_tools mt
WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
  AND mt.removed_at IS NULL
  AND mt.tool_name IN (${expectedTools})
ORDER BY mt.tool_name;

SELECT mt.tool_name
FROM app_catalog_mcp_tools mt
WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
  AND mt.removed_at IS NULL
  AND mt.tool_name IN (${contentOperatorTools})
ORDER BY mt.tool_name;

SELECT COUNT(t.id) AS base_app_tools,
       SUM(CASE WHEN t.enabled THEN 1 ELSE 0 END) AS base_app_enabled_tools
FROM app_tools t
JOIN apps a ON a.id = t.app_id
WHERE a.slug = 'cms';

SELECT mt.tool_name, COALESCE(t.enabled, 0) AS enabled
FROM app_catalog_mcp_tools mt
LEFT JOIN apps a ON a.slug = 'cms'
LEFT JOIN app_tools t ON t.app_id = a.id AND t.tool_id = mt.tool_name
WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
  AND mt.removed_at IS NULL
  AND (t.id IS NULL OR t.enabled != 1)
ORDER BY mt.tool_name;

SELECT mt.tool_name
FROM app_catalog_mcp_tools mt
WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
  AND mt.removed_at IS NULL
  AND mt.tool_name IN (${previewLifecycleTools})
  AND (
    COALESCE(json_extract(mt.output_schema, '$.properties.status.type'), '') != 'string'
    OR json_type(mt.output_schema, '$.properties.previewUrlMode') IS NULL
    OR COALESCE(json_extract(mt.output_schema, '$.properties.previewUrlEphemeral.type'), '') != 'boolean'
  )
ORDER BY mt.tool_name;

SELECT t.tool_id
FROM app_tools t
JOIN apps a ON a.id = t.app_id
WHERE a.slug = 'cms'
  AND t.tool_id IN (${previewLifecycleTools})
  AND (
    COALESCE(json_extract(t.output_schema, '$.properties.status.type'), '') != 'string'
    OR json_type(t.output_schema, '$.properties.previewUrlMode') IS NULL
    OR COALESCE(json_extract(t.output_schema, '$.properties.previewUrlEphemeral.type'), '') != 'boolean'
  )
ORDER BY t.tool_id;

SELECT a.slug, COUNT(t.id) AS direct_tool_rows
FROM apps a
LEFT JOIN app_tools t ON t.app_id = a.id
WHERE a.slug LIKE 'cms-%'
GROUP BY a.slug
ORDER BY a.slug;

SELECT 'catalog' AS surface, mt.tool_name AS tool_name, mt.input_schema, mt.output_schema
FROM app_catalog_mcp_tools mt
WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
  AND mt.removed_at IS NULL
  AND mt.tool_name IN (${allExpectedTools})
UNION ALL
SELECT 'base_app' AS surface, t.tool_id AS tool_name, t.input_schema, t.output_schema
FROM app_tools t
JOIN apps a ON a.id = t.app_id
WHERE a.slug = 'cms'
  AND t.tool_id IN (${allExpectedTools})
ORDER BY surface, tool_name;
`);

	const [operatorSchemaIssues] = runD1<{
		issue?: string;
		surface?: "base_app" | "catalog";
		tool_name?: string;
	}>(`
WITH cms_tool_schemas AS (
  SELECT 'catalog' AS surface, mt.tool_name AS tool_name, mt.input_schema, mt.output_schema
  FROM app_catalog_mcp_tools mt
  WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
    AND mt.removed_at IS NULL
    AND mt.tool_name IN (${contentOperatorTools})
  UNION ALL
  SELECT 'base_app' AS surface, t.tool_id AS tool_name, t.input_schema, t.output_schema
  FROM app_tools t
  JOIN apps a ON a.id = t.app_id
  WHERE a.slug = 'cms'
    AND t.tool_id IN (${contentOperatorTools})
)
SELECT surface, tool_name, issue
FROM (
  SELECT surface,
         tool_name,
         CASE
           WHEN tool_name = 'content_list'
            AND (
              json_type(input_schema, '$.properties.authorId') IS NULL
              OR json_type(input_schema, '$.properties.dateField') IS NULL
              OR json_type(input_schema, '$.properties.dateFrom') IS NULL
              OR json_type(input_schema, '$.properties.dateTo') IS NULL
            )
            THEN 'content_list_filter_inputs'
           WHEN tool_name = 'list_content_byline_entries'
            AND (
              json_type(input_schema, '$.properties.bylineId') IS NULL
              OR json_type(input_schema, '$.properties.bylineIds') IS NULL
              OR json_type(input_schema, '$.properties.scanLimit') IS NULL
              OR json_type(output_schema, '$.properties.items') IS NULL
            )
            THEN 'list_content_byline_entries_shape'
           WHEN tool_name = 'get_site_overview'
            AND (
              json_type(input_schema, '$.properties.locale') IS NULL
              OR json_type(input_schema, '$.properties.includeRecentContent') IS NULL
              OR json_type(input_schema, '$.properties.maxFieldsPerCollection') IS NULL
              OR json_type(output_schema, '$.properties.collections') IS NULL
              OR json_type(output_schema, '$.properties.databaseRuntime') IS NULL
              OR json_type(output_schema, '$.properties.operatorHints') IS NULL
            )
            THEN 'get_site_overview_shape'
           WHEN tool_name = 'content_schedule'
            AND (
              json_type(input_schema, '$.properties.locale') IS NULL
              OR json_type(input_schema, '$.properties.scheduledAt') IS NULL
            )
            THEN 'content_schedule_inputs'
           WHEN tool_name = 'content_unschedule'
            AND json_type(input_schema, '$.properties.locale') IS NULL
            THEN 'content_unschedule_locale_input'
           WHEN tool_name = 'list_content_authors'
            AND (
              json_type(input_schema, '$.properties.collection') IS NULL
              OR json_type(output_schema, '$.properties.items') IS NULL
            )
            THEN 'list_content_authors_shape'
         END AS issue
  FROM cms_tool_schemas
)
WHERE issue IS NOT NULL
ORDER BY surface, tool_name, issue;
`);

	const [themeArtifactSchemaIssues] = runD1<{
		issue?: string;
		surface?: "base_app" | "catalog";
		tool_name?: string;
	}>(`
WITH cms_tool_schemas AS (
  SELECT 'catalog' AS surface, mt.tool_name AS tool_name, mt.input_schema, mt.output_schema
  FROM app_catalog_mcp_tools mt
  WHERE mt.catalog_app_id = (SELECT id FROM app_catalog WHERE slug='cms')
    AND mt.removed_at IS NULL
    AND mt.tool_name IN ('provision_theme_artifact_repo', 'theme_artifact_seed_status', 'theme_artifact_seed_cancel')
  UNION ALL
  SELECT 'base_app' AS surface, t.tool_id AS tool_name, t.input_schema, t.output_schema
  FROM app_tools t
  JOIN apps a ON a.id = t.app_id
  WHERE a.slug = 'cms'
    AND t.tool_id IN ('provision_theme_artifact_repo', 'theme_artifact_seed_status', 'theme_artifact_seed_cancel')
)
SELECT surface, tool_name, issue
FROM (
  SELECT surface,
         tool_name,
         CASE
           WHEN tool_name = 'provision_theme_artifact_repo'
            AND (json_type(input_schema, '$.properties.seedFromSandbox') IS NULL
             OR json_type(input_schema, '$.properties.forceSeed') IS NULL
             OR json_type(output_schema, '$.properties.seedJob') IS NULL
             OR json_type(output_schema, '$.properties.seedJob.properties.jobId') IS NULL
             OR json_type(output_schema, '$.properties.seedJob.properties.status') IS NULL)
           THEN 'theme_artifact_seed_launch_shape'
           WHEN tool_name = 'theme_artifact_seed_status'
            AND (json_type(input_schema, '$.properties.jobId') IS NULL
             OR json_type(output_schema, '$.properties.status') IS NULL
             OR json_type(output_schema, '$.properties.seed') IS NULL
             OR json_type(output_schema, '$.properties.stdoutTail') IS NULL
             OR json_type(output_schema, '$.properties.stderrTail') IS NULL)
           THEN 'theme_artifact_seed_status_shape'
           WHEN tool_name = 'theme_artifact_seed_cancel'
            AND (json_type(input_schema, '$.properties.jobId') IS NULL
             OR json_type(output_schema, '$.properties.status') IS NULL
             OR json_type(output_schema, '$.properties.cancelled') IS NULL
             OR json_type(output_schema, '$.properties.previousStatus') IS NULL)
           THEN 'theme_artifact_seed_shape'
         END AS issue
  FROM cms_tool_schemas
)
WHERE issue IS NOT NULL
ORDER BY surface, tool_name, issue;
`);

	const catalogRow = catalog.results[0] ?? {};
	const catalogThemeToolNames = catalogThemeTools.results
		.map((row) => row.tool_name)
		.filter((name): name is string => typeof name === "string");
	const catalogContentOperatorToolNames = catalogContentOperatorTools.results
		.map((row) => row.tool_name)
		.filter((name): name is string => typeof name === "string");
	const missingCatalogThemeTools = missingExpected(
		EXPECTED_THEME_CONTROL_TOOLS,
		catalogThemeToolNames,
	);
	const missingCatalogContentOperatorTools = missingExpected(
		EXPECTED_CONTENT_OPERATOR_TOOLS,
		catalogContentOperatorToolNames,
	);
	const missingOrDisabledAppTools = missingAppRows.results
		.map((row) => row.tool_name)
		.filter((name): name is string => typeof name === "string");
	const staleCatalogOutputSchemaTools = staleCatalogOutputSchemas.results
		.map((row) => row.tool_name)
		.filter((name): name is string => typeof name === "string");
	const staleOutputSchemaAppTools = staleAppOutputSchemas.results
		.map((row) => row.tool_id)
		.filter((name): name is string => typeof name === "string");
	const staleCatalogInputSchemaTools = new Set<string>();
	const staleCatalogOutputSchemaToolsFromLive = new Set<string>();
	const staleInputSchemaAppTools = new Set<string>();
	const staleOutputSchemaAppToolsFromLive = new Set<string>();
	if (liveToolsByName) {
		for (const row of schemaRows.results) {
			const surface = row.surface === "base_app" ? "base_app" : "catalog";
			const toolName = String(row.tool_name);
			const liveTool = liveToolsByName.get(toolName);
			const liveInputSchema = canonicalSchemaString(liveTool?.inputSchema);
			const liveOutputSchema = canonicalSchemaString(liveTool?.outputSchema);
			const storedInputSchema = row.input_schema
				? canonicalSchemaString(JSON.parse(row.input_schema))
				: null;
			const storedOutputSchema = row.output_schema
				? canonicalSchemaString(JSON.parse(row.output_schema))
				: null;
			if (liveInputSchema && storedInputSchema !== liveInputSchema) {
				(surface === "catalog"
					? staleCatalogInputSchemaTools
					: staleInputSchemaAppTools
				).add(toolName);
			}
			if (liveOutputSchema && storedOutputSchema !== liveOutputSchema) {
				(surface === "catalog"
					? staleCatalogOutputSchemaToolsFromLive
					: staleOutputSchemaAppToolsFromLive
				).add(toolName);
			}
		}
	}
	const contentOperatorSchemaIssues = operatorSchemaIssues.results.map(
		(row) => ({
			issue: String(row.issue),
			surface: row.surface === "base_app" ? "base_app" : "catalog",
			tool: String(row.tool_name),
		}),
	);
	const themeArtifactOperatorSchemaIssues =
		themeArtifactSchemaIssues.results.map((row) => ({
			issue: String(row.issue),
			surface: row.surface === "base_app" ? "base_app" : "catalog",
			tool: String(row.tool_name),
		}));
	const proxyDirectToolRows = proxyRows.results.map((row) => ({
		slug: String(row.slug),
		directToolRows: Number(row.direct_tool_rows ?? 0),
	}));
	const baseCounts = appCounts.results[0] ?? {};

	if (missingCatalogThemeTools.length > 0) {
		issues.push(
			`Catalog snapshot missing theme-control tools: ${missingCatalogThemeTools.join(", ")}`,
		);
	}
	if (missingCatalogContentOperatorTools.length > 0) {
		issues.push(
			`Catalog snapshot missing content-operator tools: ${missingCatalogContentOperatorTools.join(", ")}`,
		);
	}
	if (missingOrDisabledAppTools.length > 0) {
		issues.push(
			`Base cms app missing or disabled tools: ${missingOrDisabledAppTools.join(", ")}`,
		);
	}
	if (staleCatalogOutputSchemaTools.length > 0) {
		issues.push(
			`Catalog preview lifecycle tools have stale output schemas: ${staleCatalogOutputSchemaTools.join(", ")}`,
		);
	}
	if (staleOutputSchemaAppTools.length > 0) {
		issues.push(
			`Base cms preview lifecycle tools have stale output schemas: ${staleOutputSchemaAppTools.join(", ")}`,
		);
	}
	if (staleCatalogInputSchemaTools.size > 0) {
		issues.push(
			`Catalog tools have input schemas that differ from live Site Builder: ${Array.from(staleCatalogInputSchemaTools).join(", ")}`,
		);
	}
	if (staleInputSchemaAppTools.size > 0) {
		issues.push(
			`Base cms tools have input schemas that differ from live Site Builder: ${Array.from(staleInputSchemaAppTools).join(", ")}`,
		);
	}
	if (staleCatalogOutputSchemaToolsFromLive.size > 0) {
		issues.push(
			`Catalog tools have output schemas that differ from live Site Builder: ${Array.from(staleCatalogOutputSchemaToolsFromLive).join(", ")}`,
		);
	}
	if (staleOutputSchemaAppToolsFromLive.size > 0) {
		issues.push(
			`Base cms tools have output schemas that differ from live Site Builder: ${Array.from(staleOutputSchemaAppToolsFromLive).join(", ")}`,
		);
	}
	if (contentOperatorSchemaIssues.length > 0) {
		issues.push(
			`Content-operator tool schemas are stale: ${contentOperatorSchemaIssues
				.map((row) => `${row.surface}/${row.tool}/${row.issue}`)
				.join(", ")}`,
		);
	}
	if (themeArtifactOperatorSchemaIssues.length > 0) {
		issues.push(
			`Theme Artifact tool schemas are stale: ${themeArtifactOperatorSchemaIssues
				.map((row) => `${row.surface}/${row.tool}/${row.issue}`)
				.join(", ")}`,
		);
	}
	for (const proxy of proxyDirectToolRows) {
		if (proxy.directToolRows !== 0) {
			issues.push(
				`Proxy app ${proxy.slug} has ${proxy.directToolRows} direct tool rows; expected 0`,
			);
		}
	}
	if (
		Number(catalogRow.active_tools ?? 0) !==
		Number(baseCounts.base_app_enabled_tools ?? 0)
	) {
		issues.push(
			`Catalog active tool count (${catalogRow.active_tools ?? 0}) does not match base cms enabled rows (${baseCounts.base_app_enabled_tools ?? 0})`,
		);
	}

	result.catalog = {
		activeTools: Number(catalogRow.active_tools ?? 0),
		mcpToolCount:
			catalogRow.mcp_tool_count === null ||
			catalogRow.mcp_tool_count === undefined
				? null
				: Number(catalogRow.mcp_tool_count),
		missingExpectedThemeTools: missingCatalogThemeTools,
		missingExpectedContentOperatorTools: missingCatalogContentOperatorTools,
	};
	result.d1 = {
		baseAppTools: Number(baseCounts.base_app_tools ?? 0),
		baseAppEnabledTools: Number(baseCounts.base_app_enabled_tools ?? 0),
		missingOrDisabledAppTools,
		staleCatalogInputSchemaTools: Array.from(staleCatalogInputSchemaTools),
		staleCatalogOutputSchemaTools,
		staleInputSchemaAppTools: Array.from(staleInputSchemaAppTools),
		staleOutputSchemaAppTools,
		operatorSchemaIssues: contentOperatorSchemaIssues,
		themeArtifactSchemaIssues: themeArtifactOperatorSchemaIssues,
		proxyDirectToolRows,
	};
}

result.ok = issues.length === 0;

if (values.json) {
	console.log(JSON.stringify(result, null, 2));
} else if (result.ok) {
	console.log("CMS MCP surface validation passed.");
	if (result.siteBuilder)
		console.log(`Site Builder tools: ${result.siteBuilder.toolCount}`);
	if (result.catalog && result.d1) {
		console.log(
			`D1 catalog/app tools: ${result.catalog.activeTools}/${result.d1.baseAppEnabledTools}`,
		);
	}
} else {
	console.error("CMS MCP surface validation failed:");
	for (const issue of issues) console.error(`- ${issue}`);
}

process.exit(result.ok ? 0 : 1);
