import { checkUserTenantMembership } from "@tedix/auth/descope";
import { validateToken } from "@tedix/auth/jwt";
import { isPlatformPrincipal, type JWTPayload } from "@tedix/auth/types";
import {
	enforceModernMcpProtocol,
	mountMcp,
	validateModernProtocolHeaders,
} from "@tedix/mcp-shared/transport";
import { resolveInboundTraceId } from "@tedix/mcp-shared/trace-context";
import {
	deprovisionCms,
	listTenantBundleVersions,
} from "@tedix/provisioning/cms";
import {
	MCP_CORS_EXPOSE_HEADERS,
	MCP_CORS_HEADERS,
	MCP_CORS_METHODS,
	resolveCorsOrigin,
} from "@tedix/worker-kit/cors";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import {
	extractBearerToken,
	secureEqual,
} from "@tedix/worker-kit/request-auth";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { callSandboxFreeCmsProxyTool } from "./agent/cms-proxy";
import {
	cmsAuditActor,
	isCmsHumanOAuthSubject,
	requiresCmsHumanAuth,
	resolveCmsHumanAuthorization,
	type CmsHumanAuthResolution,
} from "./agent/cms-human-auth";
import {
	type CmsProxyContext,
	SANDBOX_FREE_CMS_PROXY_TOOLS,
} from "./agent/cms-proxy-runtime";
import {
	type DeployConfig,
	type DeployContext,
	listVersions,
	rollback,
} from "./agent/deploy";
import {
	type DeployStatusSnapshot,
	deployStatusKey,
} from "./agent/deploy-workflow";
import { startCmsDeployWorkflow } from "./agent/deploy-admission";
import { hasExactCmsDeprovisionAuthority } from "./agent/cms-restore-permit";
import {
	safeDeployDetails,
	safeDeployMessage,
} from "./agent/deploy-status-safety";
import {
	type ImageGenerationStatusSnapshot,
	imageGenerationStatusKey,
} from "./agent/image-generation-workflow";
import { normalizeCmsTemplateSlug } from "./template-policy";
import {
	getCmsTemplateSelection,
	getCmsHumanSiteAuthority,
} from "./agent/storage";
import {
	THEME_ARTIFACTS_NAMESPACE,
	themeArtifactRepoName,
	themeArtifactRemote,
} from "./agent/hot-theme";
import { recordCmsMcpAuditEvent } from "./agent/mcp-audit";
// Type-only static import: `buildSiteBuilderMcpServer` is loaded dynamically at its
// single call site below. `./agent/tools` pulls `template-snapshot.ts`, a large
// frozen table of embedded template files, and evaluating it on the Worker entry
// path spends startup CPU against Cloudflare's 1s validation budget before any
// request is served.
import type { DeployStatus, SiteBuilderToolContext } from "./agent/tools";
import { buildCmsMcpDiscovery } from "./mcp-discovery";
import { getSiteBuilderSandbox } from "./sandbox";
import { loadServiceKey } from "./service-key-storage";
import type { AppBindings, AppEnv } from "./types";

export { DeployWorkflow } from "./agent/deploy-workflow";
export { ImageGenerationWorkflow } from "./agent/image-generation-workflow";
export { SiteBuilderSandboxRuntime } from "./container/site-builder-sandbox";
export { DirectoryBackupGateway } from "@cloudflare/sandbox";

const SITE_BUILDER_HOSTNAME = "builder.tedix.dev";

const app = new Hono<AppEnv>();

installHonoErrorHandlers(app, { service: "cms" });

app.use(
	"*",
	cors({
		origin: (origin) => {
			if (!origin) return origin;
			return resolveCorsOrigin(origin, {
				allowLocalhost: true,
				httpsSubdomainSuffixes: ["tedix.dev", "tedix.tech"],
			});
		},
		allowMethods: [...MCP_CORS_METHODS],
		allowHeaders: [...MCP_CORS_HEADERS],
		exposeHeaders: [...MCP_CORS_EXPOSE_HEADERS],
		credentials: true,
	}),
);

// authz: public — unauthenticated liveness probe; returns no tenant data.
app.get("/health", (c) =>
	c.json({ status: "ok", service: "cms", deployedSha: c.env.GIT_SHA }),
);

// =============================================================================
// MCP Streamable HTTP — POST/GET/DELETE /mcp
// =============================================================================

/**
 * 5-min in-memory cache of (descopeUserId, tenantId) → bool. Per-isolate
 * so it warms quickly under load without needing external state. Tenant
 * memberships rarely change; staleness for ≤5min is acceptable.
 */
const TENANT_MEMBERSHIP_CACHE = new Map<
	string,
	{ result: boolean; expiresAt: number }
>();
const TENANT_MEMBERSHIP_TTL_MS = 5 * 60 * 1000;
const TENANT_MEMBERSHIP_CACHE_MAX = 1000;

type AuthenticatedRequest = {
	authenticated: true;
	authType: "user" | "service-token";
	orgSlug?: string;
	forwardedAuth?: string;
	user?: JWTPayload;
	platformAdmin: boolean;
	cmsMaintenance: boolean;
};

type AuthenticationResult =
	| AuthenticatedRequest
	| { authenticated: false; error?: string; status?: 401 | 403 };

function sanitizeOrgSlug(candidate: string | undefined): string | undefined {
	if (!candidate) return undefined;
	if (/^\{\{.*\}\}$/.test(candidate)) return undefined;
	return candidate;
}

function getRequestedOrgSlug(request: Request): string | undefined {
	const url = new URL(request.url);
	const headerLabel =
		request.headers.get("X-Tedix-Connection-Label") ?? undefined;
	const queryOrg = url.searchParams.get("org") ?? undefined;
	return sanitizeOrgSlug(headerLabel ?? queryOrg);
}

function isJwtLike(token: string | undefined): token is string {
	if (!token) return false;
	const parts = token.split(".");
	return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

function getDescopeUserId(payload: JWTPayload): string | undefined {
	return typeof payload.descopeUserId === "string"
		? payload.descopeUserId
		: payload.sub;
}

function getJwtScopes(payload: JWTPayload): string[] {
	const raw = payload.scope ?? payload.scopes ?? payload.scp;
	if (typeof raw === "string") return raw.split(/\s+/).filter(Boolean);
	if (Array.isArray(raw))
		return raw.filter((item): item is string => typeof item === "string");
	return [];
}

function isPlatformJwtPrincipal(payload: JWTPayload): boolean {
	const scopes = getJwtScopes(payload);
	return isPlatformPrincipal({
		user: payload,
		apiKey: { scopes },
		serviceAccount: { scope: scopes.join(" ") },
	});
}

function getForwardedHumanJwt(auth: AuthenticatedRequest): string | undefined {
	if (!isJwtLike(auth.forwardedAuth)) return undefined;
	if (!isCmsHumanOAuthSubject(auth.user)) return undefined;
	return auth.forwardedAuth;
}

async function isUserMemberOfTenant(
	env: AppEnv["Bindings"],
	descopeUserId: string,
	tenantId: string,
): Promise<boolean> {
	const cacheKey = `${descopeUserId}:${tenantId}`;
	const now = Date.now();
	const cached = TENANT_MEMBERSHIP_CACHE.get(cacheKey);
	if (cached && cached.expiresAt > now) return cached.result;

	// `null` means membership couldn't be determined (missing key / API
	// failure) — fail closed and don't cache, so the next request retries.
	const result = await checkUserTenantMembership(env, descopeUserId, tenantId);
	if (result === null) return false;

	// Bound the cache; drop oldest on overflow.
	if (TENANT_MEMBERSHIP_CACHE.size >= TENANT_MEMBERSHIP_CACHE_MAX) {
		const firstKey = TENANT_MEMBERSHIP_CACHE.keys().next().value;
		if (firstKey !== undefined) TENANT_MEMBERSHIP_CACHE.delete(firstKey);
	}
	TENANT_MEMBERSHIP_CACHE.set(cacheKey, {
		result,
		expiresAt: now + TENANT_MEMBERSHIP_TTL_MS,
	});
	return result;
}

async function isPayloadAuthorizedForOrg(
	payload: JWTPayload,
	orgSlug: string,
	env: AppEnv["Bindings"],
): Promise<boolean> {
	if (isPlatformJwtPrincipal(payload)) return true;

	const expectedTenantId = `org_${orgSlug}`;
	const descopeUserId = getDescopeUserId(payload);
	if (!descopeUserId) return false;
	return isUserMemberOfTenant(env, descopeUserId, expectedTenantId);
}

/**
 * Resolve the target org slug for this request and authorize the caller for it.
 *
 * Routing precedence: X-Tedix-Connection-Label header → ?org= query param.
 * The label is just a routing hint — authorization is enforced at runtime
 * against the caller's Descope tenant memberships, which scales to N
 * tenants without any per-tenant Descope Console configuration.
 *
 * Authorization order (first match wins):
 *   1. Platform principal — shared @tedix/auth platform-admin semantics.
 *   2. JWT `tenants` claim lists org_<slug> — standard Descope user
 *      and access-key tokens (dashboard sessions, tedi M2M JWTs).
 *   3. Server-side Descope user-load lookup — for AIH user JWTs
 *      (OAuth consent flow) which don't carry the `tenants` claim.
 *      5min in-memory cache, bounded at 1000 entries. Fails closed.
 *
 * This deliberately does not use per-tenant cms:<slug> scopes. Such
 * scopes would require a manual AIH policy in the Descope Console
 * for every onboarded customer — the policy registry isn't API-
 * manageable, so per-tenant scopes don't scale. Runtime tenant
 * authorization scales to N customers with zero Console clicks.
 *
 * Defensive: reject unresolved Descope template placeholders ({{…}})
 * on either path.
 */
async function resolveAuthorizedOrg(
	request: Request,
	payload: JWTPayload,
	env: AppEnv["Bindings"],
): Promise<{ orgSlug?: string; error?: string }> {
	const candidate = getRequestedOrgSlug(request);
	if (!candidate) return {};
	if (await isPayloadAuthorizedForOrg(payload, candidate, env)) {
		return { orgSlug: candidate };
	}
	return { error: `Organization access denied for org "${candidate}"` };
}

async function validateForwardedUser(
	forwardedAuth: string | undefined,
	env: AppEnv["Bindings"],
): Promise<JWTPayload | undefined> {
	if (!isJwtLike(forwardedAuth)) return undefined;
	try {
		return await validateToken(forwardedAuth, {
			projectId: env.DESCOPE_PROJECT_ID,
			baseUrl: env.DESCOPE_BASE_URL,
			allowTediJwt: true,
		});
	} catch {
		return undefined;
	}
}

async function isAuthAuthorizedForOrg(
	auth: AuthenticatedRequest,
	orgSlug: string,
	env: AppEnv["Bindings"],
): Promise<boolean> {
	if (auth.platformAdmin) return true;
	if (auth.authType === "service-token" && auth.orgSlug === orgSlug)
		return true;
	if (!auth.user) return false;
	return isPayloadAuthorizedForOrg(auth.user, orgSlug, env);
}

export async function authenticateRequest(
	request: Request,
	env: AppEnv["Bindings"],
): Promise<AuthenticationResult> {
	const token = extractBearerToken(request.headers.get("Authorization"));

	// Internal service binding auth — MCP Worker passes platform token
	if (
		token &&
		env.PLATFORM_SERVICE_TOKEN &&
		(await secureEqual(token, env.PLATFORM_SERVICE_TOKEN))
	) {
		// Trust the connection label directly. PLATFORM_SERVICE_TOKEN proves this is
		// an internal call from apps/mcp, which already authenticated the user and
		// resolved routing. The forwarded JWT is passed through for downstream use
		// (e.g. proxying to CMS user workers) but must not gate org routing — the
		// calling user's JWT may not carry all tenant memberships (e.g. an owner's JWT
		// has org_tedix but not every other org when managing multiple orgs via tedix-unified).
		const forwardedAuth =
			request.headers
				.get("X-Forwarded-Authorization")
				?.replace(/^Bearer\s+/i, "") ?? undefined;
		const forwardedUser = await validateForwardedUser(forwardedAuth, env);
		// The MCP edge resolves tedi scopes from its current capability profile.
		// Honor that delegation only on the authenticated service-token path,
		// with the matching tedi audit actor; public caller headers grant nothing.
		const tediId = request.headers.get("X-Tedix-Tedi-Id");
		const tediPlatformAdmin = Boolean(
			tediId &&
			request.headers.get("X-Tedix-Actor-Type") === "tedi" &&
			request.headers.get("X-Tedix-Actor-Id") === tediId &&
			isPlatformPrincipal({
				tediScopes: (request.headers.get("X-Tedix-Tedi-Scopes") ?? "")
					.split(/\s+/)
					.filter(Boolean),
			}),
		);
		return {
			authenticated: true,
			authType: "service-token",
			orgSlug: getRequestedOrgSlug(request),
			forwardedAuth,
			user: forwardedUser,
			platformAdmin:
				tediPlatformAdmin ||
				Boolean(forwardedUser && isPlatformJwtPrincipal(forwardedUser)),
			cmsMaintenance:
				request.headers.get("X-Tedix-Cms-Maintenance-Authorized") === "true" ||
				Boolean(
					forwardedUser &&
					(getJwtScopes(forwardedUser).includes("mcp:content.admin") ||
						(getJwtScopes(forwardedUser).includes("mcp:content.write") &&
							getJwtScopes(forwardedUser).includes("mcp:settings.admin"))),
				),
		};
	}

	if (!token) {
		return { authenticated: false, error: "Missing authorization" };
	}

	try {
		const payload = await validateToken(token, {
			projectId: env.DESCOPE_PROJECT_ID,
			baseUrl: env.DESCOPE_BASE_URL,
		});

		if (!payload.sub) {
			return { authenticated: false, error: "JWT missing subject" };
		}

		const resolved = await resolveAuthorizedOrg(request, payload, env);
		if (resolved.error) {
			return { authenticated: false, error: resolved.error, status: 403 };
		}
		// Direct user auth — the token itself is the user's JWT
		return {
			authenticated: true,
			authType: "user",
			orgSlug: resolved.orgSlug,
			forwardedAuth: token,
			user: payload,
			platformAdmin: isPlatformJwtPrincipal(payload),
			cmsMaintenance:
				getJwtScopes(payload).includes("mcp:content.admin") ||
				(getJwtScopes(payload).includes("mcp:content.write") &&
					getJwtScopes(payload).includes("mcp:settings.admin")),
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { authenticated: false, error: `JWT validation failed: ${msg}` };
	}
}

function parseCmsServiceKeys(raw: string | undefined): Record<string, string> {
	if (!raw) return {};
	try {
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		return {};
	}
}

function getPreviewHostname(env: AppEnv["Bindings"]): string {
	if (env.ENVIRONMENT === "development") return "localhost:3013";
	return SITE_BUILDER_HOSTNAME;
}

function buildDeployConfig(env: AppEnv["Bindings"]): DeployConfig {
	return {
		environment:
			(env.ENVIRONMENT as DeployConfig["environment"]) || "production",
	};
}

export async function mapWorkflowStatus(
	env: AppBindings,
	jobId: string,
	orgSlug: string,
): Promise<DeployStatus> {
	try {
		const instance = await env.DEPLOY_WORKFLOW.get(jobId);
		const raw = await instance.status();
		const status = raw.status as string;

		const mapped: DeployStatus["status"] =
			status === "queued"
				? "queued"
				: status === "running"
					? "running"
					: status === "complete"
						? "complete"
						: status === "errored"
							? "errored"
							: status === "terminated"
								? "terminated"
								: status === "paused"
									? "paused"
									: status === "waiting" || status === "waitingForEvent"
										? "running"
										: "unknown";

		const result: DeployStatus = { status: mapped, jobId };
		const snapshotObj = await env.SITE_BUILDER_STORAGE.get(
			deployStatusKey(jobId),
		);
		if (snapshotObj) {
			try {
				const snapshot = (await snapshotObj.json()) as DeployStatusSnapshot;
				result.phase = snapshot.phase;
				result.message = safeDeployMessage(snapshot.status, snapshot.message);
				result.updatedAt = snapshot.updatedAt;
				result.history = snapshot.history.map((entry) => ({
					...entry,
					message: safeDeployMessage(entry.status, entry.message),
					details: safeDeployDetails(entry.details),
				}));
				result.details = safeDeployDetails(snapshot.details);
			} catch {
				// Best-effort observability only. Workflow status remains authoritative.
			}
		}
		if (mapped === "complete" && raw.output) {
			const output = raw.output as {
				version: number;
				url: string;
				etag?: string;
			};
			const versions = await listTenantBundleVersions(
				{ platformDb: env.DB, bundlesBucket: env.BUNDLES_BUCKET },
				orgSlug,
			);
			const active = versions.filter((version) => version.isActive);
			const rolledBack = result.history?.some(
				(entry) =>
					entry.phase === "health-check" &&
					entry.status === "failed" &&
					typeof entry.details?.rolledBackTo === "number",
			);
			if (
				rolledBack ||
				active.length !== 1 ||
				(active[0]?.version ?? 0) < output.version ||
				(active[0]?.version === output.version &&
					output.etag !== undefined &&
					active[0]?.etag !== output.etag)
			) {
				result.status = "failed";
				result.message =
					"Published bundle is not active; deployment failed or rolled back";
			} else {
				result.output = { version: output.version, url: output.url };
				if (active[0]!.version > output.version)
					result.message = `Deployment completed; superseded by active v${active[0]!.version}`;
			}
			result.details = {
				...result.details,
				activeVersion: active[0]?.version ?? null,
			};
		}
		if (mapped === "errored" && raw.error) {
			result.error = "Deploy failed; inspect server logs";
		}
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Workflow.get() throws if instance doesn't exist
		if (msg.toLowerCase().includes("not found")) {
			return { status: "unknown", jobId, error: "Job not found" };
		}
		return {
			status: "failed",
			jobId,
			error: "Deploy status unavailable; inspect server logs",
		};
	}
}

async function mapImageGenerationStatus(
	env: AppBindings,
	jobId: string,
): Promise<
	| ImageGenerationStatusSnapshot
	| { status: string; jobId: string; error?: string }
> {
	try {
		const instance = await env.IMAGE_GENERATION_WORKFLOW.get(jobId);
		const raw = await instance.status();
		const status = raw.status as string;
		const snapshotObj = await env.SITE_BUILDER_STORAGE.get(
			imageGenerationStatusKey(jobId),
		);
		if (snapshotObj) {
			const snapshot =
				(await snapshotObj.json()) as ImageGenerationStatusSnapshot;
			if (status === "errored" && raw.error) {
				return {
					...snapshot,
					status: "failed",
					error:
						typeof raw.error === "string"
							? raw.error
							: JSON.stringify(raw.error),
				};
			}
			return snapshot;
		}
		return {
			status:
				status === "queued" || status === "running" || status === "complete"
					? status
					: status === "errored" || status === "terminated"
						? "failed"
						: "unknown",
			jobId,
			error:
				status === "errored" && raw.error
					? typeof raw.error === "string"
						? raw.error
						: JSON.stringify(raw.error)
					: undefined,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.toLowerCase().includes("not found")) {
			return { status: "unknown", jobId, error: "Job not found" };
		}
		return { status: "failed", jobId, error: msg };
	}
}

async function buildSiteBuilderContext(
	orgSlug: string,
	env: AppEnv["Bindings"],
	auth: AuthenticatedRequest,
	humanAuth: CmsHumanAuthResolution,
	recordMcpAuditEvent?: SiteBuilderToolContext["recordMcpAuditEvent"],
): Promise<SiteBuilderToolContext> {
	// Discovery must not start SDK configuration that outlives its request.
	let sandbox: ReturnType<typeof getSiteBuilderSandbox> | undefined;
	const getRequestSandbox = () =>
		(sandbox ??= getSiteBuilderSandbox(env, orgSlug));
	const deployCtx: DeployContext = {
		config: buildDeployConfig(env),
		get sandbox() {
			return getRequestSandbox();
		},
		bundlesBucket: env.BUNDLES_BUCKET,
		platformDb: env.DB,
	};

	const assertOrgOperationAllowed = (targetOrgSlug: string, action: string) => {
		if (targetOrgSlug !== orgSlug && !auth.platformAdmin) {
			throw new Error(
				`Platform admin authority required to ${action} org "${targetOrgSlug}" from "${orgSlug}"`,
			);
		}
	};

	const humanAuthRequired = requiresCmsHumanAuth(auth.forwardedAuth, auth.user);
	const [serviceApiKey, templateSelection] = await Promise.all([
		loadServiceKey(
			env.SITE_BUILDER_STORAGE,
			orgSlug,
			parseCmsServiceKeys(env.CMS_SERVICE_KEYS),
		),
		getCmsTemplateSelection(env.DB, orgSlug),
	]);
	const templateSlug = normalizeCmsTemplateSlug(
		templateSelection?.blogTemplateSlug ?? templateSelection?.metaTemplateSlug,
	);

	return {
		orgSlug,
		recordMcpAuditEvent,
		templateSlug,
		get sandbox() {
			return getRequestSandbox();
		},
		prepareAuthoringWorkspace: async () => {
			const sandbox = getRequestSandbox();
			const state = await sandbox.getAuthoringWorkspaceState();
			if (state === "modified") return;
			if (state === "ready") {
				await sandbox.prepareAuthoringWorkspace({
					templateSlug,
					existingSite: true,
				});
				return;
			}
			const authority = await getCmsHumanSiteAuthority(env.DB, orgSlug);
			const existingSite = Boolean(authority?.activeBundleEtag);
			let source: { remote: string; token: string } | undefined;
			if (env.ARTIFACTS) {
				let repo;
				try {
					repo = await env.ARTIFACTS.get(themeArtifactRepoName(orgSlug));
				} catch (error) {
					if (
						existingSite ||
						!/not.?found|NOT_FOUND|404/i.test(
							error instanceof Error ? error.message : String(error),
						)
					)
						throw error;
				}
				if (repo)
					source = {
						remote: themeArtifactRemote(env.CF_ACCOUNT_ID, orgSlug),
						token: await (await repo.createToken("read", 600)).plaintext,
					};
			}
			await sandbox.prepareAuthoringWorkspace({
				templateSlug,
				existingSite,
				source,
			});
		},
		previewHostname: `${getPreviewHostname(env)}/preview/${orgSlug}`,
		storage: env.SITE_BUILDER_STORAGE,
		bundlesBucket: env.BUNDLES_BUCKET,
		artifacts: env.ARTIFACTS,
		artifactsAccountId: env.CF_ACCOUNT_ID,
		artifactsNamespace: THEME_ARTIFACTS_NAMESPACE,
		environment: env.ENVIRONMENT || "production",
		forwardedAuth: undefined,
		humanAuthRequired,
		humanIdentity: humanAuth.identity,
		humanAuthDenial: humanAuth.denial,
		serviceApiKey,
		loadTransferHumanIdentity: async (slug) =>
			auth.user && humanAuthRequired
				? (
						await resolveCmsHumanAuthorization({
							db: env.DB,
							descope: env,
							slug,
							user: auth.user,
						})
					).identity
				: null,
		loadTransferServiceKey: (slug) =>
			loadServiceKey(
				env.SITE_BUILDER_STORAGE,
				slug,
				parseCmsServiceKeys(env.CMS_SERVICE_KEYS),
			),
		internalAuthToken: env.CMS_INTERNAL_AUTH_TOKEN,
		isPlatformAdmin: auth.platformAdmin,
		mediaMaintenanceAuthorized: auth.platformAdmin || auth.cmsMaintenance,
		cmsDispatch: env.CMS_DISPATCH,
		geminiApiKey: env.GEMINI_API_KEY,
		geminiGateway: {
			accountId: env.AI_GATEWAY_ACCOUNT_ID,
			gatewayId: env.AI_GATEWAY_ID,
			token: env.CF_AI_GATEWAY_TOKEN,
			binding: env.AI,
			bindingProviders: env.AI_GATEWAY_BINDING_PROVIDERS,
		},
		db: env.DB,
		getSandboxForOrg: (slug: string) => {
			assertOrgOperationAllowed(slug, "open sandbox for");
			return getSiteBuilderSandbox(env, slug);
		},
		startDeploy: async (slug, summary, sourceCommit) => {
			assertOrgOperationAllowed(slug, "deploy");
			const admission = await startCmsDeployWorkflow({
				workflow: env.DEPLOY_WORKFLOW,
				db: env.DB,
				orgSlug: slug,
				summary,
				sourceCommit,
			});
			return { jobId: admission.jobId };
		},
		getDeployStatus: (jobId) => mapWorkflowStatus(env, jobId, orgSlug),
		startImageGeneration: async (params) => {
			assertOrgOperationAllowed(params.orgSlug, "generate image for");
			const instance = await env.IMAGE_GENERATION_WORKFLOW.create({
				params,
			});
			return { jobId: instance.id };
		},
		getImageGenerationStatus: (jobId) => mapImageGenerationStatus(env, jobId),
		rollback: (slug, version) => {
			assertOrgOperationAllowed(slug, "rollback");
			return rollback(deployCtx, slug, version);
		},
		listVersions: (slug) => {
			assertOrgOperationAllowed(slug, "list versions for");
			return listVersions(env.BUNDLES_BUCKET, env.DB, slug);
		},
	};
}

async function buildCmsProxyContext(
	orgSlug: string,
	env: AppEnv["Bindings"],
	auth: AuthenticatedRequest,
	humanAuth: CmsHumanAuthResolution,
): Promise<CmsProxyContext> {
	const humanAuthRequired = requiresCmsHumanAuth(auth.forwardedAuth, auth.user);
	const serviceApiKey = await loadServiceKey(
		env.SITE_BUILDER_STORAGE,
		orgSlug,
		parseCmsServiceKeys(env.CMS_SERVICE_KEYS),
	);

	return {
		orgSlug,
		mediaMaintenanceAuthorized: auth.platformAdmin || auth.cmsMaintenance,
		forwardedAuth: undefined,
		humanAuthRequired,
		humanIdentity: humanAuth.identity,
		humanAuthDenial: humanAuth.denial,
		serviceApiKey,
		isPlatformAdmin: auth.platformAdmin,
		loadTransferHumanIdentity: async (slug) =>
			auth.user && humanAuthRequired
				? (
						await resolveCmsHumanAuthorization({
							db: env.DB,
							descope: env,
							slug,
							user: auth.user,
						})
					).identity
				: null,
		loadTransferServiceKey: (slug) =>
			loadServiceKey(
				env.SITE_BUILDER_STORAGE,
				slug,
				parseCmsServiceKeys(env.CMS_SERVICE_KEYS),
			),
		internalAuthToken: env.CMS_INTERNAL_AUTH_TOKEN,
		environment: env.ENVIRONMENT || "production",
		cmsDispatch: env.CMS_DISPATCH,
		db: env.DB,
		bundlesBucket: env.BUNDLES_BUCKET,
	};
}

function jsonRpcError(
	id: unknown,
	code: number,
	message: string,
	status = 200,
): Response {
	return Response.json(
		{ jsonrpc: "2.0", id: id ?? null, error: { code, message } },
		{ status },
	);
}

async function maybeHandleSandboxFreeCmsToolCall(
	request: Request,
	env: AppEnv["Bindings"],
	auth: AuthenticatedRequest,
	orgSlug: string,
	humanAuth: CmsHumanAuthResolution,
	recordMcpAuditEvent?: SiteBuilderToolContext["recordMcpAuditEvent"],
): Promise<Response | null> {
	if (request.method !== "POST") return null;

	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		return null;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;

	const rpc = body as {
		id?: unknown;
		jsonrpc?: unknown;
		method?: unknown;
		params?: unknown;
	};
	if (rpc.method !== "tools/call") return null;
	const params =
		rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
			? (rpc.params as Record<string, unknown>)
			: undefined;
	const toolName = typeof params?.name === "string" ? params.name : undefined;
	if (!toolName) {
		return jsonRpcError(rpc.id, -32602, "Missing tools/call params.name");
	}
	if (!SANDBOX_FREE_CMS_PROXY_TOOLS.has(toolName)) return null;

	// This optimization bypasses mountMcp(), so it must run the exact shared
	// 2026 request-binding ladder before executing a tenant tool.
	const violation = validateModernProtocolHeaders({
		headers: request.headers,
		method: "tools/call",
		params,
	});
	if (violation) {
		return jsonRpcError(
			rpc.id,
			violation.code,
			violation.message,
			violation.code === -32_601 ? 404 : 400,
		);
	}

	const args =
		params?.arguments &&
		typeof params.arguments === "object" &&
		!Array.isArray(params.arguments)
			? (params.arguments as Record<string, unknown>)
			: {};
	const cmsCtx = await buildCmsProxyContext(orgSlug, env, auth, humanAuth);
	const startedAt = Date.now();
	let outcome: "error" | "success" = "error";
	let resultDigest: string | null = null;
	let result;
	try {
		result = await callSandboxFreeCmsProxyTool(cmsCtx, toolName, args);
		if (result) {
			const bytes = new TextEncoder().encode(
				(JSON.stringify(result) ?? "null").slice(0, 65_536),
			);
			const digest = await crypto.subtle.digest("SHA-256", bytes);
			resultDigest = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			outcome = "success";
		}
	} finally {
		if (recordMcpAuditEvent) {
			try {
				await recordMcpAuditEvent({
					durationMs: Date.now() - startedAt,
					outcome,
					resultDigest,
					toolName,
				});
			} catch (error) {
				console.error("[cms-mcp] fast-path audit write failed", error);
			}
		}
	}
	if (!result) return null;

	return Response.json(
		{
			jsonrpc: "2.0",
			id: rpc.id ?? null,
			result: { resultType: "complete", ...result },
		},
		{
			headers: {
				"X-Tedix-CMS-Fast-Path": "sandbox-free",
			},
		},
	);
}

async function handleMcpRequest(c: {
	req: {
		raw: Request;
		header: (name: string) => string | undefined;
		query: (name: string) => string | undefined;
	};
	env: AppEnv["Bindings"];
}): Promise<Response> {
	const protocolError = enforceModernMcpProtocol(c.req.raw);
	if (protocolError) return protocolError;
	const auth = await authenticateRequest(c.req.raw, c.env);
	if (!auth.authenticated) {
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32000, message: `Unauthorized: ${auth.error}` },
			}),
			{
				status: auth.status ?? 401,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const orgSlug = auth.orgSlug;
	if (!orgSlug) {
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32602,
					message:
						"Missing org — pass ?org=slug or include orgSlug in the bearer token",
				},
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
	const cmsSelection = await getCmsTemplateSelection(c.env.DB, orgSlug);
	if (!cmsSelection) {
		return jsonRpcError(
			null,
			-32602,
			`Unknown CMS organization "${orgSlug}"`,
			400,
		);
	}
	const organizationId = cmsSelection.organizationId;
	const traceId = resolveInboundTraceId(c.req.raw.headers);
	const forwardedHumanJwt = getForwardedHumanJwt(auth);
	// A forwarded bearer that did not verify is still a human-required call; its
	// denial is recorded here so the tool error names the cause, not a guess.
	const humanAuth: CmsHumanAuthResolution =
		forwardedHumanJwt && auth.user
			? await resolveCmsHumanAuthorization({
					db: c.env.DB,
					descope: c.env,
					slug: orgSlug,
					user: auth.user,
				})
			: {
					identity: null,
					denial: requiresCmsHumanAuth(auth.forwardedAuth, auth.user)
						? { reason: "unverified_bearer" }
						: null,
				};
	const humanIdentity = humanAuth.identity;
	const { actorId, actorType } = cmsAuditActor(auth.user, humanIdentity);
	const auditRecorder: SiteBuilderToolContext["recordMcpAuditEvent"] = (
		event,
	) =>
		recordCmsMcpAuditEvent(c.env.API_SERVICE, {
			action: "mcp.tool.execute",
			actorId,
			actorType,
			organizationId,
			resourceId: event.toolName,
			metadata: {
				authType: auth.authType,
				durationMs: event.durationMs,
				outcome: event.outcome,
				resultDigest: event.resultDigest,
				traceId,
			},
		});

	const fastResponse = await maybeHandleSandboxFreeCmsToolCall(
		c.req.raw,
		c.env,
		auth,
		orgSlug,
		humanAuth,
		auditRecorder,
	);
	if (fastResponse) return fastResponse;

	const siteBuilderCtx = await buildSiteBuilderContext(
		orgSlug,
		c.env,
		auth,
		humanAuth,
		auditRecorder,
	);
	const { buildSiteBuilderMcpServer, buildInstructions } =
		await import("./agent/tools");
	const server = buildSiteBuilderMcpServer(siteBuilderCtx);

	const origin = c.req.header("Origin") ?? "*";
	return mountMcp(server, c.req.raw, {
		route: "/mcp",
		cors: { origin },
		discover: buildCmsMcpDiscovery(
			buildInstructions(siteBuilderCtx.templateSlug),
		),
	});
}

app.post("/mcp", async (c) => {
	return handleMcpRequest({
		req: c.req,
		env: c.env,
	});
});

app.get("/mcp", async (c) => {
	const accept = c.req.header("Accept") ?? "";
	if (accept.includes("text/event-stream")) {
		return handleMcpRequest({
			req: c.req,
			env: c.env,
		});
	}

	return c.json({
		name: "cms",
		protocol: "MCP (Model Context Protocol)",
		transport: "Streamable HTTP",
		version: "0.1.0",
		hint: "POST JSON-RPC 2.0 requests with Content-Type: application/json. Pass ?org=slug to select the CMS org.",
		auth: "Bearer token (Descope JWT)",
	});
});

app.delete("/mcp", async (c) => {
	return handleMcpRequest({
		req: c.req,
		env: c.env,
	});
});

// authz: public — CORS preflight grants no MCP session or application authority.
app.options("/mcp", () => {
	return new Response(null, {
		status: 204,
		headers: {
			// Wildcard origin (bearer-authenticated MCP, no cookies): not the
			// worker-kit origin allowlist. Header/expose lists are the shared ones.
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
			// Shared list, not a hand-maintained copy: the previous literal omitted
			// `Mcp-Protocol-Version` (so a conformant client's preflight failed on
			// the one header the revision requires on every POST) and advertised
			// the removed `Mcp-Session-Id`.
			"Access-Control-Allow-Headers": MCP_CORS_HEADERS.join(", "),
			"Access-Control-Expose-Headers": MCP_CORS_EXPOSE_HEADERS.join(", "),
			"Access-Control-Max-Age": "86400",
		},
	});
});

app.get("/api/image-generation/:jobId", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	if (!auth.authenticated) {
		return c.json({ error: auth.error ?? "Unauthorized" }, auth.status ?? 401);
	}

	const jobId = c.req.param("jobId");
	const status = await mapImageGenerationStatus(c.env, jobId);
	const snapshotOrg =
		"orgSlug" in status && typeof status.orgSlug === "string"
			? status.orgSlug
			: auth.orgSlug;
	if (
		snapshotOrg &&
		!(await isAuthAuthorizedForOrg(auth, snapshotOrg, c.env))
	) {
		return c.json({ error: "Organization access denied for image job" }, 403);
	}
	if (status.status === "unknown") {
		return c.json(status, 404);
	}
	return c.json(status, status.status === "failed" ? 500 : 200);
});

async function purgeSiteBuilderObjects(
	bucket: R2Bucket,
	slug: string,
	siteId: string,
) {
	const prefixes = [
		`hot-themes/${slug}/`,
		`cms-builds/${slug}/`,
		`cms-preview-exec/${slug}/`,
		`cms-theme-artifacts/${slug}/`,
		`themes/${slug}/staging/`,
		`themes/deploy-status/cms-${siteId}-v`,
	];
	let deleted = 0;
	for (const prefix of prefixes) {
		// Always restart the prefix after a delete. A cursor over a mutating
		// listing can skip objects that move into an already-read page.
		for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
			const page = await bucket.list({ prefix });
			const keys = page.objects.map((object) => object.key);
			if (keys.length === 0) break;
			await bucket.delete(keys);
			deleted += keys.length;
			if (pageNumber === 9_999)
				throw new Error(
					`CMS Builder cleanup exceeded 10,000 batches for ${prefix}`,
				);
		}
	}
	await bucket.delete(`_cms-service-keys/${slug}`);
	return deleted;
}

function isInternalDeploymentRequestAuthorized(
	auth: AuthenticationResult,
	slug: string,
): auth is AuthenticatedRequest & { authType: "service-token" } {
	return (
		auth.authenticated &&
		auth.authType === "service-token" &&
		auth.orgSlug === slug
	);
}

app.get("/api/internal/deployments/:slug/resources", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (!isInternalDeploymentRequestAuthorized(auth, slug)) {
		return c.json({ error: "Internal service authorization required" }, 403);
	}
	const durableObject: {
		state: "present" | "missing" | "unknown";
		error?: string;
	} = { state: "unknown" };
	if (c.env.CMS_DISPATCH && c.env.CMS_INTERNAL_AUTH_TOKEN) {
		try {
			const response = await c.env.CMS_DISPATCH.fetch(
				new Request(
					`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/storage`,
					{
						headers: {
							"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
						},
					},
				),
			);
			const result = (await response.json()) as {
				storageState?: "present" | "missing";
				error?: string;
			};
			if (response.ok && result.storageState) {
				durableObject.state = result.storageState;
			} else {
				durableObject.error =
					result.error ?? `CMS runtime returned ${response.status}`;
			}
		} catch (error) {
			durableObject.error =
				error instanceof Error ? error.message : String(error);
		}
	} else {
		durableObject.error = "CMS runtime binding or internal token missing";
	}
	return c.json({
		success: true,
		durableObject: { identifier: `EmDashDB:${slug}`, ...durableObject },
	});
});

// Service-only recovery capture. Exact tenant slug and fresh active-site state
// are checked before the runtime is asked for a primary SQLite bookmark.
app.post("/api/internal/deployments/:slug/recovery-bookmark", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (
		!isInternalDeploymentRequestAuthorized(auth, slug) ||
		!/^[a-z][a-z0-9-]*$/.test(slug)
	) {
		return c.json({ error: "Internal service authorization required" }, 403);
	}
	const site = await getCmsTemplateSelection(c.env.DB, slug);
	if (!site) return c.json({ error: "Active CMS site required" }, 404);
	if (!c.env.CMS_DISPATCH || !c.env.CMS_INTERNAL_AUTH_TOKEN) {
		return c.json({ error: "CMS runtime unavailable" }, 503);
	}
	const response = await c.env.CMS_DISPATCH.fetch(
		new Request(
			`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/recovery-bookmark`,
			{
				method: "POST",
				headers: {
					"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
				},
			},
		),
	);
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
});

// Service-only pass-through. The API supplies its owner-scoped site ID; Builder
// runtime rereads the exact active site and bundle for new captures. Archived
// sites retain status and purge access through the site-scoped workflow ID.
app.all("/api/internal/deployments/:slug/recovery-captures", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (
		!isInternalDeploymentRequestAuthorized(auth, slug) ||
		!/^[a-z][a-z0-9-]*$/.test(slug)
	)
		return c.json({ error: "Internal service authorization required" }, 403);
	if (!["GET", "POST", "DELETE"].includes(c.req.method))
		return c.json({ error: "Method not allowed" }, 405);
	const siteId = new URL(c.req.url).searchParams.get("siteId");
	if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
		return c.json({ error: "Site ID required" }, 400);
	if (!c.env.CMS_DISPATCH || !c.env.CMS_INTERNAL_AUTH_TOKEN)
		return c.json({ error: "CMS runtime unavailable" }, 503);
	const target = new URL(
		`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/recovery-captures`,
	);
	target.search = new URL(c.req.url).search;
	const response = await c.env.CMS_DISPATCH.fetch(
		new Request(target, {
			method: c.req.method,
			headers: { "X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN },
		}),
	);
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, { status: response.status, headers });
});

/** Owner authorization happens in apps/api; this hop preserves service auth. */
app.all("/api/internal/deployments/:slug/site-restores", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (
		!isInternalDeploymentRequestAuthorized(auth, slug) ||
		!/^[a-z][a-z0-9-]*$/.test(slug)
	)
		return c.json({ error: "Internal service authorization required" }, 403);
	if (c.req.method !== "GET" && c.req.method !== "POST")
		return c.json({ error: "Method not allowed" }, 405);
	const siteId = new URL(c.req.url).searchParams.get("siteId");
	if (!siteId || !/^[0-9a-f-]{36}$/.test(siteId))
		return c.json({ error: "Site ID required" }, 400);
	if (!c.env.CMS_DISPATCH || !c.env.CMS_INTERNAL_AUTH_TOKEN)
		return c.json({ error: "CMS runtime unavailable" }, 503);
	const target = new URL(
		`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/site-restores`,
	);
	target.search = new URL(c.req.url).search;
	const response = await c.env.CMS_DISPATCH.fetch(
		new Request(target, {
			method: c.req.method,
			headers: {
				"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
				...(c.req.method === "POST"
					? { "Content-Type": "application/json" }
					: {}),
			},
			...(c.req.method === "POST" ? { body: await c.req.raw.text() } : {}),
		}),
	);
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(response.body, { status: response.status, headers });
});

// Provider-backed CMS resource inspection and repair. apps/api exposes this
// through the owner-scoped, platform-admin sites MCP tools; the CMS Worker owns
// the Cloudflare credential and never accepts this endpoint publicly.
app.get("/api/internal/deployments/:slug/media", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (!isInternalDeploymentRequestAuthorized(auth, slug)) {
		return c.json({ error: "Internal service authorization required" }, 403);
	}
	if (!c.env.CMS_DISPATCH || !c.env.CMS_INTERNAL_AUTH_TOKEN) {
		return c.json({ success: false, error: "CMS runtime unavailable" }, 503);
	}
	return c.env.CMS_DISPATCH.fetch(
		new Request(`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`, {
			headers: {
				"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
			},
		}),
	);
});

app.post("/api/internal/deployments/:slug/media", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (!isInternalDeploymentRequestAuthorized(auth, slug)) {
		return c.json({ error: "Internal service authorization required" }, 403);
	}
	const intent = c.req.header("X-Tedix-CMS-Media-Intent");
	if (intent !== "create" && intent !== "repair") {
		return c.json({ success: false, error: "CMS media intent required" }, 400);
	}
	const siteId = c.req.header("X-Tedix-CMS-Site-Id");
	if (
		!siteId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			siteId,
		)
	)
		return c.json({ success: false, error: "Exact CMS site ID required" }, 400);
	if (!c.env.CMS_DISPATCH || !c.env.CMS_INTERNAL_AUTH_TOKEN) {
		return c.json({ success: false, error: "CMS runtime unavailable" }, 503);
	}
	return c.env.CMS_DISPATCH.fetch(
		new Request(`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`, {
			method: "POST",
			headers: {
				"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
				"X-Tedix-CMS-Media-Intent": intent,
				"X-Tedix-CMS-Site-Id": siteId,
			},
		}),
	);
});

// Internal lifecycle endpoint. The durable receipt and paused canonical site
// authorize the exact immutable identity before any provider mutation.
app.delete("/api/internal/deployments/:slug", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	const slug = c.req.param("slug");
	if (
		!isInternalDeploymentRequestAuthorized(auth, slug) ||
		!/^[a-z][a-z0-9-]*$/.test(slug)
	) {
		return c.json({ error: "Internal service authorization required" }, 403);
	}
	const siteId = c.req.header("X-Tedix-CMS-Site-Id");
	if (
		!siteId ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			siteId,
		)
	)
		return c.json({ error: "Exact CMS site ID required" }, 400);
	try {
		if (!(await hasExactCmsDeprovisionAuthority(c.env.DB, { siteId, slug })))
			return c.json({ error: "CMS deprovision authority mismatch" }, 409);
	} catch {
		return c.json({ error: "CMS deprovision authority unavailable" }, 503);
	}
	const errors: string[] = [];
	let deletedDurableObjectData = false;
	if (c.env.CMS_DISPATCH && c.env.CMS_INTERNAL_AUTH_TOKEN) {
		try {
			const response = await c.env.CMS_DISPATCH.fetch(
				new Request(
					`https://${slug}.cms.tedix.dev/_tedix/internal/database-runtime/deprovision`,
					{
						method: "DELETE",
						headers: {
							"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
							"X-Tedix-CMS-Site-Id": siteId,
						},
					},
				),
			);
			if (!response.ok)
				throw new Error(`CMS runtime returned ${response.status}`);
			deletedDurableObjectData = true;
		} catch (error) {
			errors.push(
				`CMS Durable Object: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else {
		errors.push(
			"CMS Durable Object: runtime binding or internal token missing",
		);
	}

	const result = await deprovisionCms(
		{ bundlesBucket: c.env.BUNDLES_BUCKET, platformDb: c.env.DB },
		slug,
		async () => {
			if (!c.env.CMS_DISPATCH || !c.env.CMS_INTERNAL_AUTH_TOKEN)
				throw new Error("CMS runtime binding or internal token missing");
			const response = await c.env.CMS_DISPATCH.fetch(
				new Request(
					`https://${slug}.cms.tedix.dev/_tedix/internal/media-bucket`,
					{
						method: "DELETE",
						headers: {
							"X-Tedix-CMS-Internal-Auth": c.env.CMS_INTERNAL_AUTH_TOKEN,
							"X-Tedix-CMS-Site-Id": siteId,
						},
					},
				),
			);
			const data = (await response.json()) as {
				success?: boolean;
				deleted?: boolean;
				error?: string;
			};
			if (!response.ok || !data.success || !data.deleted)
				throw new Error(
					data.error ?? `CMS media cleanup returned ${response.status}`,
				);
			return true;
		},
	);
	errors.push(...result.errors);
	let deletedSiteBuilderObjects = 0;
	let deletedSandbox = false;
	try {
		deletedSiteBuilderObjects = await purgeSiteBuilderObjects(
			c.env.SITE_BUILDER_STORAGE,
			slug,
			siteId,
		);
	} catch (error) {
		errors.push(
			`Site Builder storage: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		await getSiteBuilderSandbox(c.env, slug).destroy();
		deletedSandbox = true;
	} catch (error) {
		errors.push(
			`Site Builder sandbox: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return c.json({
		success: errors.length === 0,
		slug,
		deletedDurableObjectData,
		deletedMediaBucket: result.deletedR2,
		deletedBundles: result.deletedBundles,
		deletedSiteBuilderObjects,
		deletedSandbox,
		errors,
	});
});

// =============================================================================
// Preview proxy — /preview/:orgSlug/* → container port 4321
// =============================================================================

app.all("/preview/:orgSlug/*", async (c) => {
	const auth = await authenticateRequest(c.req.raw, c.env);
	if (!auth.authenticated) {
		return c.json({ error: auth.error ?? "Unauthorized" }, auth.status ?? 401);
	}

	const orgSlug = c.req.param("orgSlug");
	if (!(await isAuthAuthorizedForOrg(auth, orgSlug, c.env))) {
		return c.json({ error: "Organization access denied for preview" }, 403);
	}

	const sandbox = getSiteBuilderSandbox(c.env, orgSlug);

	const url = new URL(c.req.url);
	const proxyPath = url.pathname.replace(`/preview/${orgSlug}`, "") || "/";
	const proxyUrl = new URL(proxyPath, "http://container");
	proxyUrl.search = url.search;

	const headers = new Headers(c.req.raw.headers);
	if (auth.forwardedAuth) {
		headers.set("Authorization", `Bearer ${auth.forwardedAuth}`);
	}

	return sandbox.containerFetch(
		proxyUrl.toString(),
		{
			method: c.req.method,
			headers: Object.fromEntries(headers),
			body:
				c.req.method !== "GET" && c.req.method !== "HEAD"
					? c.req.raw.body
					: undefined,
		},
		4321,
	);
});

export default app;
