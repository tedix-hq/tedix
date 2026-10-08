/**
 * App Catalog Queries — Shared private helpers and cross-section types.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	EMPTY_TOOL_INPUT_SCHEMA,
	type ToolAnnotations,
	type ToolExecutionTaskSupport,
	type ToolIcon,
	type ToolInputJsonSchema,
	ToolInputJsonSchemaSchema,
	type ToolJsonSchema,
	ToolJsonSchemaSchema,
	type ToolSchemaDialect,
	type ToolSchemaSource,
} from "@tedix/api-contract/schemas/tools";
import type { DbClient } from "../../client";
import type {
	appCatalog,
	CatalogApp,
	CatalogToolSource,
} from "../../schema/catalog";
import type { appTools } from "../../schema/index";
import { toJsonRecord } from "../../utils/json";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export type Database = DbClient;

export type ConnectionScope = "tenant" | "user" | "hybrid";

export class CatalogProxyAppToolMutationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogProxyAppToolMutationError";
	}
}

interface AppMcpConfigLike {
	autoSync?: boolean;
	connectionProviderId?: string;
	connectionScope?: ConnectionScope;
	connectionScopes?: string[];
	aggregateApps?: unknown[];
}

export function readAppMcpConfig(app: {
	metadata?: unknown;
}): AppMcpConfigLike {
	const metadata = (() => {
		if (typeof app.metadata === "string") {
			try {
				const parsed = JSON.parse(app.metadata);
				return parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: {};
			} catch {
				return {};
			}
		}
		return typeof app.metadata === "object" && app.metadata !== null
			? (app.metadata as Record<string, unknown>)
			: {};
	})();
	const mcpConfig =
		typeof metadata.mcpConfig === "object" && metadata.mcpConfig !== null
			? (metadata.mcpConfig as Record<string, unknown>)
			: {};
	return {
		autoSync:
			typeof mcpConfig.autoSync === "boolean" ? mcpConfig.autoSync : undefined,
		connectionProviderId:
			typeof mcpConfig.connectionProviderId === "string"
				? mcpConfig.connectionProviderId
				: undefined,
		connectionScope:
			mcpConfig.connectionScope === "user" ||
			mcpConfig.connectionScope === "tenant" ||
			mcpConfig.connectionScope === "hybrid"
				? mcpConfig.connectionScope
				: undefined,
		connectionScopes: Array.isArray(mcpConfig.connectionScopes)
			? mcpConfig.connectionScopes.filter(
					(scope): scope is string => typeof scope === "string",
				)
			: undefined,
		aggregateApps: Array.isArray(mcpConfig.aggregateApps)
			? mcpConfig.aggregateApps
			: undefined,
	};
}

export function hasAggregateAppOverlay(app: { metadata?: unknown }): boolean {
	const mcpConfig = readAppMcpConfig(app);
	return Boolean(mcpConfig.aggregateApps && mcpConfig.aggregateApps.length > 0);
}

export function inferCatalogConnectionScope(
	catalogApp: Pick<CatalogApp, "authTypes">,
	explicitScope?: ConnectionScope,
	fallbackScope?: ConnectionScope,
): ConnectionScope {
	if (explicitScope) return explicitScope;
	if (fallbackScope) return fallbackScope;
	const authTypes = new Set(
		(catalogApp.authTypes ?? []).map((type) => type.toUpperCase()),
	);
	return authTypes.has("OAUTH") ? "hybrid" : "tenant";
}

/**
 * Whether a catalog app authenticates via a stored connection (OAuth or API
 * key). Such apps MUST carry a connectionProviderId so synced tools get
 * `auth.type:"connection"` — without it every tool is auth-less and all
 * upstream calls 401. The provider id is deterministic (= catalog slug, the
 * same id createProviderFromMcp pins), so it's a safe default when the caller
 * doesn't pass one explicitly.
 */
export function catalogAppUsesConnection(
	catalogApp: Pick<CatalogApp, "authTypes">,
): boolean {
	const authTypes = new Set(
		(catalogApp.authTypes ?? []).map((type) => type.toUpperCase()),
	);
	return authTypes.has("OAUTH") || authTypes.has("API_KEY");
}

export interface CatalogMcpToolSyncInput {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	icons?: ToolIcon[];
	annotations?: ToolAnnotations;
	execution?: {
		taskSupport?: ToolExecutionTaskSupport;
	};
	_meta?: Record<string, unknown>;
	schemaDialect?: ToolSchemaDialect | null;
	schemaSource?: ToolSchemaSource | null;
	schemaSourceRef?: string | null;
	schemaSourceHash?: string | null;
	schemaSyncedAt?: string | null;
}

export function normalizeMcpInputSchema(schema: unknown): ToolInputJsonSchema {
	const parsed = ToolInputJsonSchemaSchema.safeParse(schema);
	return parsed.success ? parsed.data : EMPTY_TOOL_INPUT_SCHEMA;
}

export function normalizeMcpOutputSchema(
	schema: unknown,
): ToolJsonSchema | null {
	if (schema == null) return null;
	const parsed = ToolJsonSchemaSchema.safeParse(schema);
	return parsed.success ? parsed.data : null;
}

const EXTERNAL_TOOL_OUTPUT_SCHEMA = ToolJsonSchemaSchema.parse({
	type: "object",
	properties: {},
	additionalProperties: true,
});
const MCP_READ_ONLY_TOOL_OUTPUT_SCHEMA = ToolJsonSchemaSchema.parse({
	type: "object",
	properties: {},
	additionalProperties: true,
});

export function mcpToolOutputSchema(
	outputSchema: unknown,
	annotations: ToolAnnotations | null,
): ToolJsonSchema | null {
	return (
		normalizeMcpOutputSchema(outputSchema) ??
		(annotations?.readOnlyHint === true
			? MCP_READ_ONLY_TOOL_OUTPUT_SCHEMA
			: null)
	);
}

function externalToolMethod(config: unknown): string | null {
	if (!isRecord(config)) return null;
	if (config.transport !== "external") return null;
	return typeof config.method === "string"
		? config.method.toUpperCase()
		: "GET";
}

export function inferExternalToolOutputSchema(
	config: unknown,
): ToolJsonSchema | null {
	return externalToolMethod(config) ? EXTERNAL_TOOL_OUTPUT_SCHEMA : null;
}

export function inferExternalToolAnnotations(
	config: unknown,
): ToolAnnotations | null {
	const method = externalToolMethod(config);
	if (!method) return null;
	return {
		readOnlyHint: method === "GET",
		destructiveHint: method === "DELETE",
		idempotentHint: ["GET", "PUT", "DELETE"].includes(method),
		openWorldHint: true,
	};
}

/**
 * Key-collation contract: object keys sort by default UTF-16 codepoint order
 * (`Array.prototype.sort()`). Feeds `catalogMcpToolSourceHash` — a PERSISTED
 * source digest — so changing the collation (or "unifying" with the
 * localeCompare-sorted `canonicalJson` in
 * `@tedix/tedi-codemode-core/failure-budget`) would invalidate every stored
 * hash and force spurious tool re-syncs. Do not unify.
 */
function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value ?? null));
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

export function jsonEqual(left: unknown, right: unknown): boolean {
	return canonicalJson(left) === canonicalJson(right);
}

async function sha256Json(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function catalogMcpToolSourceRef(
	catalogAppId: string,
	toolName: string,
): string {
	return `${catalogAppId}:${toolName}`;
}

export function ownsCatalogMcpTool(
	tool: typeof appTools.$inferSelect,
	catalogAppId: string,
): boolean {
	const config = (tool.config as Record<string, unknown> | null) ?? {};
	const expectedSourceRef = catalogMcpToolSourceRef(catalogAppId, tool.toolId);
	return (
		config.transport === "mcp" &&
		(config.mcpServerId === catalogAppId ||
			tool.schemaSourceRef === expectedSourceRef)
	);
}

export async function catalogMcpToolSourceHash(input: {
	toolName: string;
	title: string | null;
	description: string | null;
	inputSchema: ToolInputJsonSchema;
	outputSchema: ToolJsonSchema | null;
	icons: ToolIcon[] | null;
	executionTaskSupport: ToolExecutionTaskSupport | null;
	annotations: ToolAnnotations | null;
	meta: Record<string, unknown> | null;
}): Promise<string> {
	return sha256Json(input);
}

export function titleFromToolName(toolName: string): string {
	return toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function normalizeToolTitle(title: unknown): string | null {
	return typeof title === "string" && title.length > 0 ? title : null;
}

export function normalizeToolIcons(icons: unknown): ToolIcon[] | null {
	return Array.isArray(icons) ? (icons as ToolIcon[]) : null;
}

const TOOL_ANNOTATION_HINT_KEYS = [
	"readOnlyHint",
	"destructiveHint",
	"idempotentHint",
	"openWorldHint",
] as const;

/**
 * `_meta` key that keeps upstream annotation keys the MCP `ToolAnnotations`
 * shape does not define (`cost`, `progressHint`, `x-openai-*`, ...). Stored
 * annotations must match `ToolAnnotationsSchema` exactly: the catalog read
 * path validates against it, and one foreign key makes the whole entry
 * unreadable.
 */
export const UPSTREAM_TOOL_ANNOTATIONS_META_KEY = "tedix/upstreamAnnotations";

export interface SplitToolAnnotationsResult {
	/** `title` (string) and the four boolean hints; null when none remain. */
	annotations: ToolAnnotations | null;
	/** Every other key, or a known key with the wrong type; null when none. */
	extras: Record<string, JsonValue> | null;
}

export function splitToolAnnotations(
	annotations: unknown,
): SplitToolAnnotationsResult {
	if (!isRecord(annotations)) return { annotations: null, extras: null };
	const kept: ToolAnnotations = {};
	const extras: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(annotations)) {
		if (value === undefined) continue;
		if (key === "title" && typeof value === "string") {
			kept.title = value;
		} else if (
			(TOOL_ANNOTATION_HINT_KEYS as readonly string[]).includes(key) &&
			typeof value === "boolean"
		) {
			kept[key as (typeof TOOL_ANNOTATION_HINT_KEYS)[number]] = value;
		} else {
			extras[key] = value;
		}
	}
	return {
		annotations: Object.keys(kept).length > 0 ? kept : null,
		extras: Object.keys(extras).length > 0 ? toJsonRecord(extras) : null,
	};
}

export function normalizeToolAnnotations(
	annotations: unknown,
): ToolAnnotations | null {
	return splitToolAnnotations(annotations).annotations;
}

/**
 * Fold upstream annotation keys that `ToolAnnotations` does not define into
 * the tool's `_meta`, so sanitizing annotations loses nothing.
 */
export function withUpstreamAnnotationsMeta(
	meta: Record<string, JsonValue> | null,
	extras: Record<string, JsonValue> | null,
): Record<string, JsonValue> | null {
	if (!extras) return meta;
	return { ...(meta ?? {}), [UPSTREAM_TOOL_ANNOTATIONS_META_KEY]: extras };
}

export function normalizeToolMeta(
	meta: unknown,
): Record<string, JsonValue> | null {
	return isRecord(meta) ? toJsonRecord(meta) : null;
}

export function normalizeExecutionTaskSupport(
	execution: unknown,
): ToolExecutionTaskSupport | null {
	if (!isRecord(execution)) return null;
	const taskSupport = execution.taskSupport;
	if (
		taskSupport === "forbidden" ||
		taskSupport === "optional" ||
		taskSupport === "required"
	) {
		return taskSupport;
	}
	return null;
}

export interface ToolMetadataSnapshot {
	title: string | null;
	icons: ToolIcon[] | null;
	executionTaskSupport: ToolExecutionTaskSupport | null;
	annotations: ToolAnnotations | null;
	meta: Record<string, JsonValue> | null;
}

export function isTedixCatalogToolSource(
	toolSource: CatalogToolSource | null | undefined,
): boolean {
	return (
		toolSource === "tedix_app" ||
		toolSource === "openapi" ||
		toolSource === "google-discovery"
	);
}

export function isTedixHostedMcpEndpoint(endpoint: string | null | undefined) {
	if (!endpoint) return false;
	try {
		const hostname = new URL(endpoint).hostname.toLowerCase();
		return (
			hostname.endsWith(".mcp.tedix.dev") ||
			hostname.endsWith(".mcp.tedix.tech")
		);
	} catch {
		return false;
	}
}

export function shouldProjectCatalogToolsFromBaseApp(
	catalogApp: Pick<
		CatalogApp,
		"toolSource" | "mcpEndpointNormalized" | "baseUrl"
	>,
): boolean {
	return (
		isTedixCatalogToolSource(catalogApp.toolSource) ||
		isTedixHostedMcpEndpoint(
			catalogApp.mcpEndpointNormalized ?? catalogApp.baseUrl,
		)
	);
}

/** Normalize any date string to ISO 8601 format for consistent SQLite sorting. */
export function toISODate(d: string | null | undefined): string | null {
	if (!d) return null;
	try {
		const parsed = new Date(d);
		if (Number.isNaN(parsed.getTime())) return null;
		return parsed.toISOString();
	} catch {
		return null;
	}
}

export type RichContent = {
	htmlDescription?: string | null;
	heroVideoId?: string | null;
	heroVideoPreviewLink?: string | null;
	installCommand?: string | null;
	serverLabel?: string | null;
	publishedAt?: string | null;
	sourceUpdatedAt?: string | null;
	enrichmentError?: string | null;
	// Absorbed from enrichment columns
	screenshotUrl?: string | null;
	enrichedDescription?: string | null;
	socialLinks?: string[] | null;
	enrichedAt?: string | null;
	enrichmentSource?: string | null;
	enrichmentFailedAt?: string | null;
	enrichmentSkipped?: boolean | null;
	enrichmentExempt?: boolean | null;
	examplePrompts?: Array<{
		raw: string;
		cleanPrompt: string;
		appMention: string;
		screenshotUrl?: string | null;
		sourceFileId?: string | null;
		confidence?: number | null;
	}> | null;
};

export function isTedixCatalogAssetUrl(url: unknown): boolean {
	return (
		typeof url === "string" &&
		url.includes("/app_catalog/") &&
		(url.includes("r2.dev/") || url.includes("tedix"))
	);
}

export function isExternalCatalogLogoUrl(url: unknown): boolean {
	return (
		typeof url === "string" &&
		/^https?:\/\//i.test(url.trim()) &&
		!isTedixCatalogAssetUrl(url)
	);
}

export function incomingLogoRepairFailed(
	rawData: Record<string, unknown> | null | undefined,
): boolean {
	if (!isRecord(rawData?.quality)) return false;
	const status = rawData.quality.logoStatus;
	return (
		status === "fetch_failed" || status === "missing" || status === "invalid"
	);
}

export function renderableLogoUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return trimmed;
	return null;
}

/** Normalize date fields inside rich content. */
export function normalizeRichContent(
	rc: RichContent | null | undefined,
): RichContent | null {
	if (!rc) return null;
	return {
		...rc,
		publishedAt: toISODate(rc.publishedAt),
		sourceUpdatedAt: toISODate(rc.sourceUpdatedAt),
		enrichedAt: toISODate(rc.enrichedAt),
		enrichmentFailedAt: toISODate(rc.enrichmentFailedAt),
	};
}

/** Merge rich content: incoming fills gaps in existing. */
export function mergeRichContent(
	existing: RichContent | null | undefined,
	incoming: RichContent | null | undefined,
): RichContent | null {
	if (!incoming && !existing) return null;
	if (!incoming) return existing ?? null;
	if (!existing) return normalizeRichContent(incoming);
	return {
		htmlDescription: incoming.htmlDescription ?? existing.htmlDescription,
		heroVideoId: incoming.heroVideoId ?? existing.heroVideoId,
		heroVideoPreviewLink:
			incoming.heroVideoPreviewLink ?? existing.heroVideoPreviewLink,
		installCommand: incoming.installCommand ?? existing.installCommand,
		serverLabel: incoming.serverLabel ?? existing.serverLabel,
		publishedAt: toISODate(incoming.publishedAt) ?? existing.publishedAt,
		sourceUpdatedAt:
			toISODate(incoming.sourceUpdatedAt) ?? existing.sourceUpdatedAt,
		enrichmentError:
			incoming.enrichmentError !== undefined
				? incoming.enrichmentError
				: existing.enrichmentError,
		screenshotUrl:
			isTedixCatalogAssetUrl(incoming.screenshotUrl) &&
			!isTedixCatalogAssetUrl(existing.screenshotUrl)
				? incoming.screenshotUrl
				: (existing.screenshotUrl ?? incoming.screenshotUrl),
		enrichedDescription:
			incoming.enrichedDescription ?? existing.enrichedDescription,
		socialLinks: incoming.socialLinks ?? existing.socialLinks,
		enrichedAt: toISODate(incoming.enrichedAt) ?? existing.enrichedAt,
		enrichmentSource: incoming.enrichmentSource ?? existing.enrichmentSource,
		enrichmentFailedAt:
			incoming.enrichmentFailedAt !== undefined
				? toISODate(incoming.enrichmentFailedAt)
				: existing.enrichmentFailedAt,
		enrichmentSkipped: incoming.enrichmentSkipped ?? existing.enrichmentSkipped,
		enrichmentExempt: incoming.enrichmentExempt ?? existing.enrichmentExempt,
		examplePrompts: incoming.examplePrompts ?? existing.examplePrompts,
	};
}

export function mergeCatalogRawData(
	existing: Record<string, unknown> | null | undefined,
	incoming: Record<string, unknown> | null | undefined,
): Record<string, JsonValue> | null {
	if (!existing && !incoming) return null;
	const next = isRecord(existing) ? { ...existing } : {};
	if (!isRecord(incoming))
		return Object.keys(next).length > 0 ? toJsonRecord(next) : null;

	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined || value === null) continue;
		if (key === "quality" && isRecord(value)) {
			const existingQuality = isRecord(next.quality) ? next.quality : {};
			next.quality = { ...existingQuality, ...value };
			continue;
		}
		next[key] = value;
	}

	return Object.keys(next).length > 0 ? toJsonRecord(next) : null;
}
export type CatalogAppStatus = (typeof appCatalog.$inferInsert)["status"];

export interface ToolDriftReportItem {
	toolName: string;
	driftType:
		| "schema_changed"
		| "description_changed"
		| "metadata_changed"
		| "new_upstream"
		| "removed_upstream";
	catalogToolId?: string;
	currentDescription?: string;
	upstreamDescription?: string;
	currentSchema?: Record<string, JsonValue>;
	upstreamSchema?: Record<string, JsonValue>;
	currentOutputSchema?: Record<string, JsonValue> | null;
	upstreamOutputSchema?: Record<string, JsonValue> | null;
	currentMetadata?: ToolMetadataSnapshot;
	upstreamMetadata?: ToolMetadataSnapshot;
}
