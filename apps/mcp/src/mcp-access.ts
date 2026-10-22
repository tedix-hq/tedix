import { isDelegatedWorkTool } from "@tedix/auth/delegated-mcp-token";
import { hasScope, toolToScope } from "@tedix/mcp-shared/auth/scopes";
import { isMemberConsentScope } from "@tedix/mcp-shared/auth/consent-scopes";
import { protectedResourceScopes } from "./well-known";
import { collectAdvertisedScopes } from "@tedix/api-contract/utils/mcp-scope-catalog";
import {
	buildWwwAuthenticate,
	extractRequiredScopes,
	shouldEnforceMcpToolScopes,
	shouldEnforceTenantMatchForOAuth,
	type MultiOrgMcpSelection,
} from "./auth-helpers";
import { jwtTenantMatchesApp } from "./lib/tenant-match";
import { contentFreeMcpException, createMcpLogger } from "./log";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import { type McpAccessDenialReason } from "./mcp/security-decision";
import type { ResolvedApp } from "./resolution";
import { readJsonRpcBody } from "./json-rpc-envelope";

/**
 * Request-level MCP access gate (`enforceMcpAccess`): origin, authentication,
 * tenant match and the edge tool-scope check that runs before dispatch. See
 * apps/mcp/AGENTS.md for which gate owns a tool.
 */

const log = createMcpLogger("mcp.router");

// =============================================================================
// policy-based scope extraction
// =============================================================================

/**
 * Extract required scopes for a single tools/call request using Descope policy
 * mode. The required scope is derived from the tool name with the mcp:<tool.name>
 * convention; JSON-RPC batches are rejected by the transport before dispatch.
 */
async function extractPolicyRequiredScopes(
	request: Request,
	mcpConfig?: Record<string, unknown>,
): Promise<string[] | undefined> {
	const toolName = await extractMcpToolCallName(request);
	if (toolName) {
		if (toolName === "code" && mcpConfig?.codeMode === true) {
			// Code Mode authorizes each inner provider call with concrete
			// tool scopes. Requiring an outer mcp:code scope would make Descope
			// policies grant a synthetic scope that has no runtime meaning.
			return undefined;
		}
		return [toolToScope(toolName)];
	}

	return undefined;
}

export async function extractMcpToolCallName(
	request: Request,
): Promise<string | undefined> {
	const contentType = request.headers.get("Content-Type") ?? "";
	if (request.method !== "POST" || !contentType.includes("application/json")) {
		return undefined;
	}

	try {
		const body = (await readJsonRpcBody(request)) as {
			method?: string;
			params?: { name?: string };
		} | null;
		return body?.method === "tools/call" ? body.params?.name : undefined;
	} catch {
		return undefined;
	}
}
export async function enforceMcpAccess(params: {
	request: Request;
	hostname: string;
	resolvedApp: ResolvedApp;
	env: CloudflareEnv;
	oauthJwtPayload: unknown;
	/** Only populated by the per-request live multi-org grant verifier. */
	multiOrgSelection?: MultiOrgMcpSelection | null;
	isDev: boolean;
}): Promise<{ response: Response; reason: McpAccessDenialReason } | null> {
	const {
		request,
		hostname,
		resolvedApp,
		env,
		oauthJwtPayload,
		multiOrgSelection,
		isDev,
	} = params;
	const { app, metadata, tools } = resolvedApp;
	if (request.headers.get("x-tedix-auth-credential-mode") === "delegated-mcp") {
		const requested = await extractMcpToolCallName(request);
		if (requested && requested !== "code") {
			const tool = tools.find((candidate) => candidate.toolId === requested);
			const namespace = tool
				? resolveMcpToolNamespace(
						tool,
						metadata?.mcpConfig?.codeModeNamespaces as
							| Record<string, string>
							| undefined,
					)
				: (requested.split("__")[0] ?? "");
			if (
				isDelegatedWorkTool(
					requested,
					namespace,
					tool?.config,
					tool?.toolTypeId,
				)
			) {
				return {
					response: new Response(
						JSON.stringify({ error: "delegated_work_tool_denied" }),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
					reason: "insufficient_scope",
				};
			}
		}
	}
	const mcpAuthMode = metadata?.mcpConfig?.authMode ?? "authenticated";

	if (
		(mcpAuthMode === "authenticated" || mcpAuthMode === "proxy-target") &&
		!request.headers.get("x-tedix-auth-type")
	) {
		const advertisedScopes = collectAdvertisedScopes({
			mcpConfig: metadata?.mcpConfig,
			tools: tools.map((tool) => ({
				name: tool.toolId,
				description: tool.description ?? undefined,
			})),
		});
		// Point at the metadata wherever well-known.ts serves it: explicit
		// protected-resource metadata (the Connect gateway) or advertised scopes.
		const hasOAuth =
			advertisedScopes.length > 0 ||
			Boolean(metadata?.mcpConfig?.protectedResourceMetadata);
		// MCP hosts request the challenge scope, else every advertised scope
		// (platform:admin included). Start explicit metadata at the member grant;
		// administration arrives through an insufficient_scope step-up.
		const protectedResource = metadata?.mcpConfig?.protectedResourceMetadata;
		const wwwAuth = hasOAuth
			? buildWwwAuthenticate(
					hostname,
					undefined,
					undefined,
					protectedResource
						? protectedResourceScopes(protectedResource).filter(
								isMemberConsentScope,
							)
						: undefined,
				)
			: 'Bearer realm="MCP"';

		return {
			response: new Response(
				JSON.stringify({
					error: "Authentication required",
					message:
						"This MCP server requires authentication. Provide a Bearer token in the Authorization header.",
				}),
				{
					status: 401,
					headers: {
						"Content-Type": "application/json",
						"WWW-Authenticate": wwwAuth,
					},
				},
			),
			reason: "authentication_required",
		};
	}

	if (
		request.headers.get("x-tedix-auth-credential-mode") === "direct-tedi-jwt" &&
		app.organizationId
	) {
		return {
			response: new Response(
				JSON.stringify({
					error: "direct_tedi_jwt_not_allowed",
					message:
						"Tedi access-key JWTs do not directly authorize app MCP servers. Resolve assigned app credentials through the identity provider.",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			),
			reason: "direct_tedi_jwt_not_allowed",
		};
	}

	if (app.organizationId) {
		const payload =
			typeof oauthJwtPayload === "object" && oauthJwtPayload !== null
				? (oauthJwtPayload as { entityType?: unknown })
				: null;
		// Connect authority comes from the verified selected organizations, not
		// the browser session's active tenant. Ordinary app grants retain dct matching.
		const verifiedConnectSelection =
			hostname === "connect.mcp.tedix.dev" &&
			app.slug === "connect" &&
			metadata?.mcpConfig?.multiOrgConsent === true &&
			(multiOrgSelection?.organizations.length ?? 0) > 0;
		const verifiedConnectTarget =
			hostname === "connect.mcp.tedix.dev" &&
			multiOrgSelection?.organizations.some(
				(organization) =>
					organization.organizationId === app.organizationId &&
					organization.gatewaySlug === app.slug,
			) === true;
		if (
			!verifiedConnectSelection &&
			!verifiedConnectTarget &&
			shouldEnforceTenantMatchForOAuth(request.headers, payload)
		) {
			let match: { ok: true } | { ok: false; reason: string };
			try {
				match = await jwtTenantMatchesApp(
					oauthJwtPayload as Parameters<typeof jwtTenantMatchesApp>[0],
					app.organizationId,
					env,
				);
			} catch (error) {
				log.error("Tenant match check failed; denying request", {
					event: "router.tenant_match_failed",
					appId: app.id,
					appSlug: app.slug,
					organizationId: app.organizationId,
					outcome: "denied",
					error: contentFreeMcpException(error),
				});
				match = { ok: false, reason: "tenant_match_check_failed" };
			}
			if (!match.ok) {
				console.warn(
					`[MCP TenantMatch] reject — app=${app.slug} org=${app.organizationId} reason=${match.reason}`,
				);
				return {
					response: new Response(
						JSON.stringify({
							error: "tenant_mismatch",
							message:
								"Your token was issued for a different tenant. Switch to the correct organization in Tedix OS before connecting this MCP server.",
							detail: match.reason,
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
					reason:
						match.reason === "tenant_match_check_failed"
							? "tenant_match_check_failed"
							: "tenant_mismatch",
				};
			}
		}
	}
	const mcpConfig = metadata?.mcpConfig as Record<string, unknown> | undefined;
	const enforcePolicies = mcpConfig?.enforcePolicies === true;
	const toolScopes = mcpConfig?.toolScopes as
		| Record<string, string[]>
		| undefined;
	if (
		toolScopes ||
		enforcePolicies ||
		tools.some((tool) => tool.authRequired)
	) {
		const requiredScopes = enforcePolicies
			? await extractPolicyRequiredScopes(request, mcpConfig)
			: await extractRequiredScopes(request, toolScopes, tools, mcpConfig);
		if (requiredScopes && requiredScopes.length > 0) {
			const authType = request.headers.get("x-tedix-auth-type");
			if (!authType) {
				if (mcpAuthMode === "hybrid") {
					// SEP-2350: the RFC 6750 `scope` parameter is what lets a client
					// compute the union of its existing grant and the newly required
					// scopes and re-authorize. Carrying the list only in the human
					// `error_description` leaves the challenge machine-unreadable.
					const wwwAuthValue = buildWwwAuthenticate(
						hostname,
						"insufficient_scope",
						`Authentication required. Scopes needed: ${requiredScopes.join(" ")}`,
						requiredScopes,
					);
					let rpcId: string | number | null = null;
					try {
						const body = (await request.clone().json()) as {
							id?: string | number;
						};
						rpcId = body?.id ?? null;
					} catch {
						/* not JSON-RPC */
					}

					return {
						response: new Response(
							JSON.stringify({
								jsonrpc: "2.0",
								id: rpcId,
								result: {
									content: [
										{
											type: "text",
											text: `Authentication required: you need to log in to use this tool. Required scopes: ${requiredScopes.join(", ")}`,
										},
									],
									_meta: {
										"mcp/www_authenticate": [wwwAuthValue],
									},
									isError: true,
								},
							}),
							{
								status: 200,
								headers: {
									"Content-Type": "application/json",
									"WWW-Authenticate": wwwAuthValue,
								},
							},
						),
						reason: "authentication_required",
					};
				}
				return {
					response: new Response(
						JSON.stringify({
							error: "authentication_required",
							required_scopes: requiredScopes,
							message: "This tool requires authentication.",
						}),
						{
							status: 401,
							headers: {
								"Content-Type": "application/json",
								// SEP-2350: advertise the scopes this call needs so the
								// client can request them on first authorization instead of
								// discovering the gap one denial at a time.
								"WWW-Authenticate": buildWwwAuthenticate(
									hostname,
									undefined,
									undefined,
									requiredScopes,
								),
							},
						},
					),
					reason: "authentication_required",
				};
			}
			if (shouldEnforceMcpToolScopes(authType)) {
				const tokenScopes = (request.headers.get("x-tedix-auth-scopes") ?? "")
					.split(" ")
					.filter(Boolean);
				const missingScopes = requiredScopes.filter(
					(scope) => !hasScope(tokenScopes, scope),
				);
				if (missingScopes.length > 0) {
					return {
						response: new Response(
							JSON.stringify({
								error: "insufficient_scope",
								required_scopes: requiredScopes,
								missing_scopes: missingScopes,
							}),
							{
								status: 403,
								headers: {
									"Content-Type": "application/json",
									"WWW-Authenticate": buildWwwAuthenticate(
										hostname,
										"insufficient_scope",
										`Missing scopes: ${missingScopes.join(" ")}`,
										missingScopes,
									),
								},
							},
						),
						reason: "insufficient_scope",
					};
				}
			} else if (authType === "service" && isDev) {
				console.log(
					`[MCP Auth] Service binding accessing scope-restricted tool (scopes: ${requiredScopes.join(", ")})`,
				);
			}
		}
	}

	return null;
}
