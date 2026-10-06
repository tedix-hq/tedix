import type {
	ToolConfig,
	ToolInputJsonSchema,
	ToolJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import type { DbClient } from "@tedix/db/client";
import { getAppById, updateApp } from "@tedix/db/queries/app-records";
import {
	deleteTool,
	getToolsByAppId,
	upsertTool,
} from "@tedix/db/queries/tools";
import type { AppMetadata } from "@tedix/db/schema/apps";
import { toJsonRecord } from "@tedix/db/utils/json";
import { isRecord } from "@tedix/api-contract/utils/is-record";

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface GoogleDiscoveryServiceConfig {
	name: string;
	version: string;
	discoveryUrl?: string;
}

export interface GoogleDiscoveryImportInput {
	appId: string;
	services?: GoogleDiscoveryServiceConfig[];
	connectionProviderId?: string;
	connectionScope?: "tenant" | "user" | "hybrid";
	includeMethodIds?: string[];
	excludeMethodIds?: string[];
	replaceExisting?: boolean;
	dryRun?: boolean;
	limit?: number;
}

export interface GoogleDiscoveryImportResult {
	appId: string;
	dryRun: boolean;
	totalOperations: number;
	planned: number;
	created: number;
	updated: number;
	deleted: number;
	inSync: number;
	skipped: number;
	failed: number;
	items: Array<{
		toolId: string;
		methodId: string;
		service: string;
		method: string;
		path: string;
		status:
			| "created"
			| "updated"
			| "inSync"
			| "wouldCreate"
			| "wouldUpdate"
			| "deleted"
			| "skipped"
			| "failed";
		message?: string;
	}>;
}

export interface GoogleDiscoveryDocument {
	name?: string;
	version?: string;
	revision?: string;
	rootUrl?: string;
	baseUrl?: string;
	servicePath?: string;
	schemas?: Record<string, JsonObject>;
	resources?: Record<string, GoogleResource>;
	methods?: Record<string, GoogleMethod>;
}

export interface GoogleResource {
	resources?: Record<string, GoogleResource>;
	methods?: Record<string, GoogleMethod>;
}

export interface GoogleMethod {
	id?: string;
	path?: string;
	httpMethod?: string;
	description?: string;
	parameters?: Record<string, GoogleParameter>;
	request?: { $ref?: string };
	response?: { $ref?: string };
	scopes?: string[];
	supportsMediaUpload?: boolean;
	mediaUpload?: unknown;
	supportsMediaDownload?: boolean;
}

export interface GoogleParameter {
	type?: string;
	format?: string;
	description?: string;
	required?: boolean;
	repeated?: boolean;
	enum?: string[];
	location?: string;
	default?: unknown;
}

export interface GoogleOperation {
	service: string;
	version: string;
	revision?: string;
	methodId: string;
	httpMethod: HttpMethod;
	path: string;
	method: GoogleMethod;
	doc: GoogleDiscoveryDocument;
}

const DEFAULT_GOOGLE_SERVICES: GoogleDiscoveryServiceConfig[] = [
	{ name: "gmail", version: "v1" },
	{ name: "drive", version: "v3" },
	{ name: "calendar", version: "v3" },
	{ name: "docs", version: "v1" },
	{ name: "sheets", version: "v4" },
	{ name: "slides", version: "v1" },
	{ name: "tasks", version: "v1" },
];

function requireGoogleConnectionProviderId(value: string | undefined): string {
	if (value) return value;
	throw new Error(
		"Google Discovery import requires an explicit product-scoped Google connectionProviderId such as google-analytics, google-gmail, google-calendar, google-drive, or google-chat.",
	);
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	return `{${Object.keys(value as JsonObject)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableStringify((value as JsonObject)[key])}`,
		)
		.join(",")}}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return stableStringify(a ?? null) === stableStringify(b ?? null);
}

async function sha256(value: unknown): Promise<string> {
	const encoded = new TextEncoder().encode(stableStringify(value));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function readStoredSyncConfig(
	metadata: unknown,
): Partial<GoogleDiscoveryImportInput> {
	if (!isRecord(metadata)) return {};
	const mcpConfig = isRecord(metadata.mcpConfig) ? metadata.mcpConfig : {};
	return isRecord(mcpConfig.googleDiscoverySync)
		? (mcpConfig.googleDiscoverySync as Partial<GoogleDiscoveryImportInput>)
		: {};
}

function discoveryUrlFor(service: GoogleDiscoveryServiceConfig): string {
	return (
		service.discoveryUrl ??
		`https://www.googleapis.com/discovery/v1/apis/${encodeURIComponent(
			service.name,
		)}/${encodeURIComponent(service.version)}/rest`
	);
}

async function fetchDiscoveryDocument(
	service: GoogleDiscoveryServiceConfig,
): Promise<GoogleDiscoveryDocument> {
	const response = await fetch(discoveryUrlFor(service));
	if (!response.ok) {
		throw new Error(
			`Google Discovery fetch failed for ${service.name} ${service.version}: HTTP ${response.status}`,
		);
	}
	const body = (await response.json()) as unknown;
	if (!isRecord(body)) {
		throw new Error(
			`Google Discovery document must be an object for ${service.name}`,
		);
	}
	return body as GoogleDiscoveryDocument;
}

function collectOperations(
	doc: GoogleDiscoveryDocument,
	service: GoogleDiscoveryServiceConfig,
): GoogleOperation[] {
	const operations: GoogleOperation[] = [];
	const visit = (resource: GoogleResource | GoogleDiscoveryDocument) => {
		for (const method of Object.values(resource.methods ?? {})) {
			if (!method.id || !method.path || !method.httpMethod) continue;
			const httpMethod = method.httpMethod.toUpperCase();
			if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(httpMethod)) {
				continue;
			}
			operations.push({
				service: service.name,
				version: service.version,
				revision: doc.revision,
				methodId: method.id,
				httpMethod: httpMethod as HttpMethod,
				path: method.path,
				method,
				doc,
			});
		}
		for (const child of Object.values(resource.resources ?? {})) {
			visit(child);
		}
	};
	visit(doc);
	return operations;
}

function normalizeToolId(methodId: string): string {
	return methodId
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function endpointFromDiscoveryPath(path: string): string {
	return path.replace(/\{([^}]+)\}/g, ":$1").replace(/^\/+/, "");
}

function discoverySchemaToJsonSchema(
	doc: GoogleDiscoveryDocument,
	schema: unknown,
	seen = new Set<string>(),
): JsonObject {
	if (!isRecord(schema)) return {};
	const ref = typeof schema.$ref === "string" ? schema.$ref : null;
	if (ref) {
		if (seen.has(ref)) return {};
		const next = doc.schemas?.[ref];
		return discoverySchemaToJsonSchema(doc, next, new Set([...seen, ref]));
	}

	const out: JsonObject = {};
	if (typeof schema.description === "string")
		out.description = schema.description;
	if (typeof schema.type === "string") out.type = schema.type;
	if (typeof schema.format === "string") out.format = schema.format;
	if (Array.isArray(schema.enum)) out.enum = schema.enum;
	if (isRecord(schema.items)) {
		out.items = discoverySchemaToJsonSchema(doc, schema.items, seen);
	}
	if (isRecord(schema.properties)) {
		out.type = "object";
		out.properties = Object.fromEntries(
			Object.entries(schema.properties).map(([key, property]) => [
				key,
				discoverySchemaToJsonSchema(doc, property, seen),
			]),
		);
	}
	if (schema.additionalProperties !== undefined) {
		out.additionalProperties =
			typeof schema.additionalProperties === "boolean"
				? schema.additionalProperties
				: isRecord(schema.additionalProperties)
					? discoverySchemaToJsonSchema(doc, schema.additionalProperties, seen)
					: true;
	}
	return out;
}

function parameterSchema(parameter: GoogleParameter): JsonObject {
	const type = parameter.repeated ? "array" : (parameter.type ?? "string");
	const itemSchema: JsonObject = {
		type: parameter.type ?? "string",
		...(parameter.format ? { format: parameter.format } : {}),
		...(parameter.enum ? { enum: parameter.enum } : {}),
	};
	return {
		type,
		...(parameter.description ? { description: parameter.description } : {}),
		...(parameter.default !== undefined ? { default: parameter.default } : {}),
		...(parameter.repeated ? { items: itemSchema } : {}),
		...(!parameter.repeated && parameter.format
			? { format: parameter.format }
			: {}),
		...(!parameter.repeated && parameter.enum ? { enum: parameter.enum } : {}),
	};
}

function inputSchemaForOperation(
	operation: GoogleOperation,
): ToolInputJsonSchema {
	const properties: Record<string, JsonObject> = {};
	const required: string[] = [];
	const staticParamNames = staticParamsForOperation(operation);

	for (const [name, parameter] of Object.entries(
		operation.method.parameters ?? {},
	)) {
		if (staticParamNames.has(name)) continue;
		properties[name] = parameterSchema(parameter);
		if (parameter.required) required.push(name);
	}

	if (operation.method.request?.$ref) {
		properties.body = discoverySchemaToJsonSchema(operation.doc, {
			$ref: operation.method.request.$ref,
		});
		required.push("body");
	}

	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	} as ToolInputJsonSchema;
}

function outputSchemaForOperation(
	operation: GoogleOperation,
): ToolJsonSchema | null {
	const responseRef = operation.method.response?.$ref;
	if (!responseRef) return null;
	return discoverySchemaToJsonSchema(operation.doc, {
		$ref: responseRef,
	}) as ToolJsonSchema;
}

function staticParamsForOperation(operation: GoogleOperation): Set<string> {
	const params = new Set<string>();
	if (operation.service === "gmail" && operation.method.parameters?.userId) {
		params.add("userId");
	}
	return params;
}

function baseUrlForDocument(doc: GoogleDiscoveryDocument): string {
	const rootUrl = doc.rootUrl ?? doc.baseUrl;
	if (!rootUrl)
		throw new Error("Google Discovery document missing rootUrl/baseUrl");
	return rootUrl.replace(/\/+$/, "");
}

function buildToolConfig(
	input: Required<Pick<GoogleDiscoveryImportInput, "connectionProviderId">> &
		Pick<GoogleDiscoveryImportInput, "connectionScope">,
	operation: GoogleOperation,
): ToolConfig & JsonObject {
	const staticParamNames = staticParamsForOperation(operation);
	const staticParams = Object.fromEntries(
		[...staticParamNames].map((name) => [
			name,
			name === "userId" ? "me" : undefined,
		]),
	);
	return {
		transport: "external",
		method: operation.httpMethod,
		baseUrl: baseUrlForDocument(operation.doc),
		endpoint: endpointFromDiscoveryPath(operation.path),
		...(operation.method.request?.$ref
			? { requestBodyParam: "body", requestContentType: "application/json" }
			: {}),
		...(Object.keys(staticParams).length > 0 ? { staticParams } : {}),
		auth: {
			type: "connection",
			connectionId: input.connectionProviderId,
			scope: input.connectionScope ?? "user",
			credentialScope: input.connectionScope ?? "user",
			...(input.connectionScope === "hybrid"
				? { credentialPreference: "user-first" as const }
				: {}),
		},
		googleDiscovery: {
			service: operation.service,
			version: operation.version,
			revision: operation.revision,
			methodId: operation.methodId,
			scopes: operation.method.scopes ?? [],
			supportsMediaUpload: Boolean(operation.method.supportsMediaUpload),
			supportsMediaDownload: Boolean(operation.method.supportsMediaDownload),
			mediaUpload: operation.method.mediaUpload ?? null,
		},
	};
}

function buildSyncMetadata(
	appMetadata: JsonObject,
	input: GoogleDiscoveryImportInput,
	result: Omit<GoogleDiscoveryImportResult, "items">,
	syncedAt = new Date().toISOString(),
): AppMetadata {
	const mcpConfig = isRecord(appMetadata.mcpConfig)
		? appMetadata.mcpConfig
		: {};
	return {
		...appMetadata,
		mcpConfig: {
			...mcpConfig,
			googleDiscoverySync: {
				enabled: true,
				services: input.services ?? DEFAULT_GOOGLE_SERVICES,
				connectionProviderId: requireGoogleConnectionProviderId(
					input.connectionProviderId,
				),
				connectionScope: input.connectionScope ?? "user",
				includeMethodIds: input.includeMethodIds,
				excludeMethodIds: input.excludeMethodIds,
				replaceExisting: input.replaceExisting !== false,
				lastSyncedAt: syncedAt,
				lastResult: {
					totalOperations: result.totalOperations,
					planned: result.planned,
					created: result.created,
					updated: result.updated,
					deleted: result.deleted,
					inSync: result.inSync,
					failed: result.failed,
				},
			},
		},
	} as AppMetadata;
}

export async function runGoogleDiscoveryToolImport(
	db: DbClient,
	input: GoogleDiscoveryImportInput,
): Promise<GoogleDiscoveryImportResult> {
	const app = await getAppById(db, input.appId);
	if (!app) throw new Error(`App not found: ${input.appId}`);
	const appMetadata = isRecord(app.metadata) ? app.metadata : {};
	const stored = readStoredSyncConfig(appMetadata);
	const resolved: GoogleDiscoveryImportInput = {
		...stored,
		...input,
		services: input.services ?? stored.services ?? DEFAULT_GOOGLE_SERVICES,
		connectionProviderId: requireGoogleConnectionProviderId(
			input.connectionProviderId ?? stored.connectionProviderId,
		),
		connectionScope: input.connectionScope ?? stored.connectionScope ?? "user",
		replaceExisting: input.replaceExisting ?? stored.replaceExisting ?? true,
		dryRun: input.dryRun ?? true,
	};

	const include = resolved.includeMethodIds
		? new Set(resolved.includeMethodIds)
		: null;
	const exclude = new Set(resolved.excludeMethodIds ?? []);
	const dryRun = resolved.dryRun ?? true;
	const replaceExisting = resolved.replaceExisting !== false;
	const existingTools = await getToolsByAppId(db, resolved.appId);
	const existingByToolId = new Map(
		existingTools.map((tool) => [tool.toolId, tool]),
	);
	const generatedToolIds = new Set<string>();
	const items: GoogleDiscoveryImportResult["items"] = [];
	let totalOperations = 0;
	let planned = 0;
	let created = 0;
	let updated = 0;
	let deleted = 0;
	let inSync = 0;
	let skipped = 0;
	let failed = 0;

	for (const service of resolved.services ?? DEFAULT_GOOGLE_SERVICES) {
		const doc = await fetchDiscoveryDocument(service);
		for (const operation of collectOperations(doc, service)) {
			totalOperations++;
			if (include && !include.has(operation.methodId)) continue;
			if (exclude.has(operation.methodId)) continue;
			const toolId = normalizeToolId(operation.methodId);
			generatedToolIds.add(toolId);
			planned++;
			if (resolved.limit && planned > resolved.limit) {
				planned--;
				skipped++;
				items.push({
					toolId,
					methodId: operation.methodId,
					service: operation.service,
					method: operation.httpMethod,
					path: operation.path,
					status: "skipped",
					message: "Limit reached",
				});
				continue;
			}

			try {
				const inputSchema = inputSchemaForOperation(operation);
				const outputSchema = outputSchemaForOperation(operation);
				const config = buildToolConfig(
					{
						connectionProviderId: resolved.connectionProviderId!,
						connectionScope: resolved.connectionScope,
					},
					operation,
				);
				const annotations = {
					readOnlyHint: operation.httpMethod === "GET",
					destructiveHint: operation.httpMethod === "DELETE",
				};
				const schemaSourceRef = `${discoveryUrlFor(service)}#${operation.methodId}`;
				const schemaSourceHash = await sha256({
					method: operation.method,
					inputSchema,
					outputSchema,
					config,
					annotations,
				});
				const existing = existingByToolId.get(toolId);
				const matches =
					existing?.schemaSource === "google-discovery" &&
					existing.schemaSourceHash === schemaSourceHash &&
					jsonEqual(existing.inputSchema, inputSchema) &&
					jsonEqual(existing.outputSchema, outputSchema) &&
					jsonEqual(existing.config, config) &&
					jsonEqual(existing.annotations, annotations);
				const status = existing
					? matches
						? "inSync"
						: dryRun
							? "wouldUpdate"
							: "updated"
					: dryRun
						? "wouldCreate"
						: "created";

				if (status === "inSync") {
					inSync++;
				} else if (!dryRun) {
					await upsertTool(db, {
						appId: resolved.appId,
						toolId,
						toolTypeId: "external",
						title: operation.methodId,
						description: operation.method.description ?? operation.methodId,
						inputSchema,
						outputSchema,
						config: toJsonRecord(config),
						authRequired: true,
						visibility: "private",
						annotations,
						schemaDialect: "json-schema-2020-12",
						schemaSource: "google-discovery",
						schemaSourceRef,
						schemaSourceHash,
						schemaSyncedAt: new Date().toISOString(),
						enabled: true,
						sortOrder: 0,
					});
					if (status === "created") created++;
					if (status === "updated") updated++;
				}

				items.push({
					toolId,
					methodId: operation.methodId,
					service: operation.service,
					method: operation.httpMethod,
					path: operation.path,
					status,
				});
			} catch (error) {
				failed++;
				items.push({
					toolId,
					methodId: operation.methodId,
					service: operation.service,
					method: operation.httpMethod,
					path: operation.path,
					status: "failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	if (replaceExisting) {
		for (const tool of existingTools) {
			if (tool.schemaSource !== "google-discovery") continue;
			if (generatedToolIds.has(tool.toolId)) continue;
			if (!dryRun) {
				await deleteTool(db, tool.id);
				deleted++;
			}
			items.push({
				toolId: tool.toolId,
				methodId: tool.toolId,
				service: "google",
				method: "*",
				path: "*",
				status: dryRun ? "skipped" : "deleted",
			});
		}
	}

	const result: GoogleDiscoveryImportResult = {
		appId: resolved.appId,
		dryRun,
		totalOperations,
		planned,
		created,
		updated,
		deleted,
		inSync,
		skipped,
		failed,
		items,
	};

	if (!dryRun) {
		await updateApp(db, resolved.appId, {
			metadata: buildSyncMetadata(appMetadata, resolved, result),
		});
	}

	return result;
}

/** @internal */
export const googleDiscoveryToolImportTestInternals = {
	collectOperations,
	discoverySchemaToJsonSchema,
	endpointFromDiscoveryPath,
	inputSchemaForOperation,
	normalizeToolId,
	requireGoogleConnectionProviderId,
};
