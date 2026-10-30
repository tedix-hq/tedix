import { isEphemeralSessionKey } from "@tedix/api-contract/utils/runtime-identity";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { matchesTenantPolicyCredential } from "./tenant-policy-credential";
import {
	DOCS_TOOL_SCOPES,
	type DocsToolName,
} from "@tedix/api-contract/contracts/docs-tool-scopes";
import { applyMcpCustomHeaders } from "./handler-external-request";
import {
	readToolConfigExtension,
	readToolConfigString,
} from "./tool-config-extensions";
import { type ToolConfig } from "@tedix/api-contract/schemas/tools";
import { requiredTediMcpToolScope } from "@tedix/mcp-shared/auth/scopes";
import {
	MCP_RESULT_TYPE_INPUT_REQUIRED,
	readInputRequiredResult,
} from "@tedix/mcp-shared/protocol";
import { outboundTraceMeta } from "@tedix/mcp-shared/trace-context";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import {
	READ_OBSERVATION_META_KEY,
	parseDocsFileObservationReceipt,
	type DocsFileObservationReceipt,
} from "@tedix/mcp-shared/read-observation-receipt";
import {
	CALLER_TRUST_HEADER,
	isPlatformTrustedCaller,
	resolveCallerTrustTier,
	stripMemberOnlyInjectFields,
} from "@tedix/mcp-shared/auth/caller-trust";
import { normalizeCallerIdentity } from "./caller-identity";
import { getByPath, redactByPath } from "./handlers/path-utils";
import {
	classifyUpstreamProtocolCaller,
	emitUpstreamProtocolMetric,
} from "./handler-upstream-protocol";
import {
	getTedixManagedTediHost,
	isTedixManagedMcpUrl,
	resolveManagedMcpAuthHeaders,
} from "./managed-mcp-auth";
import { validateUrl } from "@tedix/ssrf-guard";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { applyWorkflowExecutionHeaders } from "./workflow-execution-headers";
import {
	buildCredentialErrorData,
	buildCredentialRecovery,
	fetchConnectionToken,
	getClientCredentialsCacheKey,
	resolveClientCredentialsToken,
	selectedConnectionInstanceId,
} from "./handler-connection-credentials";
import type { ToolExecutionContext, RpcToolResult } from "./handler";
import {
	TEDIX_KERNEL_RUN_META_KEY,
	TEDIX_WORK_ITEM_META_KEY,
	TEDIX_TRACE_BUNDLE_META_KEY,
	metaString,
	buildOperatorConsentHeader,
} from "./handler-request-context";

/** The upstream CallToolResult fields the MCP transport reads. */
type UpstreamCallToolResult = {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
};

async function verifiedDocsReadObservation(input: {
	serviceBinding: unknown;
	docsBinding: unknown;
	toolName: string;
	requestedSiteId: unknown;
	expectedOrganizationSlug: string | undefined;
	result: Record<string, unknown> | undefined;
	data: unknown;
}): Promise<DocsFileObservationReceipt | undefined> {
	if (
		!input.serviceBinding ||
		input.serviceBinding !== input.docsBinding ||
		input.toolName !== "get_docs_file"
	)
		return;
	const receipt = parseDocsFileObservationReceipt(
		input.result?._meta &&
			(input.result._meta as Record<string, unknown>)[
				READ_OBSERVATION_META_KEY
			],
	);
	const data = isRecord(input.data) ? input.data : null;
	if (!receipt || !data || typeof data.content !== "string") return;
	const bytes = new TextEncoder().encode(data.content);
	const digest = [
		...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	if (
		receipt.resource.siteId !== input.requestedSiteId ||
		!input.expectedOrganizationSlug ||
		receipt.resource.organizationSlug !== input.expectedOrganizationSlug ||
		receipt.resource.path !== data.path ||
		receipt.evidence.observedGitRevision !== data.revision ||
		receipt.evidence.contentSha256 !== digest ||
		receipt.evidence.byteLength !== bytes.byteLength ||
		data.contentSha256 !== digest ||
		data.byteLength !== bytes.byteLength
	)
		return;
	return receipt;
}

export function resolveServiceBinding(
	mcpServerUrl: string,
	env: CloudflareEnv,
): Fetcher | null {
	try {
		const host = new URL(mcpServerUrl).hostname;
		if (getTedixManagedTediHost(mcpServerUrl) && env.TEDI_SERVICE) {
			return env.TEDI_SERVICE;
		}
		if (host === "builder.tedix.dev" && env.CMS) {
			return env.CMS;
		}
		if (
			["docs-admin.tedix.dev", "docs-admin.tedix.tech"].includes(host) &&
			env.DOCS
		) {
			return env.DOCS;
		}
	} catch {
		/* invalid URL */
	}
	return null;
}

export async function executeMcpTransport(
	input: Record<string, unknown>,
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
	credentials: { fetchConnectionToken: typeof fetchConnectionToken },
): Promise<RpcToolResult> {
	if (!config.mcpServerUrl || !config.mcpToolName) {
		return {
			data: {
				error: "mcpServerUrl and mcpToolName are required for MCP transport",
			},
			status: 400,
		};
	}
	const mcpToolName = config.mcpToolName;

	const isDev = ctx.env.ENVIRONMENT === "development";
	const timeout = config.timeout ?? 30000;

	// _forwardedQueryParams: inherited from app metadata during materialized
	// tool aggregation. Tenant-scoped apps (e.g. a per-tenant CMS app) append
	// these params to mcpServerUrl so the upstream sees ?org=<tenant> on every
	// request even when the caller's JWT carries a different orgSlug claim.
	let mcpServerUrl = config.mcpServerUrl;
	const forwardedQueryParams = readToolConfigExtension(
		config,
		"_forwardedQueryParams",
	) as Record<string, string> | undefined;
	if (forwardedQueryParams && Object.keys(forwardedQueryParams).length > 0) {
		try {
			const url = new URL(mcpServerUrl);
			for (const [key, value] of Object.entries(forwardedQueryParams)) {
				if (typeof value === "string") {
					url.searchParams.set(key, value);
				}
			}
			mcpServerUrl = url.toString();
		} catch {
			/* invalid base URL — fall through with original */
		}
	}

	// Service binding: use internal Worker-to-Worker RPC for known internal MCP servers
	const serviceBinding = resolveServiceBinding(mcpServerUrl, ctx.env);
	const fetcher: typeof globalThis.fetch = serviceBinding
		? serviceBinding.fetch.bind(serviceBinding)
		: globalThis.fetch.bind(globalThis);
	const managedMcpUrl = isTedixManagedMcpUrl(mcpServerUrl);
	if (
		(ctx.prepareIdentityProbe || ctx.expectedPolicyProbe) &&
		(serviceBinding ||
			config.auth?.type !== "connection" ||
			config.auth.clientCredentials?.tokenUrl ||
			!ctx.env.PLATFORM_SERVICE_TOKEN)
	)
		return {
			status: 403,
			data: { error: "Identity probe unavailable for this connection" },
		};
	if (
		ctx.expectedPolicyCredential &&
		(serviceBinding ||
			config.auth?.type !== "connection" ||
			config.auth.clientCredentials?.tokenUrl)
	)
		return {
			status: 403,
			data: {
				error:
					"Policy credential verification is unavailable for this connection",
			},
		};
	let verifiedPolicyToken: string | undefined;
	let probeCredential:
		| import("@tedix/api-contract/schemas/connections").SelectedConnectionCredential
		| undefined;

	if (!serviceBinding) {
		// SSRF protection — service bindings are trusted Worker-to-Worker RPC
		// and never touch the network. Managed `*.mcp.tedix.dev`-style origins
		// are same-org config, so the internal-host blocklist is relaxed for
		// them (allowInternalHosts), but private-IP/localhost targets and http
		// downgrades stay blocked for these credentialed calls outside dev.
		const urlError = validateUrl(mcpServerUrl, {
			allowHttp: isDev,
			allowInternalHosts: isDev || managedMcpUrl,
		});
		if (urlError) {
			return {
				data: { error: `Invalid MCP server URL: ${urlError}` },
				status: 400,
			};
		}
	}

	// Build params (same paramMap logic as other transports)
	let params: Record<string, unknown> = { ...config.staticParams };
	if (config.paramMap) {
		for (const [inputKey, targetKey] of Object.entries(config.paramMap)) {
			const value = input[inputKey];
			if (value !== undefined) params[targetKey] = value;
		}
	} else {
		Object.assign(params, input);
	}

	// NOTE: Do not call enforceContextParams() here. MCP transport proxies
	// params directly to external MCP servers (Tavily, Firecrawl, etc.) which
	// reject unknown fields like appId/tediId via strict schema validation.
	// Cross-scope security is handled by the auth layer (connection tokens are
	// org-scoped) — the upstream server never sees our internal identifiers.
	const aggregateTediRemoteName = readToolConfigExtension(
		config,
		"_aggregateTediRemoteName",
	);
	if (typeof aggregateTediRemoteName === "string") {
		// Dynamic import for the same reason as index.ts: the
		// aggregate-tedis tree builds ~130 Zod→JSON schemas at module
		// scope and must stay off the Worker startup path.
		const { buildTediCodeInvocation } = await import("./aggregate-tedis");
		params = {
			code: buildTediCodeInvocation(aggregateTediRemoteName, params),
		};
	}

	// Build headers — resolve auth from Descope Token Vault if configured
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const managedTediHost = getTedixManagedTediHost(mcpServerUrl);
	const usesInternalTediServiceBinding = Boolean(
		serviceBinding && managedTediHost,
	);
	if (
		ctx.noFunds &&
		(mcpToolName === "run_tedi_turn" ||
			aggregateTediRemoteName === "run_tedi_turn") &&
		!usesInternalTediServiceBinding
	) {
		return {
			data: {
				error: "Restricted tedi turns require the internal service binding",
			},
			status: 403,
		};
	}
	const usesModernOnlyDocsServiceBinding = Boolean(
		serviceBinding && serviceBinding === ctx.env.DOCS,
	);
	// The tedi runtime trusts service-binding callers for identity, so the
	// gateway decides here whether this caller may reach the target tedi at
	// all and how far it is trusted to steer the turn. Target organization is
	// hydrated from D1 (`_aggregateTediOrgId`), never from caller input.
	const targetTediOrgId = readToolConfigString(config, "_aggregateTediOrgId");
	const callerTrustTier = resolveCallerTrustTier(
		ctx.callerIdentity,
		targetTediOrgId,
	);
	if (
		usesInternalTediServiceBinding &&
		targetTediOrgId &&
		callerTrustTier === "foreign" &&
		!isPlatformTrustedCaller(ctx.callerIdentity)
	) {
		return {
			data: {
				error:
					"This tedi belongs to another organization. Only members of its organization or a platform operator may call it.",
			},
			status: 403,
		};
	}
	if (serviceBinding && managedTediHost) {
		if (ctx.noFunds) headers["X-Tedix-No-Funds"] = "true";
		headers["X-Tedix-Host"] = managedTediHost;
		headers["X-Service-Binding"] = "true";
		headers[CALLER_TRUST_HEADER] = callerTrustTier;
		const aggregateRemoteName = readToolConfigExtension(
			config,
			"_aggregateTediRemoteName",
		);
		const namespacedRemoteName = ctx.toolId.includes("__")
			? ctx.toolId.slice(ctx.toolId.indexOf("__") + 2)
			: ctx.toolId.includes(":")
				? ctx.toolId.slice(ctx.toolId.lastIndexOf(":") + 1)
				: ctx.toolId.includes(".")
					? ctx.toolId.slice(ctx.toolId.lastIndexOf(".") + 1)
					: null;
		const delegatedToolName =
			typeof aggregateRemoteName === "string"
				? aggregateRemoteName
				: namespacedRemoteName
					? namespacedRemoteName
					: typeof config.mcpToolName === "string"
						? config.mcpToolName
						: ctx.toolId;
		headers["X-Tedix-Tedi-Scopes"] =
			requiredTediMcpToolScope(delegatedToolName);
		headers["X-Tedix-Mcp-Delegated-Tool"] = delegatedToolName;
		// Operator-consent attestation. When this tedi
		// dispatch originates from a skill-workflow run that a human operator
		// started (run row createdBy "user:<descopeUserId>", carried on the
		// authenticated skill-runtime -> mcp hop), attach a gateway-attested
		// consent envelope on this internal service-binding hop — as a header
		// and as params._meta below. Tenant workflow code cannot author
		// either: the bridge builds its headers from host-side props, and this
		// block only fires on the trusted binding. The tedi runtime decides
		// what the attestation authorizes; the gateway only vouches for who
		// started the run. Prompt text claiming consent stays worthless.
		const consent = buildOperatorConsentHeader(ctx.callerIdentity);
		if (consent) {
			headers["X-Tedix-Operator-Consent"] = consent;
			console.log(
				`[MCP] operator-consent attached: run=${ctx.callerIdentity?.skillRunId} createdBy=${ctx.callerIdentity?.skillRunCreatedBy} tedi=${managedTediHost}`,
			);
		}
		const aggregateTediOrgId = readToolConfigExtension(
			config,
			"_aggregateTediOrgId",
		);
		const orgId =
			typeof aggregateTediOrgId === "string"
				? aggregateTediOrgId
				: (ctx.app.organizationId ?? ctx.callerIdentity?.organizationId);
		if (orgId) {
			headers["X-Tedix-Org-Id"] = orgId;
		}
	}

	// Forward connection label as a routing hint to upstream MCP servers
	// (independent of auth path). Used by multi-tenant upstreams like
	// builder.tedix.dev/mcp to dispatch to the right org's isolate. Comes
	// either from this tool's _aggregateConnectionLabel (set by
	// aggregateAndPrefixTools when the tool was loaded from a materialized
	// tenant/project app) or from the inbound request's own header.
	const forwardLabel =
		(readToolConfigExtension(config, "_aggregateConnectionLabel") as
			| string
			| undefined) ?? ctx.connectionLabel;
	if (forwardLabel) {
		headers["X-Tedix-Connection-Label"] = forwardLabel;
	}

	// Managed MCP auth is only needed for remote managed MCP endpoints. Tedix
	// tedi MCP calls routed through TEDI_SERVICE are authenticated by the
	// service-binding headers above, so they do not require per-tedi AIH
	// registration or an mcpCredentials lookup.
	if (managedMcpUrl && !usesInternalTediServiceBinding) {
		const aggregateTediId = readToolConfigExtension(config, "_aggregateTediId");
		const aggregateTediOrgId = readToolConfigExtension(
			config,
			"_aggregateTediOrgId",
		);
		Object.assign(
			headers,
			await resolveManagedMcpAuthHeaders({
				serverUrl: mcpServerUrl,
				env: ctx.env,
				tediId:
					typeof aggregateTediId === "string"
						? aggregateTediId
						: (ctx.callerIdentity?.tediId ?? null),
				orgId:
					typeof aggregateTediOrgId === "string"
						? aggregateTediOrgId
						: (ctx.app.organizationId ??
							ctx.callerIdentity?.organizationId ??
							null),
			}),
		);
	} else if (serviceBinding && ctx.env.PLATFORM_SERVICE_TOKEN) {
		headers.Authorization = `Bearer ${ctx.env.PLATFORM_SERVICE_TOKEN}`;
		if (
			serviceBinding === ctx.env.CMS &&
			(ctx.callerIdentity?.scopes?.includes("mcp:content.admin") ||
				(ctx.callerIdentity?.scopes?.includes("mcp:content.write") &&
					ctx.callerIdentity?.scopes?.includes("mcp:settings.admin")))
		) {
			// CMS trusts this edge-resolved capability only on its
			// PLATFORM_SERVICE_TOKEN path, after tenant routing is authorized.
			headers["X-Tedix-Cms-Maintenance-Authorized"] = "true";
		}
		if (serviceBinding === ctx.env.DOCS) {
			const delegatedScope = delegatedDocsScope(config.mcpToolName);
			if (delegatedScope) {
				headers["X-Tedix-Delegated-Scope"] = delegatedScope;
			}
		}
		// Forward the user's original JWT so the upstream service can proxy
		// authenticated calls to third-party services (e.g., CMS User Workers).
		if (
			ctx.bearerToken &&
			(ctx.callerIdentity?.authType === "oauth" ||
				ctx.callerIdentity?.authType === "user" ||
				ctx.callerIdentity?.authType === "external_agent")
		) {
			headers["X-Forwarded-Authorization"] = `Bearer ${ctx.bearerToken}`;
		}
		if (ctx.callerIdentity) {
			const actor = normalizeCallerIdentity(ctx.callerIdentity);
			headers["X-Tedix-Actor-Type"] = actor.actorType;
			headers["X-Tedix-Actor-Id"] = actor.actorId;
			if (
				serviceBinding === ctx.env.CMS &&
				ctx.callerIdentity.authType === "tedi" &&
				ctx.callerIdentity.tediId &&
				actor.actorType === "tedi" &&
				actor.actorId === ctx.callerIdentity.tediId
			) {
				// Carry the edge-resolved capability profile, as on MCP→API.
				// CMS reads these only after verifying PLATFORM_SERVICE_TOKEN.
				headers["X-Tedix-Tedi-Id"] = ctx.callerIdentity.tediId;
				headers["X-Tedix-Tedi-Scopes"] = (ctx.callerIdentity.scopes ?? []).join(
					" ",
				);
			}
			if (actor.externalAgentSessionId) {
				headers["X-Tedix-Agent-Session-Id"] = actor.externalAgentSessionId;
			}
		}
		// First-party services authenticate this hop with the platform token, so a
		// tenant provider credential cannot replace Authorization. Docs may still
		// need the caller tenant's governed Git credential for a private checkout.
		// Resolve it at the gateway and forward it on a dedicated internal header;
		// it never enters MCP arguments, Workflow state, D1, or build metadata.
		if (
			serviceBinding === ctx.env.DOCS &&
			config.auth?.type === "connection" &&
			config.auth.connectionId
		) {
			const effectiveLabel =
				(readToolConfigExtension(config, "_aggregateConnectionLabel") as
					| string
					| undefined) ?? ctx.connectionLabel;
			const credentialResult = await credentials.fetchConnectionToken(
				ctx,
				config.auth.connectionId,
				config.auth.credentialScope ?? config.auth.scope,
				config.auth.scopes,
				effectiveLabel,
				config.auth.credentialPreference,
				params,
			);
			if (!credentialResult.token) {
				return {
					data: buildCredentialErrorData(credentialResult, {
						preference: config.auth.credentialPreference,
						providerId: config.auth.connectionId,
						connectionInstanceId: selectedConnectionInstanceId(ctx),
						scope: config.auth.credentialScope ?? config.auth.scope,
						scopes: config.auth.scopes,
					}),
					status: credentialResult.status === 403 ? 403 : 401,
					connectionRecovery: buildCredentialRecovery(credentialResult, {
						providerId: config.auth.connectionId,
						connectionInstanceId: selectedConnectionInstanceId(ctx),
						scope: config.auth.credentialScope ?? config.auth.scope ?? "tenant",
						scopes: config.auth.scopes,
					}),
				};
			}
			const finalToken =
				config.auth.encoding === "base64"
					? btoa(credentialResult.token)
					: credentialResult.token;
			const template = config.auth.template ?? "Bearer {token}";
			headers["X-Tedix-Provider-Authorization"] = template.replace(
				"{token}",
				finalToken,
			);
		}
	} else if (config.auth) {
		if (config.auth.type === "connection" && config.auth.connectionId) {
			// _aggregateConnectionLabel: set by aggregateAndPrefixTools() for org-wide aggregation.
			const effectiveLabel =
				(readToolConfigExtension(config, "_aggregateConnectionLabel") as
					| string
					| undefined) ?? ctx.connectionLabel;
			const credentialResult = await credentials.fetchConnectionToken(
				ctx,
				config.auth.connectionId,
				config.auth.credentialScope ?? config.auth.scope,
				config.auth.scopes,
				effectiveLabel,
				config.auth.credentialPreference,
				params,
			);
			if (!credentialResult.token) {
				return {
					data: buildCredentialErrorData(credentialResult, {
						preference: config.auth.credentialPreference,
						providerId: config.auth.connectionId,
						connectionInstanceId: selectedConnectionInstanceId(ctx),
						scope: config.auth.credentialScope ?? config.auth.scope,
						scopes: config.auth.scopes,
					}),
					status: credentialResult.status === 403 ? 403 : 401,
					connectionRecovery: buildCredentialRecovery(credentialResult, {
						providerId: config.auth.connectionId,
						connectionInstanceId: selectedConnectionInstanceId(ctx),
						scope: config.auth.credentialScope ?? config.auth.scope ?? "tenant",
						scopes: config.auth.scopes,
					}),
				};
			}

			if (ctx.expectedPolicyCredential) {
				const expected = ctx.expectedPolicyCredential;
				if (
					!matchesTenantPolicyCredential(
						expected,
						credentialResult.selectedCredential,
						expected.accountRevisionDigest ?? "",
					)
				)
					return {
						status: 403,
						data: {
							error: "Selected account no longer matches the reviewed policy",
						},
					};
				verifiedPolicyToken = credentialResult.token;
			}
			if (ctx.prepareIdentityProbe || ctx.expectedPolicyProbe) {
				if (!credentialResult.selectedCredential)
					return {
						status: 403,
						data: { error: "Verified connection identity unavailable" },
					};
				if (
					(ctx.prepareIdentityProbe?.requireTenantCredential ||
						ctx.expectedPolicyProbe?.requireTenantCredential) &&
					(credentialResult.selectedCredential.scope !== "tenant" ||
						credentialResult.selectedCredential.organizationId !==
							ctx.callerIdentity?.organizationId)
				)
					return {
						status: 403,
						data: {
							error:
								"Machine identity proof requires an organization credential",
						},
					};
				probeCredential = credentialResult.selectedCredential;
				if (ctx.expectedPolicyProbe)
					verifiedPolicyToken = credentialResult.token;
			}
			let token = credentialResult.token;

			if (config.auth.clientCredentials?.tokenUrl) {
				const ccCacheKey = getClientCredentialsCacheKey(
					ctx.callerIdentity?.tediId ??
						ctx.callerIdentity?.organizationId ??
						"",
					config.auth.connectionId,
					config.auth.clientCredentials.tokenUrl,
					effectiveLabel,
				);
				const result = await resolveClientCredentialsToken(
					credentialResult.token,
					config.auth.clientCredentials.tokenUrl,
					config.auth.clientCredentials.grantType ?? "client_credentials",
					ccCacheKey,
					isDev,
				);
				if (!result.token) {
					return {
						data: {
							error: result.error ?? "Client credentials exchange failed",
						},
						status: 401,
					};
				}
				token = result.token;
			}

			const headerName = config.auth.header ?? "Authorization";
			const template = config.auth.template ?? "Bearer {token}";
			const finalToken =
				config.auth.encoding === "base64" ? btoa(token) : token;
			headers[headerName] = template.replace("{token}", finalToken);
		} else if (config.auth.type === "header" && config.auth.value) {
			const headerName = config.auth.header ?? "Authorization";
			headers[headerName] = config.auth.value;
		}
	}

	if (serviceBinding && managedTediHost) {
		headers["X-Tedix-Host"] = managedTediHost;
		headers["X-Service-Binding"] = "true";
		const orgId = ctx.app.organizationId ?? ctx.callerIdentity?.organizationId;
		if (orgId) {
			headers["X-Tedix-Org-Id"] = orgId;
		}
	}

	if (ctx.traceId) {
		headers["X-Trace-Id"] = ctx.traceId;
	}
	// W3C/SEP-414 trace propagation: one trace context for this outbound hop,
	// shared by the HTTP headers (HTTP transport) and request `_meta` (SEP-414,
	// for MCP servers that read trace context from `params._meta`).
	const outboundTrace = outboundTraceMeta(ctx.traceId, ctx.tracestate);
	const outboundTraceparent = outboundTrace.traceparent;
	if (outboundTraceparent) {
		headers.traceparent = outboundTraceparent;
	}
	if (outboundTrace.tracestate) {
		headers.tracestate = outboundTrace.tracestate;
	}
	// Tedix-private x-mcp-header: config-declared custom headers (upstream mcp).
	applyMcpCustomHeaders(headers, config, params);
	applyWorkflowExecutionHeaders(headers, ctx.callerIdentity, {
		includeTedixProvenance: Boolean(serviceBinding || managedMcpUrl),
	});

	if (isDev) {
		console.log(
			`[mcp-handler] Proxying to ${mcpServerUrl} tool=${mcpToolName}`,
		);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		if (ctx.prepareIdentityProbe) {
			if (!probeCredential || !ctx.env.PLATFORM_SERVICE_TOKEN)
				return {
					status: 403,
					data: { error: "Verified connection identity unavailable" },
				};
			if (!(await ctx.prepareIdentityProbe.revalidate()))
				return {
					status: 403,
					data: { error: "Reviewed identity profile changed" },
				};
			const { prepareUpstreamIdentityProbe } =
				await import("./upstream-mcp-client");
			const digest = await prepareUpstreamIdentityProbe({
				url: mcpServerUrl,
				fetcher,
				headers,
				modernOnly: false,
				signal: controller.signal,
				timeoutMs: timeout,
				profile: ctx.prepareIdentityProbe.profile,
				binding: JSON.stringify([
					ctx.prepareIdentityProbe.binding,
					probeCredential,
				]),
				secret: ctx.env.PLATFORM_SERVICE_TOKEN,
			});
			return digest
				? {
						status: 200,
						data: {
							accountRevisionDigest: digest,
							credentialSummary: {
								scope: probeCredential.scope,
								...(probeCredential.connectionInstanceId
									? {
											connectionInstanceId:
												probeCredential.connectionInstanceId,
										}
									: {}),
							},
						},
					}
				: {
						status: 403,
						data: { error: "Provider identity could not be verified" },
					};
		}
		// Durable turns acknowledge through the existing inject hook before the
		// gateway deadline. Native Tasks polls top-level calls; nested Code Mode
		// calls receive the stable pending receipt without holding the gateway.
		if (usesInternalTediServiceBinding && mcpToolName === "run_tedi_turn") {
			const injectUrl = new URL(mcpServerUrl);
			injectUrl.pathname = "/hooks/inject";
			injectUrl.search = "";
			const explicitClientRequestId =
				typeof params.client_request_id === "string"
					? params.client_request_id.trim()
					: "";
			const injectResponse = await fetcher(injectUrl.toString(), {
				method: "POST",
				headers,
				body: JSON.stringify({
					...stripMemberOnlyInjectFields(params, callerTrustTier),
					...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
					async: true,
					client_request_id:
						explicitClientRequestId || ctx.executionId || ctx.requestId,
				}),
				signal: controller.signal,
			});
			const bodyText = await injectResponse.text();
			let data: unknown;
			try {
				data = JSON.parse(bodyText);
			} catch {
				return {
					data: {
						error: `Invalid response from tedi inject hook: ${bodyText.slice(0, 500)}`,
					},
					status: injectResponse.ok ? 502 : injectResponse.status,
				};
			}
			if (!injectResponse.ok) {
				return { data, status: injectResponse.status };
			}
			const normalizedData =
				injectResponse.status === 202 &&
				isRecord(data) &&
				data.accepted === true
					? { ...data, ok: true, pending: true, assistant: null }
					: data;
			return {
				data: namespaceAggregateTediTaskLinkage(normalizedData, config),
				status: 200,
			};
		}

		// Detect legacy SSE transport (URL path ends with /sse)
		const isLegacySse = (() => {
			try {
				return new URL(mcpServerUrl).pathname.endsWith("/sse");
			} catch {
				return false;
			}
		})();
		if (isLegacySse) {
			return {
				data: {
					error:
						"Unsupported MCP transport: Tedix requires sessionless MCP 2026-07-28 Streamable HTTP",
				},
				status: 400,
			};
		}

		// The SDK v2 client negotiates the era (2026-07-28 sessionless, else
		// the November 2025 initialize/session flow) and owns the wire;
		// see ./upstream-mcp-client. Loaded on first proxied call so the
		// client stays off the Worker startup path.
		const { callUpstreamMcpTool } = await import("./upstream-mcp-client");
		const connectionAuth = config.auth;
		const connectionId =
			connectionAuth?.type === "connection"
				? connectionAuth.connectionId
				: undefined;
		if (
			ctx.expectedPolicyProbe &&
			(!probeCredential ||
				!verifiedPolicyToken ||
				!ctx.env.PLATFORM_SERVICE_TOKEN)
		)
			return {
				status: 403,
				data: { error: "Verified provider identity unavailable" },
			};
		const providerArgsDigest = ctx.expectedPolicyProbe
			? await sha256Hex(JSON.stringify(params))
			: null;
		const upstream = await callUpstreamMcpTool({
			url: mcpServerUrl,
			fetcher,
			headers,
			toolName: mcpToolName,
			...(ctx.expectedPolicyProbe &&
			probeCredential &&
			ctx.env.PLATFORM_SERVICE_TOKEN
				? {
						identityProbe: {
							profile: ctx.expectedPolicyProbe.profile,
							binding: JSON.stringify([
								ctx.expectedPolicyProbe.binding,
								probeCredential,
							]),
							expectedDigest: ctx.expectedPolicyProbe.expectedDigest,
							secret: ctx.env.PLATFORM_SERVICE_TOKEN,
							revalidate: async () =>
								!!providerArgsDigest &&
								(await sha256Hex(JSON.stringify(params))) ===
									providerArgsDigest &&
								(await ctx.expectedPolicyProbe!.revalidate()),
						},
					}
				: {}),
			reauthorize: connectionId
				? async () => {
						const result = await credentials.fetchConnectionToken(
							ctx,
							connectionId,
							connectionAuth?.credentialScope ?? connectionAuth?.scope,
							connectionAuth?.scopes,
							(readToolConfigExtension(config, "_aggregateConnectionLabel") as
								| string
								| undefined) ?? ctx.connectionLabel,
							connectionAuth?.credentialPreference,
							params,
						);
						if (
							ctx.expectedPolicyCredential &&
							(!matchesTenantPolicyCredential(
								ctx.expectedPolicyCredential,
								result.selectedCredential,
								ctx.expectedPolicyCredential.accountRevisionDigest ?? "",
							) ||
								result.token !== verifiedPolicyToken)
						)
							return {
								status: 403,
								error:
									"Reviewed account or credential changed; the call was not replayed",
							};
						if (
							ctx.expectedPolicyProbe &&
							(result.token !== verifiedPolicyToken ||
								JSON.stringify(result.selectedCredential) !==
									JSON.stringify(probeCredential) ||
								!(await ctx.expectedPolicyProbe.revalidate()))
						)
							return {
								status: 403,
								error:
									"Reviewed identity or policy changed; the call was not replayed",
							};
						return result.token
							? undefined
							: {
									status: result.status ?? 403,
									error:
										"Connection access changed while awaiting provider input; the call was not replayed",
								};
					}
				: undefined,
			args: params,
			toolInputSchema: ctx.toolInputSchema,
			readOnly: ctx.readOnlyHint === true,
			modernMeta: {
				...(outboundTraceparent ? outboundTrace : {}),
				...(managedTediHost
					? Object.fromEntries(
							[
								TEDIX_KERNEL_RUN_META_KEY,
								TEDIX_WORK_ITEM_META_KEY,
								TEDIX_TRACE_BUNDLE_META_KEY,
							].flatMap((key) => {
								const value = metaString(ctx.requestMeta, key);
								return value ? [[key, value.slice(0, 512)]] : [];
							}),
						)
					: {}),
			},
			legacyMeta: outboundTraceparent ? outboundTrace : undefined,
			// TEDI_SERVICE is a first-party binding to the one certified tedi
			// runtime, whose MCP edge is always deployed with the current modern
			// protocol. Docs is likewise a first-party modern-only MCP service:
			// its entrypoint rejects initialize before auth dispatch.
			modernOnly:
				usesInternalTediServiceBinding || usesModernOnlyDocsServiceBinding,
			signal: controller.signal,
			timeoutMs: timeout,
		});
		if (!upstream.ok) {
			return {
				data: {
					error: upstream.error,
					...(upstream.providerStatus !== undefined
						? { providerStatus: upstream.providerStatus }
						: {}),
					...(upstream.providerCode
						? { providerCode: upstream.providerCode }
						: {}),
					...(upstream.retrySafe !== undefined
						? { retrySafe: upstream.retrySafe }
						: {}),
				},
				status: upstream.status,
			};
		}
		const upstreamProtocol = upstream.era;
		const rpcResult = { result: upstream.result as UpstreamCallToolResult };

		// This is compatibility-removal evidence, so record only calls whose
		// transport and JSON-RPC layers both succeeded. Negotiation probes and
		// upstream tool errors must not look like active successful consumers.
		const sourceAppSlug = readToolConfigExtension(ctx.config, "_sourceAppSlug");
		emitUpstreamProtocolMetric(ctx.env, {
			protocolEra: upstreamProtocol,
			appSlug: typeof sourceAppSlug === "string" ? sourceAppSlug : ctx.app.slug,
			toolName: mcpToolName,
			boundary:
				usesInternalTediServiceBinding || managedMcpUrl
					? "first_party"
					: "external",
			callerClass: classifyUpstreamProtocolCaller(ctx.callerIdentity),
		});

		// An input_required result the edge could not fulfil agent-in-the-loop
		// (e.g. a sampling request that needs a model, or a booleans-only
		// confirm the filler fails closed on) surfaces as 428 so a capable
		// caller can still resolve it. Nothing executed upstream.
		const inputRequired = readInputRequiredResult(rpcResult.result);
		if (inputRequired) {
			return {
				data: {
					error: `Upstream tool "${mcpToolName}" requires caller-provided input before it will execute (resultType "input_required"); the call was NOT executed. Retry echoing inputResponses + requestState to resolve it.`,
					resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
					...(inputRequired.inputRequests
						? { inputRequests: inputRequired.inputRequests }
						: {}),
					...(inputRequired.requestState
						? { requestState: inputRequired.requestState }
						: {}),
				},
				status: 428,
			};
		}
		// Transform MCP content array to our result format
		const content = Array.isArray(rpcResult.result?.content)
			? rpcResult.result.content
			: [];
		const textParts = content
			.filter((c) => c.type === "text")
			.map((c) => c.text);
		const textContent = textParts.join("\n");

		if (rpcResult.result?.isError) {
			return {
				data: { error: textContent || "Remote MCP tool returned an error" },
				status: 500,
			};
		}

		// Normalize the upstream CallToolResult through the shared host/client
		// boundary. Preserve the proxy's explanatory-text envelope for plain
		// prose while allowing canonical JSON spread across text blocks.
		const resultRecord = rpcResult.result as
			| Record<string, unknown>
			| undefined;
		const hasStructuredContent = resultRecord?.structuredContent != null;
		const normalizedResult = unwrapCallToolResult(
			rpcResult.result,
			mcpToolName,
		);

		let data: unknown;
		if (hasStructuredContent) {
			// Upstream structuredContent is the schema-validated tool payload.
			// Keep explanatory text in MCP content, not mixed into the JSON object.
			data = normalizedResult;
		} else if (
			textParts.length > 0 &&
			content.every((part) => part.type === "text") &&
			typeof normalizedResult !== "string"
		) {
			data = normalizedResult;
		} else {
			data = { content, text: textContent };
		}

		// Extract via responsePath if configured
		if (config.responsePath && data != null && typeof data === "object") {
			data = getByPath(data, config.responsePath) ?? data;
		}

		// Optional response-side redaction. config.responseRedact is a list of
		// dotted/bracketed paths into the response object whose string values
		// are replaced with "<redacted>". Supports `[*]` wildcard for arrays.
		// Used to scrub credential leaks from upstream MCP responses (e.g.
		// firecrawl_browser_list returning tokenized session URLs even for
		// destroyed sessions).
		const redactPaths = readToolConfigExtension(config, "responseRedact");
		if (
			Array.isArray(redactPaths) &&
			data != null &&
			typeof data === "object"
		) {
			for (const path of redactPaths) {
				if (typeof path === "string") {
					redactByPath(data as Record<string, unknown>, path);
				}
			}
		}

		// Aggregate tedi tools (e.g. `cto.run_tedi_turn`) emit a tedi-run task
		// linkage (`task: { id: runId, pollWith: "tasks/get" }`). A bare tedi-run
		// id is indistinguishable from a kernel run at the aggregate, so namespace
		// it with the owning tedi (`tedi:<tediId>:<runId>`) — the aggregate's
		// tasks/get then routes it to the per-tedi run projection.
		data = namespaceAggregateTediTaskLinkage(data, config);

		const meta = (rpcResult.result as Record<string, unknown> | undefined)
			?._meta as Record<string, unknown> | undefined;
		const usage = meta?.usage as { totalTokens?: number } | undefined;
		const readObservation = await verifiedDocsReadObservation({
			serviceBinding,
			docsBinding: ctx.env.DOCS,
			toolName: mcpToolName,
			requestedSiteId: params.siteId,
			// Match Docs auth routing: header first, then the server-configured
			// URL tenant. The enclosing app may be an aggregate; the exact docs
			// binding (not an app alias) attests the provider identity.
			expectedOrganizationSlug:
				forwardLabel ??
				new URL(mcpServerUrl).searchParams.get("org") ??
				undefined,
			result: resultRecord,
			data,
		});
		return {
			data,
			status: 200,
			tokensUsed: usage?.totalTokens,
			...(readObservation ? { readObservation } : {}),
		};
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			return {
				data: { error: `Upstream MCP server timed out after ${timeout}ms` },
				status: 408,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		return { data: { error: `MCP proxy failed: ${message}` }, status: 502 };
	} finally {
		clearTimeout(timer);
	}
}

function namespaceAggregateTediTaskLinkage(
	data: unknown,
	config: ToolConfig,
): unknown {
	const aggregateTediId = readToolConfigExtension(config, "_aggregateTediId");
	if (
		typeof aggregateTediId !== "string" ||
		!aggregateTediId ||
		!isRecord(data)
	) {
		return data;
	}

	if (
		typeof data.session_key === "string" &&
		isEphemeralSessionKey(data.session_key)
	)
		return data;
	const task = data.task;
	if (
		isRecord(task) &&
		typeof task.id === "string" &&
		!task.id.startsWith("tedi:")
	) {
		return {
			...data,
			task: { ...task, id: `tedi:${aggregateTediId}:${task.id}` },
		};
	}
	if (
		!task &&
		data.pending === true &&
		typeof data.run_id === "string" &&
		data.run_id
	) {
		return {
			...data,
			task: {
				id: `tedi:${aggregateTediId}:${data.run_id}`,
				pollWith: "tasks/get",
			},
		};
	}
	return data;
}

function delegatedDocsScope(toolName: string): string | undefined {
	return DOCS_TOOL_SCOPES[toolName as DocsToolName];
}
