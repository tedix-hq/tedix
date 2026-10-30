/**
 * Pure projection of one oRPC contract endpoint into an MCP tool row: tool id
 * generation, titles, annotations, config/meta merging, JSON Schema
 * generation, and the content hashes the planner and sync runner compare.
 * Nothing here touches D1; `tool-schema-sync.ts` owns the reads and writes.
 */
import attentionAppViews from "@tedix/api-contract/assets/attention-app-views.v2.json";
import cliNativeEndpoints from "@tedix/api-contract/assets/cli-native-endpoints.v1.json";
import { TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
import type { ToolSchemaSyncInput } from "@tedix/api-contract/contracts/tool-schema-sync";
import {
	deriveToolWriteCapability,
	TEDIX_TOOL_POLICY_META_KEY,
	withDerivedToolOperationalRiskPolicy,
	operatorKindToAnnotations,
} from "@tedix/api-contract/schemas/tools";
import {
	listContractEndpoints,
	type ResolvedContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";
import type { AppTool } from "@tedix/db/schema";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	EXTERNAL_AGENT_MCP_ENDPOINTS,
	OPEN_WORLD_ENDPOINTS,
	ORG_INJECT_ROUTERS,
} from "./tool-schema-overrides";

type SchemaColumn = "inputSchema" | "outputSchema";
export type SyncColumn =
	| SchemaColumn
	| "title"
	| "description"
	| "config"
	| "annotations"
	| "meta"
	| "authRequired"
	| "visibility"
	| "schemaSource"
	| "widget";

export type JsonObject = Record<string, unknown>;
type WidgetOverride = NonNullable<
	ToolSchemaSyncInput["widgetOverrides"]
>[string];

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as JsonObject;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return stableStringify(left ?? null) === stableStringify(right ?? null);
}

export async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableStringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function asRpcEndpoint(tool: AppTool): string | null {
	const config = tool.config as Record<string, unknown> | null;
	if (config?.transport !== "rpc") return null;
	return typeof config.endpoint === "string" ? config.endpoint : null;
}

export function hasObjectProperty(schema: unknown, property: string): boolean {
	if (!schema || typeof schema !== "object") return false;
	const properties = (schema as JsonObject).properties;
	return (
		!!properties &&
		typeof properties === "object" &&
		!Array.isArray(properties) &&
		Object.hasOwn(properties, property)
	);
}

function snakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

export function titleFromToolId(toolId: string): string {
	return toolId
		.split("_")
		.filter(Boolean)
		.map((part) => {
			const label =
				part === "gadget" ? "app" : part === "gadgets" ? "apps" : part;
			return label.charAt(0).toUpperCase() + label.slice(1);
		})
		.join(" ");
}

/**
 * Prepositions that signal the procedure name carries a qualifier rather than a
 * concrete object (e.g. `list_by_app`, `get_for_mcp`). When proc is verb +
 * preposition phrase, the router becomes the object slotted after the verb:
 * `list_by_app` (skills) → `list_skills_by_app`.
 */
const PROC_PREPOSITIONS = new Set([
	"by",
	"for",
	"to",
	"from",
	"with",
	"of",
	"in",
	"as",
]);

/**
 * Decorate a proc with the router as its object, inserting it after the verb:
 * `{verb}_{router}_{rest}` (rest may be empty → `{verb}_{router}`). Used both
 * for the preposition case and for deterministic collision disambiguation.
 */
function decorateWithRouter(proc: string, router: string): string {
	const words = proc.split("_").filter(Boolean);
	const [verb, ...rest] = words;
	if (!verb) return router;
	return [verb, router, ...rest].filter(Boolean).join("_");
}

/**
 * Verb-first MCP tool id from an oRPC endpoint, following the
 * "MCP Tool Naming Convention" in CLAUDE.md (`verb_object` /
 * `verb_object_qualifier`). Router-name suffixes are NOT appended — the router
 * is the Code Mode namespace, so `skills.list_by_app_skills` becomes
 * `skills.list_skills_by_app`.
 */
export function generatedToolIdForEndpoint(
	endpoint: ResolvedContractEndpoint,
): string {
	if (endpoint.route?.operationId) return snakeCase(endpoint.route.operationId);

	const proc = snakeCase(endpoint.procPath.replace(/\//g, "_"));
	const router = snakeCase(endpoint.router);
	if (!proc) return router;

	// Proc already contains the router token sequence anywhere (e.g. proc
	// `search_memory_graph` for router `memory_graph`, or proc ending in
	// `_skills` for router `skills`) → leave it untouched.
	const procWords = proc.split("_").filter(Boolean);
	const routerWords = router.split("_").filter(Boolean);
	if (containsTokenSequence(procWords, routerWords)) return proc;

	const [verb, ...rest] = procWords;
	if (!verb) return router;

	// Bare verb (`get`, `list`, `search`, `create`) → `{verb}_{router}`.
	if (rest.length === 0) return `${verb}_${router}`;

	// Preposition phrase (`list_by_app`) → insert router after the verb.
	if (PROC_PREPOSITIONS.has(rest[0]!)) return decorateWithRouter(proc, router);

	// Proc already names a real object (`rotate_access_key`, `run_workflow`)
	// → return it without router decoration.
	return proc;
}

/** True when `needle` appears as a contiguous subsequence of `haystack`. */
function containsTokenSequence(haystack: string[], needle: string[]): boolean {
	if (needle.length === 0) return false;
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

/**
 * Generate tool ids for a set of endpoints with deterministic collision
 * resolution: when two endpoints would produce the same tool id, ALL colliding
 * entries are disambiguated by slotting the router after the verb
 * (`{verb}_{router}_{rest}`). Per-endpoint overrides win and are never
 * collision-adjusted.
 */
export function generateToolIdMap(
	endpoints: ResolvedContractEndpoint[],
	overrides?: Record<string, string>,
): Map<string, string> {
	const byEndpoint = new Map<string, string>();
	const counts = new Map<string, ResolvedContractEndpoint[]>();

	for (const endpoint of endpoints) {
		const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
		const override = overrides?.[endpointPath];
		const generated = override ?? generatedToolIdForEndpoint(endpoint);
		byEndpoint.set(endpointPath, generated);
		if (override) continue;
		const bucket = counts.get(generated) ?? [];
		bucket.push(endpoint);
		counts.set(generated, bucket);
	}

	for (const [toolId, colliding] of counts) {
		if (colliding.length < 2) continue;
		console.warn(
			`[tool-schema-sync] tool id collision on "${toolId}" across ${colliding
				.map((endpoint) => `${endpoint.router}/${endpoint.procPath}`)
				.join(", ")} — disambiguating with router prefix.`,
		);
		for (const endpoint of colliding) {
			const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
			const proc = snakeCase(endpoint.procPath.replace(/\//g, "_"));
			const router = snakeCase(endpoint.router);
			byEndpoint.set(endpointPath, decorateWithRouter(proc, router));
		}
	}

	// Write-time config lint: any tool id still claimed by 2+ endpoints after
	// overrides + router disambiguation violates the (app_id, tool_id) unique
	// index — and worse, `upsertTool` matches by (appId, toolId), so the second
	// projection would silently clobber the first row instead of failing.
	// Reject the whole sync before any write, naming the colliders. Overrides
	// are never collision-adjusted, so this fires for override↔override and
	// override↔generated collisions plus unresolvable generated residue.
	const endpointsByFinalToolId = new Map<string, string[]>();
	for (const [endpointPath, toolId] of byEndpoint) {
		const bucket = endpointsByFinalToolId.get(toolId) ?? [];
		bucket.push(endpointPath);
		endpointsByFinalToolId.set(toolId, bucket);
	}
	const residualCollisions = [...endpointsByFinalToolId].filter(
		([, endpointPaths]) => endpointPaths.length > 1,
	);
	if (residualCollisions.length > 0) {
		throw new Error(
			`TOOL_ID_COLLISION: ${residualCollisions
				.map(
					([toolId, endpointPaths]) =>
						`"${toolId}" is claimed by ${endpointPaths.join(", ")}`,
				)
				.join(
					"; ",
				)}. Each endpoint in one app must map to a unique tool_id (idx_app_tool_unique) — set distinct toolIdOverrides for the colliding endpoints.`,
		);
	}

	return byEndpoint;
}

function descriptionForEndpoint(endpoint: ResolvedContractEndpoint): string {
	return (
		endpoint.route?.description ??
		endpoint.route?.summary ??
		`Tedix oRPC endpoint ${endpoint.router}/${endpoint.procPath}`
	);
}

export function annotationsForEndpoint(
	endpoint: ResolvedContractEndpoint,
	kind?: "read" | "write" | "destructive",
): NonNullable<AppTool["annotations"]> {
	const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
	if (
		endpointPath === "workAgentSessions/listActivity" ||
		endpointPath === "workAgentSessions/listEvents"
	)
		return {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
			untrustedContentHint: true,
		};
	if (kind) {
		// Single source of truth — see operatorKindToAnnotations in
		// packages/api-contract/src/schemas/tools.ts. Same mapping is used by
		// the retired one-off operator-annotation backfill.
		return {
			...operatorKindToAnnotations(kind),
			openWorldHint: OPEN_WORLD_ENDPOINTS.has(endpointPath),
		};
	}

	const method = endpoint.route?.method?.toUpperCase();
	const proc = snakeCase(endpoint.proc);
	const readOnly =
		method === "GET" ||
		/^(get|list|search|query|check|preview|validate|audit|inspect|estimate|read)_?/.test(
			`${proc}_`,
		);
	const destructive =
		method === "DELETE" ||
		/^(delete|remove|destroy|reset|purge)_?/.test(`${proc}_`);

	return {
		readOnlyHint: readOnly,
		destructiveHint: destructive,
		idempotentHint: readOnly || method === "PUT" || method === "DELETE",
		openWorldHint: OPEN_WORLD_ENDPOINTS.has(endpointPath),
	};
}

function mergeGeneratedMeta(
	existing: AppTool | undefined,
	endpoint: string,
): Record<string, unknown> {
	const meta: Record<string, unknown> = {
		...(existing?.meta as Record<string, unknown> | null),
		"com.tedix/schemaSource": "orpc",
		"com.tedix/orpcEndpoint": endpoint,
	};
	// A policy derived from an earlier capability outlives a reclassification
	// (a read once inferred as a write kept "bounded_write" and stayed a write
	// on the wire). A policy that any capability would derive is generated, so
	// it is derived again; a curated policy carries other fields and is kept.
	const { [TEDIX_TOOL_POLICY_META_KEY]: policy, ...rest } = meta;
	if (!policy) return meta;
	const config = existing?.config ? toJsonRecord(existing.config) : null;
	const generated = (["read", "write", "destructive"] as const).some(
		(writeCapability) =>
			JSON.stringify(
				withDerivedToolOperationalRiskPolicy({
					meta: {},
					config,
					writeCapability,
				})?.[TEDIX_TOOL_POLICY_META_KEY],
			) === JSON.stringify(policy),
	);
	return generated ? rest : meta;
}

export function mergeGeneratedConfig(
	existing: AppTool | undefined,
	endpoint: ResolvedContractEndpoint,
	inputSchema: AppTool["inputSchema"],
	widgetOverride?: WidgetOverride,
): Record<string, unknown> {
	const existingConfig = (existing?.config as JsonObject | null) ?? {};
	const nextConfig: JsonObject = {
		transport: "rpc",
		endpoint: `${endpoint.router}/${endpoint.procPath}`,
		responsePath: "json",
		...(endpoint.route?.method
			? { method: endpoint.route.method.toUpperCase() }
			: {}),
	};
	// Preserve stored opt-ins and the versioned assets’ reviewed native calls
	// (attention views and the CLI's Work verbs). Native dispatch still enforces
	// the caller’s endpoint scopes and the router's own authorization.
	const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
	if (
		existingConfig.nativeDirect === true ||
		attentionAppViews.nativeDirectEndpoints.includes(endpointPath) ||
		cliNativeEndpoints.nativeDirectEndpoints.includes(endpointPath)
	)
		nextConfig.nativeDirect = true;

	if (
		endpoint.router === "tedis" &&
		[
			"runTediDurableCode",
			"approveTediCodeExecution",
			"rollbackTediCodeExecution",
		].includes(endpoint.procPath)
	) {
		const existingTimeout = existingConfig.timeout;
		nextConfig.timeout =
			typeof existingTimeout === "number" && Number.isFinite(existingTimeout)
				? Math.max(TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS, existingTimeout)
				: TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS;
	}

	if (hasObjectProperty(inputSchema, "tediId")) {
		nextConfig.allowExplicitTediId = true;
	}
	if (hasObjectProperty(inputSchema, "appId")) {
		nextConfig.allowExplicitAppId = true;
	}
	// Inject the caller's org for caller-org-scoped sub-collection routes — gated
	// on the ORG_INJECT_ROUTERS allowlist (NOT a path heuristic) so platform-admin
	// cross-org procs like organizations.cancel are never auto-rescoped.
	// The path check still excludes non-org routes in an allowlisted router.
	if (
		ORG_INJECT_ROUTERS.has(endpoint.router) &&
		endpoint.route?.path?.includes("{organizationId}/")
	) {
		nextConfig.injectOrganizationId = true;
	}

	// Keep hand-authored widget projections attached to the tool row.
	for (const key of [
		"layoutId",
		"layoutSpec",
		"responseMap",
		"staticOutput",
		"modelSummaryTemplate",
	]) {
		if (existingConfig[key] !== undefined)
			nextConfig[key] = existingConfig[key];
	}

	if (widgetOverride) {
		nextConfig.layoutId = widgetOverride.layoutId;
		nextConfig.layoutSpec = widgetOverride.layoutSpec;
		if (endpointPath in attentionAppViews.views)
			nextConfig.modelSummaryTemplate = "{markdown}";
	}

	if (attentionAppViews.textSummaryEndpoints.includes(endpointPath))
		nextConfig.modelSummaryTemplate = "{markdown}";
	return nextConfig;
}

interface ProjectedSchemas {
	inputSchema: AppTool["inputSchema"];
	outputSchema: AppTool["outputSchema"];
}

export function projectSchemas(
	endpoint: ResolvedContractEndpoint,
): ProjectedSchemas {
	return {
		inputSchema: zodToToolInputJsonSchema(
			endpoint.inputSchema,
		) as AppTool["inputSchema"],
		outputSchema: endpoint.outputSchema
			? (zodToStructuredOutputJsonSchema(
					endpoint.outputSchema,
				) as AppTool["outputSchema"])
			: null,
	};
}

/**
 * Bump when a change to the projection reads an existing row differently
 * (`mergeGeneratedConfig`, `mergeGeneratedMeta`, sticky widget columns).
 * Code-only changes to what a fresh row looks like already change the hash.
 */
const TOOL_PROJECTION_REVISION = 1;

export type ProjectionOptions = NonNullable<
	Parameters<typeof buildProjectedTool>[3]
>;

/**
 * Hash of everything the projection derives from code for one endpoint: the
 * row a projection would write with no existing row to merge. Its
 * `schemaSourceHash` already covers the generated schemas, tool id, title,
 * description, config, annotations, meta and widget columns, so a contract,
 * override, or projector change moves it, while existing-row state does not.
 * The planner and the batch both compute it this way, so they always agree.
 */
export async function projectionContractHash(
	endpoint: ResolvedContractEndpoint,
	options: ProjectionOptions,
): Promise<string> {
	const { tool } = await buildProjectedTool("", endpoint, undefined, {
		...options,
		contractHash: undefined,
	});
	return sha256({
		revision: TOOL_PROJECTION_REVISION,
		projection: tool.schemaSourceHash,
	});
}

export async function buildProjectedTool(
	appId: string,
	endpoint: ResolvedContractEndpoint,
	existing?: AppTool,
	options: {
		toolIdOverrides?: Record<string, string>;
		kindOverrides?: Record<string, "read" | "write" | "destructive">;
		widgetOverrides?: ToolSchemaSyncInput["widgetOverrides"];
		/**
		 * Pre-resolved tool id for this endpoint (collision-adjusted by the
		 * caller). Falls back to override → generated when omitted.
		 */
		resolvedToolId?: string;
		/**
		 * Aggressive mode: replace the existing row's tool_id with the
		 * generated/override name instead of preserving it. Renames in place by
		 * row id (upsertTool updates by id first).
		 */
		regenerateToolIds?: boolean;
		/** Already-generated JSON Schemas for this endpoint, to avoid a rerun. */
		schemas?: ProjectedSchemas;
		/** Stored on the row so later plans can skip this endpoint. */
		contractHash?: string;
	} = {},
): Promise<{
	tool: Omit<
		AppTool,
		| "id"
		| "createdAt"
		| "updatedAt"
		| "schemaSourceHash"
		| "schemaSyncedAt"
		| "contractHash"
	> & {
		id?: string;
		schemaSourceHash: string;
		schemaSyncedAt: string;
		contractHash: string | null;
	};
	endpointPath: string;
}> {
	const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
	const widgetOverride = options.widgetOverrides?.[endpointPath];
	const { inputSchema, outputSchema } =
		options.schemas ?? projectSchemas(endpoint);
	const generatedToolId =
		options.resolvedToolId ??
		options.toolIdOverrides?.[endpointPath] ??
		generatedToolIdForEndpoint(endpoint);
	// Aggressive mode flips precedence: the generated/override name wins so
	// existing rows are renamed in place. Otherwise the existing name is sticky.
	const toolId = options.regenerateToolIds
		? generatedToolId
		: (existing?.toolId ?? generatedToolId);
	const config = mergeGeneratedConfig(
		existing,
		endpoint,
		inputSchema,
		widgetOverride,
	);
	const annotations = annotationsForEndpoint(
		endpoint,
		options.kindOverrides?.[endpointPath],
	);
	const writeCapability = deriveToolWriteCapability(annotations);
	const meta = withDerivedToolOperationalRiskPolicy({
		meta: toJsonRecord(mergeGeneratedMeta(existing, endpointPath)),
		config: toJsonRecord(config),
		writeCapability,
	});
	const widgetRoute = widgetOverride ? `/r/${widgetOverride.layoutId}` : null;
	const widgetKey = widgetOverride ? "render" : (existing?.widgetKey ?? null);
	const schemaSourceHash = await sha256({
		endpoint: endpointPath,
		toolId,
		title: titleFromToolId(toolId),
		description: descriptionForEndpoint(endpoint),
		inputSchema,
		outputSchema,
		config,
		annotations,
		meta,
		authRequired: true,
		visibility: "private",
		widgetKey,
		widgetRoute: widgetRoute ?? existing?.widgetRoute ?? null,
		widgetDescription:
			widgetOverride?.description ?? existing?.widgetDescription ?? null,
	});

	return {
		endpointPath,
		tool: {
			id: existing?.id,
			appId,
			toolId,
			title: titleFromToolId(toolId),
			description: descriptionForEndpoint(endpoint),
			toolTypeId: "rpc",
			inputSchema,
			outputSchema,
			config: toJsonRecord(config),
			icons: existing?.icons ?? null,
			executionTaskSupport: existing?.executionTaskSupport ?? null,
			annotations,
			// First-party oRPC rows are classified at generation time, so the
			// declarative column is populated from the SAME annotations that get
			// persisted — never from the tool name. `kindOverrides` is the
			// genuinely declarative input; the method/prefix branch of
			// annotationsForEndpoint is its fallback, and either way the answer is
			// recorded once here instead of being re-inferred at every gate.
			writeCapability,
			// Owner-declared, never derived: projection keeps whatever is stored.
			actionType: existing?.actionType ?? null,
			// Operator declarations, never inferred from the endpoint.
			sensitiveData: existing?.sensitiveData ?? false,
			publicEgress: existing?.publicEgress ?? false,
			meta: meta == null ? null : toJsonRecord(meta),
			invocationStatus: existing?.invocationStatus ?? null,
			fileParams: existing?.fileParams ?? null,
			adapterScope: existing?.adapterScope ?? "primary",
			resultStrategy: existing?.resultStrategy ?? "merge",
			outputTemplate: existing?.outputTemplate ?? null,
			widgetKey,
			widgetRoute: widgetRoute ?? existing?.widgetRoute ?? null,
			widgetAccessible: widgetOverride
				? true
				: (existing?.widgetAccessible ?? true),
			visibility: "private",
			authRequired: true,
			widgetDescription:
				widgetOverride?.description ?? existing?.widgetDescription ?? null,
			widgetPrefersBorder: widgetOverride
				? null
				: (existing?.widgetPrefersBorder ?? true),
			widgetDomain: existing?.widgetDomain ?? null,
			schemaDialect: "json-schema-2020-12",
			schemaSource: "orpc",
			schemaSourceRef: endpointPath,
			schemaSourceHash,
			schemaSyncedAt: new Date().toISOString(),
			contractHash: options.contractHash ?? null,
			sortOrder: existing?.sortOrder ?? 0,
			enabled: existing?.enabled ?? true,
		},
	};
}

export function changedProjectionColumns(
	existing: AppTool,
	projected: Awaited<ReturnType<typeof buildProjectedTool>>["tool"],
): SyncColumn[] {
	const changed: SyncColumn[] = [];
	if (existing.title !== projected.title) changed.push("title");
	if ((existing.description ?? null) !== (projected.description ?? null)) {
		changed.push("description");
	}
	if (!jsonEqual(existing.inputSchema, projected.inputSchema)) {
		changed.push("inputSchema");
	}
	if (!jsonEqual(existing.outputSchema, projected.outputSchema)) {
		changed.push("outputSchema");
	}
	if (!jsonEqual(existing.config, projected.config)) changed.push("config");
	if (!jsonEqual(existing.annotations, projected.annotations)) {
		changed.push("annotations");
	}
	if (!jsonEqual(existing.meta, projected.meta)) changed.push("meta");
	if ((existing.authRequired ?? false) !== projected.authRequired) {
		changed.push("authRequired");
	}
	if ((existing.visibility ?? "public") !== projected.visibility) {
		changed.push("visibility");
	}
	if (
		existing.schemaDialect !== projected.schemaDialect ||
		existing.schemaSource !== projected.schemaSource ||
		existing.schemaSourceRef !== projected.schemaSourceRef ||
		existing.schemaSourceHash !== projected.schemaSourceHash
	) {
		changed.push("schemaSource");
	}
	if (
		(existing.widgetKey ?? null) !== (projected.widgetKey ?? null) ||
		(existing.widgetRoute ?? null) !== (projected.widgetRoute ?? null) ||
		(existing.widgetDescription ?? null) !==
			(projected.widgetDescription ?? null) ||
		(existing.widgetAccessible ?? true) !==
			(projected.widgetAccessible ?? true) ||
		(existing.widgetPrefersBorder ?? true) !==
			(projected.widgetPrefersBorder ?? true)
	) {
		changed.push("widget");
	}
	return changed;
}

export function targetColumns(
	target: ToolSchemaSyncInput["target"],
): SchemaColumn[] {
	switch (target ?? "both") {
		case "input":
			return ["inputSchema"];
		case "output":
			return ["outputSchema"];
		case "both":
			return ["inputSchema", "outputSchema"];
	}
}

/**
 * Routers that must never materialize as MCP tools. `osTenant` is the
 * service-binding-only edge-resolution surface for `tedix-os`, while
 * `tenantBehavioralEvals` is an API-only authoring and execution surface.
 * `mcpCredentials` returns bearer credentials only to the authenticated tedi;
 * `mcpGovernance` stays internal except for its machine-initiated proof tool.
 * Other routes remain registered for contract/router parity.
 */
const UNPROJECTABLE_ROUTERS = new Set([
	// Browser credentials and human-admin console grants are not MCP tools.
	"tediConsole",
	"osTenant",
	"tenantBehavioralEvals",
	"mcpCredentials",
	"mcpGovernance",
]);
const UNPROJECTABLE_ENDPOINTS = new Set([
	// Home-bound native runtime action; an MCP mount cannot carry its authority.
	"workItems/closeoutDelegated",
	"workInteractions/outbound/act",
	"workInteractions/outbound/accounts",
	"workInteractions/outbound/checkOutcome",
	"workInteractions/outbound/profile",
	"workInteractions/outbound/importSentStyle",
	"cognitiveRuntime/createRedactedArtifactRevision",
	"cognitiveRuntime/getArtifactReleaseReview",
	"cognitiveRuntime/approveArtifactRelease",
	"cognitiveRuntime/revokeArtifactRelease",
	// SEP-3415 webhook leases: written only by the MCP edge's `events/subscribe`
	// (which seals the credential) and read only by its service-bound deliverer.
	"mcpEvents/upsertWebhookSubscription",
	"mcpEvents/deleteWebhookSubscription",
	"mcpEvents/claimDueWebhookSubscriptions",
	"mcpEvents/recordWebhookDelivery",
]);

function isProjectableEndpoint(endpoint: ResolvedContractEndpoint): boolean {
	return (
		!UNPROJECTABLE_ROUTERS.has(endpoint.router) ||
		endpointPathOf(endpoint) === "mcpGovernance/prepareMachineIdentityProbe"
	);
}

export function endpointPathOf(endpoint: ResolvedContractEndpoint): string {
	return `${endpoint.router}/${endpoint.procPath}`;
}

/**
 * Codepoint ordering, deliberately not `localeCompare`. Batch boundaries are
 * derived from this order, so it has to produce the same slices on every
 * runtime and every ICU data set — a locale-sensitive comparator would let two
 * invocations disagree about which endpoints belong to batch N.
 */
export function compareEndpointPath(
	left: ResolvedContractEndpoint,
	right: ResolvedContractEndpoint,
): number {
	const a = endpointPathOf(left);
	const b = endpointPathOf(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

export function projectionCandidates(
	options: ToolSchemaSyncInput,
): ResolvedContractEndpoint[] {
	if (options.router || options.endpoints?.length) {
		const candidates = listContractEndpoints({
			router: options.router,
			endpoints: options.endpoints,
			includeInternal: options.includeInternal !== false,
		});
		if (candidates.length === 0) {
			throw new Error(
				`Explicit tool projection resolved no contract endpoints${
					options.router ? ` for router "${options.router}"` : ""
				}`,
			);
		}
		return candidates.filter(
			(endpoint) =>
				isProjectableEndpoint(endpoint) &&
				!UNPROJECTABLE_ENDPOINTS.has(endpointPathOf(endpoint)) &&
				(endpoint.router !== "externalAgentIdentity" ||
					EXTERNAL_AGENT_MCP_ENDPOINTS.has(
						`${endpoint.router}/${endpoint.procPath}`,
					)),
		);
	}

	// Tedix admin projection is default-include: every oRPC procedure is MCP
	// eligible unless a caller explicitly scopes the projection.
	return listContractEndpoints({
		includeInternal: options.includeInternal !== false,
	}).filter(
		(endpoint) =>
			isProjectableEndpoint(endpoint) &&
			!UNPROJECTABLE_ENDPOINTS.has(endpointPathOf(endpoint)) &&
			(endpoint.router !== "externalAgentIdentity" ||
				EXTERNAL_AGENT_MCP_ENDPOINTS.has(
					`${endpoint.router}/${endpoint.procPath}`,
				)),
	);
}
