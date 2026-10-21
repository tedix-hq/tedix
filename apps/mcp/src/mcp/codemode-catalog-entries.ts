import { type z as NativeZ } from "zod";
import { type McpNativeDescriptorSchema } from "@tedix/api-contract/schemas/mcp-native-transport";
import { type AppTool, type ServerContext } from "./server-context";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import { sanitizeToolName } from "@cloudflare/codemode";
import {
	type SkillWorkflowSurface,
	SKILL_WORKFLOW_SURFACE_BY_TEDI_TOOL,
	FLOW_NAMESPACE,
} from "./codemode-flow";
import { recordFrom } from "./codemode-ui";

export const CODEMODE_NAMESPACE = "codemode";

export const CODEMODE_TOOL_COUNT = 1;

export const CODEMODE_CATALOG_TOOLS = {
	__runtime: {
		name: "Inspect Code Mode Runtime",
		description:
			"Return this Code Mode execution context: executionId, app/org, actor, traceId, tool counts, module names, and direct gateway execution-surface proof.",
		parameters: {
			type: "object",
			properties: {},
		},
	},
} satisfies Record<
	string,
	{
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	}
>;

export interface CatalogToolAnnotations {
	destructiveHint?: boolean;
	readOnlyHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface CatalogToolEntry {
	callable: string;
	organization?: string;
	namespace: string;
	tool: string;
	name: string;
	displayName: string;
	description: string;
	parameters?: Record<string, unknown>;
	annotations?: CatalogToolAnnotations;
	_meta?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	schemaFreshness?: CatalogSchemaFreshness;
	native?: NativeZ.infer<typeof McpNativeDescriptorSchema>;
	equivalentTediOwners?: Array<{ namespace: string; callable: string }>;
	/**
	 * Set on the dual-mounted peer-alias copy (SEAM B) to the canonical
	 * namespace it mirrors. Aliases resolve but never enumerate: entries with
	 * aliasOf are excluded from unfiltered search/browse and list_namespaces,
	 * and served only under an explicit { namespace } filter on the alias form.
	 */
	aliasOf?: string;
	/**
	 * Caller-relative authorization, computed per request through
	 * `evaluateMcpToolScopeAuthorization` — the same seam the dispatch gates
	 * use, so discovery and enforcement cannot drift. Absent on host-owned
	 * namespaces (ui/codemode/flow), which have no D1 scope config.
	 */
	authorized?: boolean;
	requiredScopes?: string[];
	missingScopes?: string[];
}

interface CatalogSchemaFreshness {
	dialect?: string;
	source?: string;
	sourceRef?: string;
	sourceHash?: string;
	syncedAt?: string;
	toolUpdatedAt?: string;
}

export interface CatalogSearchMatch {
	score: number;
	matchedTerms: string[];
	unmatchedTerms: string[];
}

export interface CatalogPageEntry {
	namespace: string;
	tool: string;
	meta: unknown;
}

// =============================================================================
// PROVIDER BUILDERS
// =============================================================================

/**
 * Group tools by namespace and build executable functions + JSON Schema descriptors.
 */
export function projectedToolIdentity(
	toolId: string,
	tool: AppTool,
	namespaceOverrides: Record<string, string> | undefined,
): { namespace: string; safeName: string; ownerKey: string } {
	const namespace = resolveMcpToolNamespace(tool, namespaceOverrides);
	const rawName = toolId.includes("__")
		? toolId.split("__").slice(1).join("__")
		: toolId;
	const safeName = sanitizeToolName(rawName);
	return { namespace, safeName, ownerKey: `${namespace}.${safeName}` };
}

export function codeModeCollisionOwners(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
): Map<string, string[]> {
	const owners = new Map<string, string[]>();
	for (const [toolId, tool] of serverCtx.loadedTools) {
		const { ownerKey } = projectedToolIdentity(
			toolId,
			tool,
			namespaceOverrides,
		);
		const current = owners.get(ownerKey) ?? [];
		current.push(toolId);
		owners.set(ownerKey, current);
	}
	return new Map(
		[...owners.entries()]
			.filter(([, toolIds]) => toolIds.length > 1)
			.map(([ownerKey, toolIds]) => [ownerKey, toolIds.sort()]),
	);
}

// Auto-generated D1 tools whose oRPC contract has no description/summary get a
// placeholder description (`Tedix oRPC endpoint <router>/<proc>`, or empty) from
// tool-schema-sync. That's useless for an agent deciding whether to call the
// tool. Replace it AT DISCOVERY SERVE TIME (not in D1 — avoids the schema-drift
// gate) with a readable sentence derived from the verb-first tool name, e.g.
// `list_adapter_bindings_by_app` → "List adapter bindings by app." Real authored
// descriptions are left untouched.
export function humanizeWeakDescription(
	description: string | null | undefined,
	toolName: string,
): string {
	const desc = (description ?? "").trim();
	const isWeak =
		desc.length === 0 || /^Tedix oRPC endpoint [^\s/]+\/\S+$/.test(desc);
	if (!isWeak) return desc;
	const words = toolName.split(/[_\s]+/).filter(Boolean);
	if (words.length === 0) return desc;
	const sentence = words.join(" ");
	return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

export function splitCallable(callable: string): {
	namespace: string;
	tool: string;
} {
	const dot = callable.indexOf(".");
	return { namespace: callable.slice(0, dot), tool: callable.slice(dot + 1) };
}

/**
 * Identify generated tedi mirrors only. A coincidental tool with the same name
 * in an app namespace remains independently discoverable.
 */
export function mirroredSkillWorkflowSurface(
	namespace: string,
	toolName: string,
	meta: CatalogToolEntry,
): SkillWorkflowSurface | undefined {
	const surface = SKILL_WORKFLOW_SURFACE_BY_TEDI_TOOL.get(toolName);
	if (!surface || namespace === "skills" || namespace === FLOW_NAMESPACE) {
		return undefined;
	}
	return meta.schemaFreshness?.source === "mcp" &&
		meta.schemaFreshness.sourceRef === toolName
		? surface
		: undefined;
}

export function workflowTediOwners(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
): Map<string, Array<{ namespace: string; callable: string }>> {
	const owners = new Map<
		string,
		Array<{ namespace: string; callable: string }>
	>();
	for (const [namespace, tools] of Object.entries(catalog)) {
		for (const [toolName, meta] of Object.entries(tools)) {
			const surface = mirroredSkillWorkflowSurface(namespace, toolName, meta);
			if (!surface) continue;
			const list = owners.get(surface.canonicalCallable) ?? [];
			list.push({ namespace, callable: meta.callable });
			owners.set(surface.canonicalCallable, list);
		}
	}
	for (const list of owners.values()) {
		list.sort((a, b) => a.namespace.localeCompare(b.namespace));
	}
	return owners;
}

/**
 * A tedi-native tool (per-tedi worker interface synced from the tedi's own
 * MCP surface) is marked by `schemaFreshness.source === "mcp"` with a bare
 * `sourceRef === toolName` — external MCP apps carry an `<appId>:` prefix on
 * sourceRef, so they never group here.
 */
export function isTediNativeInterfaceTool(meta: CatalogToolEntry): boolean {
	return (
		meta.schemaFreshness?.source === "mcp" &&
		meta.schemaFreshness.sourceRef === meta.tool
	);
}

/**
 * Role-verb collapse: the same worker interface repeats identically across
 * every role namespace (nine 152-tool namespaces ≈ 28% of the tedix-unified
 * catalog when this shipped). Group tedi-native tools by tool name; unfiltered
 * enumeration emits one representative row (alphabetically-first namespace)
 * with the other owners in `equivalentTediOwners`, exactly the shape the
 * skill-workflow mirror collapse already uses. Execution and namespace-filtered
 * search are untouched — every role callable still dispatches.
 */
export function tediNativeInterfaceGroups(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
	preferredNamespace?: string,
): Map<string, Array<{ namespace: string; callable: string }>> {
	const groups = new Map<
		string,
		Array<{ namespace: string; callable: string }>
	>();
	for (const [namespace, tools] of Object.entries(catalog)) {
		for (const [toolName, meta] of Object.entries(tools)) {
			if (meta.aliasOf) continue;
			if (!isTediNativeInterfaceTool(meta)) continue;
			// Skill-workflow mirrors already collapse onto their platform
			// canonical callable; leave them to that machinery.
			if (mirroredSkillWorkflowSurface(namespace, toolName, meta)) continue;
			const list = groups.get(toolName) ?? [];
			list.push({ namespace, callable: meta.callable });
			groups.set(toolName, list);
		}
	}
	for (const [toolName, list] of groups) {
		if (list.length < 2) {
			groups.delete(toolName);
			continue;
		}
		list.sort((a, b) => {
			if (a.namespace === preferredNamespace) return -1;
			if (b.namespace === preferredNamespace) return 1;
			return a.namespace.localeCompare(b.namespace);
		});
	}
	return groups;
}

export function callerTediNamespace(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
): string | undefined {
	const callerTediId = serverCtx.callerIdentity?.tediId;
	if (!callerTediId) return undefined;
	for (const [toolId, tool] of serverCtx.loadedTools) {
		const config = recordFrom(tool.config);
		if (config?._aggregateTediId !== callerTediId) continue;
		return projectedToolIdentity(toolId, tool, namespaceOverrides).namespace;
	}
	return undefined;
}

function pickCatalogAnnotations(
	annotations: unknown,
): CatalogToolAnnotations | undefined {
	if (
		!annotations ||
		typeof annotations !== "object" ||
		Array.isArray(annotations)
	) {
		return undefined;
	}
	const a = annotations as Record<string, unknown>;
	const picked: CatalogToolAnnotations = {};
	if (typeof a.destructiveHint === "boolean")
		picked.destructiveHint = a.destructiveHint;
	if (typeof a.readOnlyHint === "boolean") picked.readOnlyHint = a.readOnlyHint;
	if (typeof a.idempotentHint === "boolean")
		picked.idempotentHint = a.idempotentHint;
	if (typeof a.openWorldHint === "boolean")
		picked.openWorldHint = a.openWorldHint;
	return Object.keys(picked).length > 0 ? picked : undefined;
}

export function createCatalogToolEntry(
	namespace: string,
	tool: string,
	meta: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		annotations?: unknown;
		_meta?: Record<string, unknown>;
		outputSchema?: Record<string, unknown> | null;
		schemaFreshness?: CatalogSchemaFreshness;
	},
): CatalogToolEntry {
	const callable = `${namespace}.${tool}`;
	const annotations = pickCatalogAnnotations(meta.annotations);
	const outputSchema =
		meta.outputSchema && typeof meta.outputSchema === "object"
			? meta.outputSchema
			: undefined;
	const schemaFreshness =
		meta.schemaFreshness && Object.keys(meta.schemaFreshness).length > 0
			? meta.schemaFreshness
			: undefined;
	return {
		callable,
		namespace,
		tool,
		name: meta.name,
		displayName: meta.name,
		description: meta.description,
		parameters: meta.parameters,
		...(annotations && { annotations }),
		...(meta._meta && Object.keys(meta._meta).length > 0
			? { _meta: meta._meta }
			: {}),
		...(outputSchema && { outputSchema }),
		...(schemaFreshness && { schemaFreshness }),
	};
}

export function schemaFreshnessFromTool(tool: AppTool): CatalogSchemaFreshness {
	return {
		...(tool.schemaDialect ? { dialect: tool.schemaDialect } : {}),
		...(tool.schemaSource ? { source: tool.schemaSource } : {}),
		...(tool.schemaSourceRef ? { sourceRef: tool.schemaSourceRef } : {}),
		...(tool.schemaSourceHash ? { sourceHash: tool.schemaSourceHash } : {}),
		...(tool.schemaSyncedAt ? { syncedAt: tool.schemaSyncedAt } : {}),
		...(tool.updatedAt ? { toolUpdatedAt: tool.updatedAt } : {}),
	};
}

export function catalogFreshnessMeta(
	catalog: Record<string, Record<string, CatalogToolEntry>>,
	catalogBuiltAt: string,
) {
	const tools = Object.values(catalog).flatMap((namespaceTools) =>
		Object.values(namespaceTools),
	);
	const syncedAtValues = tools
		.map((tool) => tool.schemaFreshness?.syncedAt)
		.filter((value): value is string => typeof value === "string" && !!value)
		.sort();
	return {
		catalogBuiltAt,
		toolCount: tools.length,
		namespaceCount: Object.keys(catalog).length,
		schemaSyncedTools: syncedAtValues.length,
		unsyncedTools: tools.length - syncedAtValues.length,
		...(syncedAtValues[0] ? { oldestSchemaSyncedAt: syncedAtValues[0] } : {}),
		...(syncedAtValues.at(-1)
			? { newestSchemaSyncedAt: syncedAtValues.at(-1) }
			: {}),
	};
}
