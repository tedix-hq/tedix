import type { Hono } from "hono";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { getApiDiscoveryUrls, renderApiReferenceHtml } from "../api-discovery";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import {
	createPublicOpenApiGenerateOptions,
	OPENAPI_SECURITY_EXTENSIONS,
	stripPublicRestMarker,
} from "../openapi-document";
import { apiRouter } from "../rpc/routers/index";
import { createContext } from "../rpc/orpc";
import { byIp, rateLimit } from "../middleware/rate-limit";

/**
 * OpenAPI specification generator — also LAZY, same reasoning.
 * Note: Uses Zod v4 converter for schema transformation.
 * Only `/openapi.json` needs it, and the generated spec is cached below.
 */
let openAPIGeneratorInstance: OpenAPIGenerator | undefined;
function getOpenAPIGenerator(): OpenAPIGenerator {
	openAPIGeneratorInstance ??= new OpenAPIGenerator({
		converters: [new ZodToJsonSchemaConverter()],
	});
	return openAPIGeneratorInstance;
}

// Cached OpenAPI spec (generated lazily on first request)
let cachedOpenApiSpec: object | null = null;
let specGeneratedAt: number = 0;
const SPEC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function registerOpenApiDocs(app: Hono<{ Bindings: CloudflareEnv }>) {
	// authz: public — API metadata landing response; contains no tenant or principal data.
	app.get("/", (c) => {
		const urls = getApiDiscoveryUrls(c.env.API_URL);
		return c.json({
			name: "Tedix API",
			openapi: urls.openapi,
			documentation: urls.documentation,
		});
	});

	/**
	 * OpenAPI specification endpoint (JSON)
	 * Returns the complete OpenAPI 3.1 spec for the public REST API
	 * Cached for performance (spec generation is expensive)
	 */
	// authz: public — machine-readable public API contract and security scheme metadata.
	app.get("/openapi.json", async (c) => {
		try {
			const now = Date.now();

			// Return cached spec if still valid
			if (cachedOpenApiSpec && now - specGeneratedAt < SPEC_CACHE_TTL_MS) {
				return c.json(cachedOpenApiSpec);
			}

			// Generate fresh spec (excluding internal procedures)
			const generatedSpec = await getOpenAPIGenerator().generate(
				apiRouter,
				createPublicOpenApiGenerateOptions(),
			);
			stripPublicRestMarker(generatedSpec);

			// Merge security schemes into generated spec
			// oRPC doesn't support securitySchemes natively, so we inject them
			const spec = {
				...generatedSpec,
				security: OPENAPI_SECURITY_EXTENSIONS.security,
				components: {
					...((generatedSpec as unknown as Record<string, unknown>)
						.components as Record<string, unknown> | undefined),
					...OPENAPI_SECURITY_EXTENSIONS.components,
				},
			};

			// Cache it
			cachedOpenApiSpec = spec;
			specGeneratedAt = now;

			return c.json(spec);
		} catch (err) {
			console.error(
				JSON.stringify({
					event: "api.openapi_spec_generation_failed",
					exception: safeExceptionTopology(err),
				}),
			);
			return c.json({ error: "Internal server error" }, 500);
		}
	});

	/**
	 * API documentation endpoint (Scalar UI)
	 * Provides interactive API reference powered by Scalar
	 */
	// authz: public — interactive renderer for the same public OpenAPI contract.
	app.get("/docs", (c) => {
		const faviconHref = (() => {
			try {
				const url = new URL(c.env.API_URL);
				const hostParts = url.hostname.split(".");
				if (hostParts.length > 2) {
					const rootDomain = hostParts.slice(-2).join(".");
					return `${url.protocol}//${rootDomain}/favicon.ico`;
				}
				return `${url.protocol}//${url.hostname}/favicon.ico`;
			} catch {
				return "https://tedix.dev/favicon.ico";
			}
		})();

		const html = renderApiReferenceHtml({
			apiUrl: c.env.API_URL,
			faviconHref,
		});

		return c.html(html);
	});

	app.use(
		"/auth/oidc/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, { limit: 100 }),
	);

	// authz: public — OIDC protocol routes validate state, provider signatures and active membership.
	app.all("/auth/oidc/:verb", async (c) => {
		const { handleOidcLogin } = await import("../oidc-login");
		return handleOidcLogin(c.req.raw, createContext(c.req.raw, c.env));
	});

	// Health check. Mirrors the eager handler in ../index.ts, including deployedSha —
	// the two must not disagree about which release is live.
	// authz: public — liveness and deployed-sha provenance only; no tenant state.
	app.get("/health", (c) =>
		c.json({
			status: "ok",
			service: "api",
			deployedSha: String(c.env.GIT_SHA || "unknown"),
			timestamp: new Date().toISOString(),
		}),
	);

	// authz: public OAuth authorization servers must reach this callback; the
	// authenticated, encrypted state binds tenant, operator, issuer, PKCE verifier,
	// resource, and expiry before any authorization code is redeemed.
	app.get("/oauth/mcp/callback", async (c) => {
		const [{ createDbClient }, { handleOutboundMcpOAuthCallback }] =
			await Promise.all([
				import("@tedix/db/client"),
				import("../oauth-cimd-callback"),
			]);
		return handleOutboundMcpOAuthCallback(
			c.req.raw,
			c.env,
			createDbClient(c.env.DB),
		);
	});

	/**
	 * Read back the exact skill-runtime version visible through API's service
	 * binding. The deploy lane compares this response with the runtime's direct
	 * health endpoint so a stale binding cannot silently admit workflows.
	 */
	// authz: public — deployment binding provenance only; no runtime or tenant state.
	app.get("/health/skill-runtime", async (c) => {
		try {
			const response = await c.env.SKILL_RUNTIME.fetch(
				"https://skill-runtime/health",
			);
			const skillRuntime = await response.json();
			if (!response.ok) {
				return c.json(
					{
						status: "error",
						service: "api-skill-runtime-binding",
						upstreamStatus: response.status,
						skillRuntime,
					},
					502,
				);
			}

			return c.json({
				status: "ok",
				service: "api-skill-runtime-binding",
				apiVersion: {
					id: c.env.CF_VERSION_METADATA.id,
					tag: c.env.CF_VERSION_METADATA.tag,
					timestamp: c.env.CF_VERSION_METADATA.timestamp,
				},
				skillRuntime,
			});
		} catch (error) {
			console.error(
				JSON.stringify({
					event: "api.skill_runtime_binding_health_failed",
					exception: safeExceptionTopology(error),
				}),
			);
			return c.json(
				{
					status: "error",
					service: "api-skill-runtime-binding",
					error: "skill_runtime_binding_unavailable",
				},
				502,
			);
		}
	});
}
