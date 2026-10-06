/**
 * MCP Health Check Router
 *
 * Connects to an app's MCP server and runs deterministic health checks:
 * connectivity, tool listing, schema validation, expected tools.
 *
 * One SDK v2 client pinned to 2026-07-28 per probe: the connect runs
 * `server/discover`, and every result is validated against the revision's wire
 * schemas (resultType, SEP-2549 freshness hints) before a check inspects it.
 * No LLM needed.
 */

import { implement } from "@orpc/server";
import { mcpHealthContract } from "@tedix/api-contract/contracts/mcp-health";
import { getManagementClient } from "@tedix/auth/client";
import {
	fetchConnectionToken,
	fetchTenantConnectionToken,
} from "@tedix/auth/connections";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	getAppBySlug,
	getAppBySlugForOrg,
	getAppsByOrganization,
} from "@tedix/db/queries/apps";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_SERVER_INFO_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import {
	FirstPartyMcpError,
	withFirstPartyMcp,
} from "../../lib/first-party-mcp";
import { buildMcpHost, buildMcpUrl } from "../../lib/mcp-client";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

// =============================================================================
// MCP Client helpers
// =============================================================================

interface McpJsonRpcResponse {
	result?: unknown;
	error?: { message: string; code?: number; data?: unknown };
}

interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface McpResource {
	uri: string;
	name?: string;
}

interface McpResourceTemplate {
	uriTemplate: string;
	name?: string;
}

interface HealthCheckOptions {
	expectedTools?: string[];
	forceCodeMode?: boolean;
	resourceUri?: string;
	missingResourceUri?: string;
	tasksExtension?: "absent" | "present" | "ignore";
}

// =============================================================================
// Auth token resolution
// =============================================================================

async function resolveAuthToken(
	context: BaseContext,
	tediId: string,
	connectionId: string,
	scope: "tenant" | "user" = "tenant",
): Promise<string | null> {
	if (!context.env.DESCOPE_MANAGEMENT_KEY) return null;

	const client = getManagementClient({
		DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
	});

	if (scope === "user") {
		const tedi = await getTediById(context.db, tediId);
		if (!tedi?.ownerUserId) return null;
		const token = await fetchConnectionToken(
			client,
			connectionId,
			tedi.ownerUserId,
		).catch(() => null);
		return token?.accessToken ?? null;
	}

	// tenant scope — look up org's descopeTenantId
	const tedi = await getTediById(context.db, tediId);
	if (!tedi?.organizationId) return null;
	const org = await getOrganizationById(context.db, tedi.organizationId);
	if (!org?.descopeTenantId) return null;

	let token = await fetchTenantConnectionToken(
		client,
		connectionId,
		org.descopeTenantId,
	).catch(() => null);

	// Fallback to user-scoped if no tenant token
	if (!token && tedi.ownerUserId) {
		token = await fetchConnectionToken(
			client,
			connectionId,
			tedi.ownerUserId,
		).catch(() => null);
	}

	return token?.accessToken ?? null;
}

// =============================================================================
// Health check runner
// =============================================================================

interface CheckResult {
	name: string;
	passed: boolean;
	detail: string;
	durationMs: number;
	data?: Record<string, unknown>;
}

async function runCheck(
	name: string,
	fn: () => Promise<
		string | { detail: string; data?: Record<string, unknown> }
	>,
): Promise<CheckResult> {
	const start = Date.now();
	try {
		const result = await fn();
		if (typeof result === "string") {
			return {
				name,
				passed: true,
				detail: result,
				durationMs: Date.now() - start,
			};
		}
		return {
			name,
			passed: true,
			detail: result.detail,
			data: result.data,
			durationMs: Date.now() - start,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { name, passed: false, detail: msg, durationMs: Date.now() - start };
	}
}

function hasCacheHint(result: unknown): result is {
	ttlMs: number;
	cacheScope: "private" | "public";
} {
	if (!result || typeof result !== "object") return false;
	const record = result as Record<string, unknown>;
	return (
		typeof record.ttlMs === "number" &&
		(record.cacheScope === "private" || record.cacheScope === "public")
	);
}

export async function runHealthChecks(
	mcpUrl: string,
	mcpHost: string,
	options: HealthCheckOptions = {},
	fetcher?: Fetcher,
	authHeaders?: Record<string, string>,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const headers: Record<string, string> = {
		"X-Tedix-Host": mcpHost,
		...(options.forceCodeMode ? { "X-Tedix-Code-Mode": "force" } : {}),
		...authHeaders,
	};

	const doFetch = fetcher
		? (url: string, init: RequestInit) => fetcher.fetch(url, init)
		: globalThis.fetch.bind(globalThis);

	const connectStart = Date.now();
	try {
		await withFirstPartyMcp(
			{
				url: mcpUrl,
				fetch: doFetch,
				headers,
				clientName: "tedix-mcp-protocol-probe",
				probe: true,
			},
			async (request, client) => {
				results.push({
					name: "connect",
					passed: true,
					detail: `connected (modern ${MCP_MODERN_PROTOCOL_VERSION}, sessionless)`,
					durationMs: Date.now() - connectStart,
				});
				// A JSON-RPC error is an answer the checks inspect, not a failure.
				const rpc = async (
					method: string,
					params: Record<string, unknown> = {},
				): Promise<McpJsonRpcResponse> => {
					try {
						return { result: await request(method, params) };
					} catch (error) {
						if (error instanceof FirstPartyMcpError && error.rpcError) {
							return { error: error.rpcError };
						}
						throw error;
					}
				};
				await runProtocolChecks(
					results,
					rpc,
					client.getDiscoverResult(),
					mcpHost,
					options,
				);
			},
		);
	} catch (err: unknown) {
		// Only the connect can fail here; every later check catches its own.
		if (results.length === 0) {
			results.push({
				name: "connect",
				passed: false,
				detail: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - connectStart,
			});
		}
	}
	return results;
}

async function runProtocolChecks(
	results: CheckResult[],
	rpc: (
		method: string,
		params?: Record<string, unknown>,
	) => Promise<McpJsonRpcResponse>,
	discovered: unknown,
	mcpHost: string,
	options: HealthCheckOptions,
): Promise<void> {
	let tools: McpTool[] = [];
	let discoveredCapabilities: Record<string, unknown> | undefined;

	results.push(
		await runCheck("server-discover", async () => {
			// The pinned connect already required a 2026-07-28 `resultType:
			// "complete"` discover result that advertises the revision.
			if (!discovered || typeof discovered !== "object") {
				throw new Error("server/discover result was not retained");
			}
			const result = discovered as Record<string, unknown>;
			const supportedVersions = Array.isArray(result.supportedVersions)
				? result.supportedVersions
				: [];
			if (!supportedVersions.includes(MCP_MODERN_PROTOCOL_VERSION)) {
				throw new Error(
					`server/discover does not advertise ${MCP_MODERN_PROTOCOL_VERSION}`,
				);
			}
			discoveredCapabilities =
				result.capabilities && typeof result.capabilities === "object"
					? (result.capabilities as Record<string, unknown>)
					: {};
			return {
				detail: `${supportedVersions.length} protocol versions advertised`,
				data: {
					supportedVersions,
					serverInfo: (result._meta as Record<string, unknown> | undefined)?.[
						MCP_SERVER_INFO_META_KEY
					],
					capabilities: discoveredCapabilities,
				},
			};
		}),
	);

	results.push(
		await runCheck("tasks-extension", async () => {
			const expectation = options.tasksExtension ?? "absent";
			if (expectation === "ignore") {
				return "tasks extension advertisement ignored";
			}

			const extensions =
				discoveredCapabilities?.extensions &&
				typeof discoveredCapabilities.extensions === "object"
					? (discoveredCapabilities.extensions as Record<string, unknown>)
					: {};
			const advertised = extensions[MCP_TASKS_EXTENSION] !== undefined;

			if (expectation === "present" && !advertised) {
				throw new Error("server/discover does not advertise MCP Tasks");
			}
			if (expectation === "absent" && advertised) {
				throw new Error(
					"server/discover advertises MCP Tasks on a surface this probe expected to have no mounted Tasks handlers",
				);
			}
			return advertised
				? "MCP Tasks extension advertised"
				: "MCP Tasks extension not advertised";
		}),
	);
	// 2. List tools
	results.push(
		await runCheck("list-tools", async () => {
			const data = await rpc("tools/list");
			if (data.error) throw new Error(data.error.message);
			const res = data.result as { tools?: McpTool[] };
			tools = res?.tools ?? [];
			if (tools.length === 0) throw new Error("No tools found");
			if (!hasCacheHint(data.result)) {
				throw new Error("tools/list result is missing ttlMs/cacheScope");
			}
			return {
				detail: `${tools.length} tools available`,
				data: { toolCount: tools.length },
			};
		}),
	);

	// 3. List resources
	results.push(
		await runCheck("list-resources", async () => {
			try {
				const data = await rpc("resources/list");
				if (data.error) return "resources not supported (OK for some servers)";
				if (!hasCacheHint(data.result)) {
					throw new Error("resources/list result is missing ttlMs/cacheScope");
				}
				const res = data.result as { resources?: McpResource[] };
				return `${res?.resources?.length ?? 0} resources`;
			} catch {
				return "resources not supported (OK for some servers)";
			}
		}),
	);

	// 4. Validate tool schemas
	results.push(
		await runCheck("tool-schemas-valid", async () => {
			const invalid: string[] = [];
			for (const tool of tools) {
				if (!tool.inputSchema || typeof tool.inputSchema !== "object") {
					invalid.push(tool.name);
				}
			}
			if (invalid.length > 0) {
				throw new Error(
					`${invalid.length} tools have invalid schemas: ${invalid.slice(0, 5).join(", ")}`,
				);
			}
			return `all ${tools.length} tool schemas valid`;
		}),
	);

	// 5. Check expected tools (if provided)
	if (options.expectedTools && options.expectedTools.length > 0) {
		results.push(
			await runCheck("expected-tools-present", async () => {
				const toolNames = tools.map((t) => t.name);
				const missing =
					options.expectedTools?.filter((e) => !toolNames.includes(e)) ?? [];
				if (missing.length > 0) {
					throw new Error(`Missing tools: ${missing.join(", ")}`);
				}
				return `all ${options.expectedTools?.length ?? 0} expected tools present`;
			}),
		);
	}

	results.push(
		await runCheck("list-resource-templates", async () => {
			const data = await rpc("resources/templates/list");
			if (data.error) throw new Error(data.error.message);
			if (!hasCacheHint(data.result)) {
				throw new Error(
					"resources/templates/list result is missing ttlMs/cacheScope",
				);
			}
			const res = data.result as {
				resourceTemplates?: McpResourceTemplate[];
			};
			return {
				detail: `${res.resourceTemplates?.length ?? 0} resource templates`,
				data: {
					resourceTemplates: (res.resourceTemplates ?? []).map(
						(t) => t.uriTemplate,
					),
				},
			};
		}),
	);

	const resourceUri = options.resourceUri;
	if (resourceUri) {
		results.push(
			await runCheck("read-resource", async () => {
				const data = await rpc("resources/read", { uri: resourceUri });
				if (data.error) throw new Error(data.error.message);
				if (!hasCacheHint(data.result)) {
					throw new Error("resources/read result is missing ttlMs/cacheScope");
				}
				const res = data.result as { contents?: unknown[] };
				if (!Array.isArray(res.contents) || res.contents.length === 0) {
					throw new Error("resources/read returned no contents");
				}
				return `read ${resourceUri}`;
			}),
		);
	}

	const missingResourceUri =
		options.missingResourceUri ??
		`ui://widgets/mcp-app/${mcpHost.split(".")[0]}/missing-protocol-probe.txt`;
	results.push(
		await runCheck("missing-resource-error", async () => {
			const data = await rpc("resources/read", {
				uri: missingResourceUri,
			});
			if (data.error?.code !== -32602) {
				throw new Error(
					`expected -32602 for missing resource, got ${data.error?.code ?? "success"}`,
				);
			}
			return {
				detail: "missing resources fail with JSON-RPC InvalidParams",
				data: { uri: missingResourceUri, error: data.error },
			};
		}),
	);
	// 6. Server info
	results.push(
		await runCheck(
			"server-info",
			async () => `modern ${MCP_MODERN_PROTOCOL_VERSION} probe successful`,
		),
	);
}

// =============================================================================
// Router
// =============================================================================

const mcpHealthOs = implement(mcpHealthContract).$context<BaseContext>();
const authed = mcpHealthOs.use(withAuth).use(withFleetAuthority);

function isServiceOrPlatformPrincipal(context: BaseContext): boolean {
	return context.authType === "service-binding" || isPlatformPrincipal(context);
}

function assertCanProbeApp(
	context: BaseContext,
	app: unknown,
	appOrganizationId: string | null,
): void {
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (isServiceOrPlatformPrincipal(context)) return;
	if (!context.organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
	}
	if (appOrganizationId !== context.organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"App does not belong to caller organization",
		);
	}
}

export async function resolveHealthProbeApp(
	context: BaseContext,
	appSlug: string,
	lookup: {
		global: typeof getAppBySlug;
		forOrganization: typeof getAppBySlugForOrg;
		listForOrganization: typeof getAppsByOrganization;
	} = {
		global: getAppBySlug,
		forOrganization: getAppBySlugForOrg,
		listForOrganization: getAppsByOrganization,
	},
) {
	if (isServiceOrPlatformPrincipal(context)) {
		return lookup.global(context.db, appSlug);
	}
	if (!context.organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
	}
	// Slugs are unique only inside an organization. A bare lookup can resolve a
	// same-slug app owned by another tenant and then reject a legitimate installed
	// app, or — if this guard ever changed — probe the wrong tenant's configuration.
	const direct = await lookup.forOrganization(
		context.db,
		appSlug,
		context.organizationId,
	);
	if (direct) return direct;

	// Connection references name the platform source app (for example `initech`),
	// while catalog installation materializes a tenant proxy with its own slug
	// (for example `initech-acme`). Probe that tenant-owned proxy: it is the
	// service the organization actually installed and the endpoint that exposes
	// the inherited tool inventory.
	const sourceSlug = appSlug.trim().toLowerCase();
	const proxies = (
		await lookup.listForOrganization(context.db, context.organizationId)
	)
		.filter((candidate) => {
			const metadata = candidate.metadata as Record<string, unknown> | null;
			const mcpConfig = metadata?.mcpConfig as
				| Record<string, unknown>
				| undefined;
			const aggregateApps = mcpConfig?.aggregateApps;
			return (
				Array.isArray(aggregateApps) &&
				aggregateApps.some(
					(entry) =>
						entry !== null &&
						typeof entry === "object" &&
						typeof (entry as { slug?: unknown }).slug === "string" &&
						(entry as { slug: string }).slug.trim().toLowerCase() ===
							sourceSlug,
				)
			);
		})
		.sort((left, right) => left.slug.localeCompare(right.slug));
	return proxies[0] ?? null;
}

function buildServiceMcpHeaders(
	context: BaseContext,
	options: { organizationId?: string | null; tediId?: string | null },
): Record<string, string> {
	const serviceToken = (
		context.env as CloudflareEnv & {
			PLATFORM_SERVICE_TOKEN?: string;
		}
	).PLATFORM_SERVICE_TOKEN;

	return {
		"X-Service-Binding": "true",
		...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
		...(options.organizationId
			? { "X-Tedix-Org-Id": options.organizationId }
			: {}),
		...(options.tediId ? { "X-Tedix-Tedi-Id": options.tediId } : {}),
	};
}

function isProtectedMcpApp(app: { metadata: unknown } | null): boolean {
	const metadata =
		app?.metadata && typeof app.metadata === "object"
			? (app.metadata as Record<string, unknown>)
			: null;
	const mcpConfig =
		metadata?.mcpConfig && typeof metadata.mcpConfig === "object"
			? (metadata.mcpConfig as Record<string, unknown>)
			: null;
	const authMode = mcpConfig?.authMode ?? "authenticated";
	return authMode === "authenticated" || authMode === "proxy-target";
}

function isCodeModeApp(app: { metadata: unknown } | null): boolean {
	const metadata =
		app?.metadata && typeof app.metadata === "object"
			? (app.metadata as Record<string, unknown>)
			: null;
	const mcpConfig =
		metadata?.mcpConfig && typeof metadata.mcpConfig === "object"
			? (metadata.mcpConfig as Record<string, unknown>)
			: null;
	return mcpConfig?.codeMode === true;
}

export const mcpHealthContractRouter = mcpHealthOs.router({
	run: authed.run.use(AUTHZ.appsRead).handler(async ({ input, context }) => {
		const {
			appSlug,
			expectedTools,
			connectionId,
			tediId,
			scope,
			authStrategy = "auto",
			resourceUri,
			missingResourceUri,
			tasksExtension,
		} = input;

		const mcpBaseUrl = context.env.MCP_URL;
		if (!mcpBaseUrl) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"MCP_URL not configured",
			);
		}

		const app = await resolveHealthProbeApp(context, appSlug);
		assertCanProbeApp(
			context,
			app,
			(app as { organizationId?: string | null } | null)?.organizationId ??
				null,
		);
		let authHeaders: Record<string, string> | undefined;

		if (authStrategy === "service") {
			authHeaders = buildServiceMcpHeaders(context, {
				organizationId: app?.organizationId,
				tediId,
			});
		} else if (authStrategy === "connection" && connectionId && tediId) {
			const resolved = await resolveAuthToken(
				context,
				tediId,
				connectionId,
				scope ?? "tenant",
			);
			authHeaders = resolved
				? { Authorization: `Bearer ${resolved}` }
				: undefined;
		} else if (authStrategy === "auto") {
			if (isProtectedMcpApp(app)) {
				authHeaders = buildServiceMcpHeaders(context, {
					organizationId: app?.organizationId,
					tediId,
				});
			} else if (connectionId && tediId) {
				const resolved = await resolveAuthToken(
					context,
					tediId,
					connectionId,
					scope ?? "tenant",
				);
				authHeaders = resolved
					? { Authorization: `Bearer ${resolved}` }
					: undefined;
			}
		}

		const mcpUrl = buildMcpUrl(mcpBaseUrl);
		const mcpHost = buildMcpHost(appSlug, mcpBaseUrl);
		const mcpService = context.env.MCP_SERVICE;
		const overallStart = Date.now();
		const checks = await runHealthChecks(
			mcpUrl,
			mcpHost,
			{
				expectedTools,
				forceCodeMode: isCodeModeApp(app),
				resourceUri,
				missingResourceUri,
				tasksExtension,
			},
			mcpService,
			authHeaders,
		);
		const totalDurationMs = Date.now() - overallStart;

		const passCount = checks.filter((c) => c.passed).length;
		const failCount = checks.filter((c) => !c.passed).length;
		const listToolsCheck = checks.find((check) => check.name === "list-tools");
		const toolCount =
			listToolsCheck?.passed &&
			typeof listToolsCheck.data?.toolCount === "number"
				? listToolsCheck.data.toolCount
				: null;

		return {
			app: appSlug,
			url: `https://${mcpHost}/mcp`,
			toolCount,
			allPassed: failCount === 0,
			passCount,
			failCount,
			totalDurationMs,
			checks,
		};
	}),
});
