/**
 * Explicit operator MCP reads.
 *
 * This is intentionally outside the Home planner: the caller supplies the
 * app, exact tool, and arguments, and the server re-checks the live MCP
 * catalog before execution. The MCP edge remains the authority for scopes,
 * connection credentials, and telemetry. We retain only a bounded durable
 * request/receipt in the Home transcript.
 */
import type {
	ExecuteHomeReadOnlyToolOutput,
	HomeReadOnlyApp,
	HomeMessage,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import { getAppsBySlugsWithTools } from "@tedix/db/queries/app-records";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getConnectionProviderById } from "@tedix/db/queries/connection-providers";
import { getKernelRuntimeEventById } from "@tedix/db/queries/kernel-runtime-events";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import {
	READ_OBSERVATION_META_KEY,
	parseDocsFileObservationReceipt,
} from "@tedix/mcp-shared/read-observation-receipt";
import { auditActor } from "../../audit-helpers";
import {
	FirstPartyMcpError,
	requestFirstPartyMcp,
} from "../../../lib/first-party-mcp";
import {
	type BoundedMcpList,
	collectBoundedMcpList,
} from "@tedix/mcp-shared/bounded-list";
import { resolveConnectionAvailability } from "../../../services/connection-availability";
import { retainKernelToolResult } from "../../../services/kernel-tool-result-retention";
import { resolveWorkspaceContext } from "./execution-proposals";
import { AUTHZ, ErrorCodes, createError } from "../../orpc";
import {
	ensureHomeConversationAccess,
	insertKernelRuntimeEvent,
	insertKernelRuntimeEventWithStatus,
} from "../kernel/run-store";
import {
	errorMessage,
	nowIso,
	offsetIso,
	resolveOrganizationId,
} from "../kernel/runtime-shared";
import { authed } from "./policy-normalization";

type McpTool = {
	name?: unknown;
	annotations?: { readOnlyHint?: unknown };
};

function storedReadOnly(annotations: unknown): boolean {
	return Boolean(
		annotations &&
		typeof annotations === "object" &&
		!Array.isArray(annotations) &&
		(annotations as Record<string, unknown>).readOnlyHint === true,
	);
}

type DirectReadConnectionRequirement = {
	providerId: string;
	tokenScope: "tenant" | "user" | "either";
	scopes: string[];
};

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Mirrors the aggregate MCP host's connection override: a tool must already
 * declare connection auth; the organization app may then replace its provider,
 * scope, and scope labels. */
export function directReadConnectionRequirement(input: {
	appMetadata: unknown;
	toolConfig: unknown;
}): DirectReadConnectionRequirement | null {
	const config = record(input.toolConfig);
	const auth = record(config?.auth);
	if (auth?.type !== "connection") return null;
	const metadata = record(input.appMetadata);
	const mcpConfig = record(metadata?.mcpConfig);
	const providerId = (
		typeof mcpConfig?.connectionProviderId === "string"
			? mcpConfig.connectionProviderId
			: typeof auth.connectionId === "string"
				? auth.connectionId
				: ""
	).trim();
	if (!providerId) return null;
	const rawScope =
		mcpConfig?.connectionScope ?? auth.credentialScope ?? auth.scope;
	const tokenScope =
		rawScope === "user" ? "user" : rawScope === "hybrid" ? "either" : "tenant";
	const rawScopes =
		Array.isArray(mcpConfig?.connectionScopes) &&
		mcpConfig.connectionScopes.length > 0
			? mcpConfig.connectionScopes
			: auth.scopes;
	const scopes = Array.isArray(rawScopes)
		? rawScopes.filter((value): value is string => typeof value === "string")
		: [];
	return { providerId, tokenScope, scopes };
}

type ToolConnectionState = Pick<
	HomeReadOnlyApp["tools"][number],
	"connectionState" | "connectionReason" | "connectProviderId"
>;

export const DIRECT_READ_STALE_FENCE_MS = 120_000;

export function directReadFenceIsStale(
	createdAt: string,
	now = Date.now(),
): boolean {
	const created = Date.parse(createdAt);
	return (
		Number.isFinite(created) && now - created >= DIRECT_READ_STALE_FENCE_MS
	);
}

async function resolveDirectReadConnectionState(input: {
	context: {
		db: Parameters<typeof resolveConnectionAvailability>[0]["db"];
		env: CloudflareEnv;
	};
	organizationId: string;
	actingUserId: string | null;
	requirement: DirectReadConnectionRequirement | null;
}): Promise<ToolConnectionState> {
	if (!input.requirement) {
		return {
			connectionState: "connected",
			connectionReason: null,
			connectProviderId: null,
		};
	}
	const [availability, provider] = await Promise.all([
		resolveConnectionAvailability({
			db: input.context.db,
			env: input.context.env,
			organizationId: input.organizationId,
			ownerUserId: input.actingUserId,
			...input.requirement,
		}),
		getConnectionProviderById(input.context.db, input.requirement.providerId),
	]);
	return {
		connectionState: availability.connected
			? "connected"
			: availability.cause === "no_token"
				? "connection_required"
				: "unavailable",
		connectionReason: availability.connected ? null : availability.reason,
		connectProviderId:
			availability.cause === "no_token"
				? (provider?.descopeAppId ?? null)
				: null,
	};
}

function appConnectionState(
	tools: HomeReadOnlyApp["tools"],
): HomeReadOnlyApp["connectionState"] {
	if (tools.some((tool) => tool.connectionState === "connected"))
		return "connected";
	if (tools.some((tool) => tool.connectionState === "connection_required"))
		return "connection_required";
	return "unavailable";
}

/**
 * Reconcile stored read-only tools against the live catalog.
 *
 * `live.truncated` is load-bearing: a tool missing from a catalog that was cut
 * short by the pagination bound has NOT been shown to be missing or writeable,
 * so it is reported as unverified rather than as a catalog that declines to
 * declare it read-only. The distinction is the difference between an honest
 * "we could not check" and a false accusation against the provider.
 */
export function reconcileLiveReadOnlyTools(
	tools: HomeReadOnlyApp["tools"],
	live: BoundedMcpList<McpTool> | null,
): HomeReadOnlyApp["tools"] {
	const liveReadOnlyNames = new Set(
		(live?.items ?? [])
			.filter((tool) => tool.annotations?.readOnlyHint === true)
			.map((tool) => tool.name)
			.filter((name): name is string => typeof name === "string"),
	);
	const reason = !live
		? "The live MCP tool catalog could not be verified."
		: live.truncated
			? "The live MCP tool catalog was too large to verify completely."
			: "The live MCP catalog does not declare this tool read-only.";
	return tools.map((tool) =>
		tool.connectionState !== "connected" || liveReadOnlyNames.has(tool.name)
			? tool
			: {
					...tool,
					connectionState: "unavailable" as const,
					connectionReason: reason,
					connectProviderId: null,
				},
	);
}

export const listReadOnlyToolsRoute = authed.listReadOnlyTools
	.use(AUTHZ.appsRead)
	.handler(async ({ context, input }): Promise<{ apps: HomeReadOnlyApp[] }> => {
		const organizationId = resolveOrganizationId(context, input.organizationId);
		const actingUserId = context.descopeUserId ?? context.user?.sub ?? null;
		const connectionStates = new Map<string, Promise<ToolConnectionState>>();
		const connectionState = (
			requirement: DirectReadConnectionRequirement | null,
		) => {
			const key = requirement
				? JSON.stringify([
						requirement.providerId,
						requirement.tokenScope,
						[...requirement.scopes].sort(),
					])
				: "none";
			const existing = connectionStates.get(key);
			if (existing) return existing;
			const pending = resolveDirectReadConnectionState({
				context,
				organizationId,
				actingUserId,
				requirement,
			});
			connectionStates.set(key, pending);
			return pending;
		};
		const apps = await getAppsByOrganization(context.db, organizationId);
		const surfaces = await getAppsBySlugsWithTools(
			context.db,
			apps.map((app) => ({ slug: app.slug })),
		);
		const resolvedApps = await Promise.all(
			surfaces.map(async (surface) => {
				if (!surface || surface.app.organizationId !== organizationId)
					return null;
				const storedTools: HomeReadOnlyApp["tools"] = await Promise.all(
					surface.tools
						.filter((tool) => storedReadOnly(tool.annotations))
						.map(async (tool) => ({
							name: tool.toolId,
							title: tool.title || tool.toolId,
							description: tool.description,
							inputSchema: tool.inputSchema,
							...(await connectionState(
								directReadConnectionRequirement({
									appMetadata: surface.app.metadata,
									toolConfig: tool.config,
								}),
							)),
						})),
				);
				let liveTools: BoundedMcpList<McpTool> | null = null;
				if (storedTools.some((tool) => tool.connectionState === "connected")) {
					try {
						// The aggregate surface pages at 200 tools; reading only the first
						// page would report every later read-only tool "unavailable".
						liveTools = await listLiveTools({
							context,
							organizationId,
							appSlug: surface.app.slug,
							actingUserId: actingUserId ?? undefined,
						});
					} catch {
						// Discovery fails closed per tool; other apps remain usable.
					}
				}
				const tools = reconcileLiveReadOnlyTools(storedTools, liveTools);
				if (tools.length === 0) return null;
				return {
					slug: surface.app.slug,
					name: surface.app.name,
					logoUrl: surface.app.logoUrl,
					connectionState: appConnectionState(tools),
					tools,
				} satisfies HomeReadOnlyApp;
			}),
		);
		return {
			apps: resolvedApps
				.filter((app) => app !== null)
				.sort((a, b) => {
					const rank = { connected: 0, connection_required: 1, unavailable: 2 };
					return (
						rank[a.connectionState] - rank[b.connectionState] ||
						a.name.localeCompare(b.name)
					);
				}) as HomeReadOnlyApp[],
		};
	});

type McpToolResult = {
	structuredContent?: unknown;
	content?: unknown;
	isError?: unknown;
	_meta?: unknown;
};

export function ownedHomeReadObservation(
	result: McpToolResult,
	owner: {
		organizationId: string;
		conversationId: string;
		requestEventId: string;
		idempotencyKey: string;
		actor: { type: string; id: string };
		appSlug: string;
		toolName: string;
		siteId: unknown;
		path: unknown;
	},
) {
	const meta = record(result._meta);
	const receipt = parseDocsFileObservationReceipt(
		meta?.[READ_OBSERVATION_META_KEY],
	);
	return receipt &&
		owner.appSlug === "tedix-docs" &&
		owner.toolName === "get_docs_file" &&
		receipt.resource.siteId === owner.siteId &&
		receipt.resource.path === owner.path
		? { owner, receipt }
		: null;
}

function mcpHost(mcpUrl: string, appSlug: string): string {
	return `${appSlug}.${new URL(mcpUrl).hostname}`;
}

export async function callDirectReadMcp(input: {
	context: { env: CloudflareEnv };
	organizationId: string;
	appSlug: string;
	actingUserId: string | undefined;
	method: string;
	params: Record<string, unknown>;
}): Promise<unknown> {
	const { MCP_SERVICE, MCP_URL, PLATFORM_SERVICE_TOKEN } = input.context.env;
	if (!MCP_SERVICE || !MCP_URL) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"MCP service is unavailable",
		);
	}
	let result: Record<string, unknown>;
	try {
		result = await requestFirstPartyMcp(
			{
				url: `${MCP_URL}/mcp`,
				fetch: (url, init) => MCP_SERVICE.fetch(url, init),
				clientName: "tedix-home-direct-read",
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": input.organizationId,
					"X-Tedix-Host": mcpHost(MCP_URL, input.appSlug),
					// The MCP edge still resolves scopes and credentials. This marker is
					// audit attribution only; it never expands the caller's scope.
					"X-Tedix-Kernel": "true",
					// The MCP edge grants this one narrow scope only after this route has
					// verified the live tool is declared read-only. It is required solely
					// to resolve the caller's own connected-app credential downstream.
					"X-Tedix-Tedi-Scopes": "connections.execute",
					...(input.actingUserId
						? { "X-Tedix-Acting-User": input.actingUserId }
						: {}),
					...(PLATFORM_SERVICE_TOKEN
						? { Authorization: `Bearer ${PLATFORM_SERVICE_TOKEN}` }
						: {}),
				},
			},
			input.method,
			input.params,
		);
	} catch (error) {
		if (!(error instanceof FirstPartyMcpError)) throw error;
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			error.kind === "http"
				? `MCP ${input.method} failed (${error.status})`
				: "MCP returned an invalid response",
		);
	}
	return result;
}

/**
 * Read an app's full live tool catalog under the shared pagination bounds.
 * Tedix's own MCP edge mints a cursor at 200 entries, so a single `tools/list`
 * page is a partial catalog on every aggregate surface.
 */
export function listLiveTools(input: {
	context: { env: CloudflareEnv };
	organizationId: string;
	appSlug: string;
	actingUserId: string | undefined;
}): Promise<BoundedMcpList<McpTool>> {
	return collectBoundedMcpList<McpTool>(async (cursor) => {
		const listed = (await callDirectReadMcp({
			...input,
			method: "tools/list",
			params: cursor === undefined ? {} : { cursor },
		})) as { tools?: McpTool[]; nextCursor?: unknown } | null;
		return { items: listed?.tools, nextCursor: listed?.nextCursor };
	});
}

function boundedText(value: unknown): string {
	try {
		const text =
			typeof value === "string" ? value : JSON.stringify(value ?? null);
		return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text;
	} catch {
		return "[unserializable tool result]";
	}
}

function boundedStructured(value: unknown): unknown | null {
	if (!value || typeof value !== "object") return null;
	try {
		const text = JSON.stringify(value);
		return text.length <= 12_000 ? JSON.parse(text) : null;
	} catch {
		return null;
	}
}

export function unwrapDirectReadToolResult(
	result: McpToolResult,
	toolName: string,
): unknown {
	if (result.isError === true) {
		throw new Error(boundedText(result.content ?? result));
	}
	return unwrapCallToolResult(result, toolName);
}

export function widgetMetadata(
	result: McpToolResult,
	input: {
		appSlug: string;
		toolName: string;
		arguments: Record<string, unknown>;
	},
) {
	const meta = result._meta;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	const metaRecord = meta as Record<string, unknown>;
	const ui = record(metaRecord.ui);
	const resourceUri =
		typeof ui?.resourceUri === "string"
			? ui.resourceUri
			: metaRecord.resourceUri;
	if (typeof resourceUri !== "string") return {};
	const normalized = unwrapCallToolResult(result, input.toolName);
	return {
		mcpWidget: {
			resourceUri,
			toolInput: input.arguments,
			toolResult:
				normalized &&
				typeof normalized === "object" &&
				!Array.isArray(normalized)
					? normalized
					: { result: normalized },
		},
	};
}

type DirectReadErrorKind =
	| "connection_required"
	| "connection_unavailable"
	| "policy"
	| "timeout"
	| "upstream";

class DirectReadFailure extends Error {
	constructor(
		message: string,
		readonly kind: DirectReadErrorKind,
		readonly retryable: boolean,
		readonly connectProviderId: string | null = null,
	) {
		super(message);
	}
}

function classifiedDirectReadFailure(error: unknown): DirectReadFailure {
	if (error instanceof DirectReadFailure) return error;
	const message = boundedText(errorMessage(error));
	if (/timeout|timed out|deadline/i.test(message)) {
		return new DirectReadFailure(message, "timeout", true);
	}
	if (/forbidden|not declared read-only|permission|scope/i.test(message)) {
		return new DirectReadFailure(message, "policy", false);
	}
	return new DirectReadFailure(message, "upstream", true);
}

function messageFromDirectReadEvent(
	event: {
		organizationId: string;
		conversationId: string;
		runId?: string | null;
		messageId?: string | null;
		payload?: unknown;
		createdAt: string;
	},
	role: "user" | "assistant",
): HomeMessage {
	const payload = record(event.payload) ?? {};
	return {
		id: event.messageId ?? "",
		organizationId: event.organizationId,
		conversationId: event.conversationId,
		...(event.runId ? { runId: event.runId } : {}),
		role,
		status: "completed",
		content: typeof payload.content === "string" ? payload.content : "",
		createdAt: event.createdAt,
		startedAt: event.createdAt,
		completedAt: event.createdAt,
		...(record(payload.metadata)
			? { metadata: record(payload.metadata)! }
			: {}),
	};
}

export const executeReadOnlyToolRoute = authed.executeReadOnlyTool
	.use(AUTHZ.tedisWrite)
	.handler(
		async ({ context, input }): Promise<ExecuteHomeReadOnlyToolOutput> => {
			const organizationId = resolveOrganizationId(
				context,
				input.organizationId,
			);
			const workspaceContext = await resolveWorkspaceContext(
				context.db,
				organizationId,
				input.workspaceContext,
			);
			await ensureHomeConversationAccess(context, {
				conversationId: input.conversationId,
				organizationId,
				required: "edit",
			});
			const createdAt = nowIso();
			const userMessageId = `${input.idempotencyKey}:direct-read:input`;
			const receiptMessageId = `${input.idempotencyKey}:direct-read:receipt`;
			const runtimeMetadata = {
				source: "kernelRuntime.executeReadOnlyTool",
				subject: "operator_direct_read",
				appSlug: input.appSlug,
				toolName: input.toolName,
				...(workspaceContext ? { workspaceContext } : {}),
			};
			const requestInsert = await insertKernelRuntimeEventWithStatus(context, {
				id: homeRuntimeEventId({
					organizationId,
					conversationId: input.conversationId,
					kind: "message.received",
					messageId: userMessageId,
				}),
				organizationId,
				kind: "message.received",
				conversationId: input.conversationId,
				messageId: userMessageId,
				payload: {
					role: "user",
					content: `/read ${input.appSlug}.${input.toolName}`,
					channel: "home",
					metadata: {
						directRead: { appSlug: input.appSlug, toolName: input.toolName },
						...(workspaceContext ? { workspaceContext } : {}),
					},
				},
				runtimeMetadata,
				createdAt,
			});
			const request = requestInsert.event;
			if (!requestInsert.inserted) {
				const receiptEventId = homeRuntimeEventId({
					organizationId,
					conversationId: input.conversationId,
					kind: "message.completed",
					messageId: receiptMessageId,
				});
				const existingReceipt = await getKernelRuntimeEventById(
					context.db,
					receiptEventId,
				);
				if (!existingReceipt && !directReadFenceIsStale(request.createdAt)) {
					throw createError(
						ErrorCodes.CONFLICT,
						"This direct read is already in progress. Reload the conversation before retrying.",
					);
				}
				const recoveredReceipt =
					existingReceipt ??
					(
						await insertKernelRuntimeEventWithStatus(context, {
							id: receiptEventId,
							organizationId,
							kind: "message.completed",
							conversationId: input.conversationId,
							messageId: receiptMessageId,
							payload: {
								role: "assistant",
								content:
									"Read outcome could not be confirmed before the request deadline. The provider was not invoked again.",
								channel: "home",
								metadata: {
									directRead: {
										appSlug: input.appSlug,
										toolName: input.toolName,
									},
									error: true,
									directReadError: {
										kind: "timeout",
										retryable: false,
										connectProviderId: null,
									},
								},
							},
							runtimeMetadata,
							createdAt: nowIso(),
						})
					).event;
				return {
					requestMessage: messageFromDirectReadEvent(request, "user"),
					receiptMessage: messageFromDirectReadEvent(
						recoveredReceipt,
						"assistant",
					),
				};
			}

			let receiptContent: string;
			let receiptMetadata: Record<string, unknown> = {
				directRead: { appSlug: input.appSlug, toolName: input.toolName },
			};
			try {
				const actingUserId = context.descopeUserId ?? context.user?.sub;
				const actor = auditActor(context);
				const [storedSurface] = await getAppsBySlugsWithTools(context.db, [
					{ slug: input.appSlug, toolIds: [input.toolName] },
				]);
				if (
					!storedSurface ||
					storedSurface.app.organizationId !== organizationId
				) {
					throw new DirectReadFailure(
						`App "${input.appSlug}" is unavailable`,
						"policy",
						false,
					);
				}
				const storedTool = storedSurface.tools.find(
					(tool) => tool.toolId === input.toolName,
				);
				if (!storedTool || !storedReadOnly(storedTool.annotations)) {
					throw new DirectReadFailure(
						`Tool "${input.toolName}" is not declared read-only`,
						"policy",
						false,
					);
				}
				const connection = await resolveDirectReadConnectionState({
					context,
					organizationId,
					actingUserId: actingUserId ?? null,
					requirement: directReadConnectionRequirement({
						appMetadata: storedSurface.app.metadata,
						toolConfig: storedTool.config,
					}),
				});
				if (connection.connectionState !== "connected") {
					throw new DirectReadFailure(
						connection.connectionReason ?? "The app connection is unavailable",
						connection.connectionState === "connection_required"
							? "connection_required"
							: "connection_unavailable",
						false,
						connection.connectProviderId,
					);
				}
				const listed = await listLiveTools({
					context,
					organizationId,
					appSlug: input.appSlug,
					actingUserId,
				});
				const tool = listed.items.find(
					(candidate) => candidate.name === input.toolName,
				);
				if (tool?.annotations?.readOnlyHint !== true) {
					// A tool absent from a truncated catalog was never judged: refusing it
					// as "not declared read-only" would blame the provider for our bound.
					// Still fails closed — the read does not run — but as a retryable
					// upstream fault instead of a permanent policy verdict.
					if (!tool && listed.truncated) {
						throw new DirectReadFailure(
							`The live MCP catalog for "${input.appSlug}" exceeded its pagination bound before "${input.toolName}" was verified`,
							"upstream",
							true,
						);
					}
					throw createError(
						ErrorCodes.FORBIDDEN,
						`Tool "${input.toolName}" is not declared read-only`,
					);
				}
				const result = (await callDirectReadMcp({
					context,
					organizationId,
					appSlug: input.appSlug,
					actingUserId,
					method: "tools/call",
					params: { name: input.toolName, arguments: input.arguments },
				})) as McpToolResult;
				const data = unwrapDirectReadToolResult(result, input.toolName);
				const readObservation = ownedHomeReadObservation(result, {
					organizationId,
					conversationId: input.conversationId,
					requestEventId: request.id,
					idempotencyKey: input.idempotencyKey,
					actor: { type: actor.actorType, id: actor.actorId },
					appSlug: input.appSlug,
					toolName: input.toolName,
					siteId: input.arguments.siteId,
					path: input.arguments.path,
				});
				const retainedResult = await retainKernelToolResult({
					db: context.db,
					bucket: context.env.TEDI_R2_BUCKET,
					organizationId,
					conversationId: input.conversationId,
					sourceKind: "direct_read",
					sourceId: input.idempotencyKey,
					value: data,
				});
				const structured = boundedStructured(data);
				receiptContent = structured
					? `${input.appSlug} · ${input.toolName} returned a structured result.`
					: boundedText(data);
				receiptMetadata = {
					...receiptMetadata,
					...(readObservation ? { readObservation } : {}),
					...(retainedResult
						? { directReadResultReference: retainedResult }
						: {}),
					...(structured ? { directReadResult: structured } : {}),
					...widgetMetadata(result, input),
				};
			} catch (error) {
				const failure = classifiedDirectReadFailure(error);
				receiptContent = `Read failed: ${failure.message}`;
				receiptMetadata = {
					...receiptMetadata,
					error: true,
					directReadError: {
						kind: failure.kind,
						retryable: failure.retryable,
						connectProviderId: failure.connectProviderId,
					},
				};
			}

			const receipt = await insertKernelRuntimeEvent(context, {
				id: homeRuntimeEventId({
					organizationId,
					conversationId: input.conversationId,
					kind: "message.completed",
					messageId: receiptMessageId,
				}),
				organizationId,
				kind: "message.completed",
				conversationId: input.conversationId,
				messageId: receiptMessageId,
				payload: {
					role: "assistant",
					content: receiptContent,
					channel: "home",
					metadata: receiptMetadata,
				},
				runtimeMetadata,
				createdAt: offsetIso(createdAt, 1),
			});
			return {
				requestMessage: messageFromDirectReadEvent(request, "user"),
				receiptMessage: {
					id: receiptMessageId,
					organizationId,
					conversationId: input.conversationId,
					role: "assistant",
					status: "completed",
					content: receiptContent,
					createdAt: receipt.createdAt,
					startedAt: receipt.createdAt,
					completedAt: receipt.createdAt,
					metadata: receiptMetadata,
				},
			};
		},
	);
