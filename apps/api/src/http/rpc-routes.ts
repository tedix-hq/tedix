import { ORPCError } from "@orpc/client";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import {
	RequestLimitHandlerPlugin,
	RethrowHandlerPlugin,
} from "@orpc/server/plugins";
import { D1_BOOKMARK_HEADER } from "@tedix/db/client";
import type { Hono } from "hono";
import { enrichInputValidationError } from "../rpc/input-validation-error";
import { isPublicProcedure } from "../rpc/openapi-filter";
import { type BaseContext, createContext, logProcedureCall } from "../rpc/orpc";
import { apiRouter } from "../rpc/routers/index";

const handlerPlugins = [
	new RequestLimitHandlerPlugin({ maxBodySize: 10 * 1024 * 1024 }),
	new RethrowHandlerPlugin({
		filter: (error: unknown) => !(error instanceof ORPCError),
	}),
];

// Client interceptors wrap input validation, so they can enrich field errors
// while preserving data.issues for structured consumers.
const clientInterceptors = [
	// Outermost so logging also covers validation and permission rejections.
	(options: {
		context: BaseContext;
		path: readonly string[];
		next: () => Promise<unknown>;
	}) => logProcedureCall(options),
	async (options: { next: () => Promise<unknown> }) => {
		try {
			return await options.next();
		} catch (error) {
			throw enrichInputValidationError(error);
		}
	},
];

const rpcHandler = new RPCHandler(apiRouter, {
	plugins: handlerPlugins,
	clientInterceptors,
});

// Building the REST route table walks the full lazy router tree. Defer it
// until /v1/* is requested so RPC traffic never pays that per-isolate cost.
let openApiHandlerInstance: OpenAPIHandler<BaseContext> | undefined;
function getOpenApiHandler(): OpenAPIHandler<BaseContext> {
	openApiHandlerInstance ??= new OpenAPIHandler(apiRouter, {
		plugins: handlerPlugins,
		clientInterceptors,
		filter: isPublicProcedure,
	});
	return openApiHandlerInstance;
}

function withDbBookmark(response: Response, context: BaseContext): Response {
	const bookmark = context.dbBookmark?.();
	if (!bookmark) return response;
	const headers = new Headers(response.headers);
	headers.set(D1_BOOKMARK_HEADER, bookmark);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function registerRpcRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	/**
	 * oRPC handler - serves type-safe procedures through the oRPC RPC protocol
	 *
	 * Examples (RPCLink sends POST for every procedure):
	 * - POST /rpc/apps/list
	 * - POST /rpc/apps/get
	 * - POST /rpc/appAdapters/list
	 * - POST /rpc/appAdapters/update
	 * - POST /rpc/listings/search
	 */
	app.all("/rpc/*", async (c) => {
		// Create base context. Authentication/authorization is procedure-specific.
		const context = createContext(
			c.req.raw,
			c.env,
			c.executionCtx.waitUntil.bind(c.executionCtx),
		);

		// Development-only body logging (redacted) — never log request bodies in prod.
		// oRPC payloads can contain secrets (API keys, tokens, encrypted values, etc.).
		if (
			c.env.ENVIRONMENT === "development" &&
			(c.req.method === "POST" ||
				c.req.method === "PUT" ||
				c.req.method === "PATCH")
		) {
			const clonedRequest = c.req.raw.clone();

			const redact = (value: unknown): unknown => {
				if (Array.isArray(value)) return value.map(redact);
				if (value && typeof value === "object") {
					const out: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(
						value as Record<string, unknown>,
					)) {
						const key = k.toLowerCase();
						if (
							key.includes("token") ||
							key.includes("secret") ||
							key.includes("credential") ||
							key.includes("password") ||
							key.includes("key") ||
							key.includes("apikey") ||
							key === "value" ||
							key.includes("encrypted") ||
							key.includes("authorization")
						) {
							out[k] = "[REDACTED]";
						} else {
							out[k] = redact(v);
						}
					}
					return out;
				}
				return value;
			};

			try {
				const raw = await clonedRequest.text();
				let printable = raw.slice(0, 5_000);
				try {
					printable = JSON.stringify(redact(JSON.parse(raw)), null, 2).slice(
						0,
						5_000,
					);
				} catch {
					// Not JSON (or invalid JSON) — keep truncated raw body
				}
				console.log(
					`[oRPC Request] ${c.req.method} ${c.req.path} - Body (redacted):`,
					printable,
				);
			} catch {
				console.log(
					`[oRPC Request] ${c.req.method} ${c.req.path} - Could not read body`,
				);
			}
		}

		const { matched, response } = await rpcHandler.handle(c.req.raw, {
			prefix: "/rpc",
			context,
		});

		if (!matched) {
			return c.notFound();
		}

		if (response && response.status >= 400) {
			// Always log full error body in non-dev too — needed to diagnose
			// service-binding callers (skill workflows etc.) that don't see
			// detailed errors back through the chain. Body is from oRPC and
			// already gets sensitive data redacted by the handler.
			try {
				const body = await response.clone().json();
				console.error(
					`[oRPC Error] ${c.req.method} ${c.req.path} ${response.status}:`,
					JSON.stringify(body),
				);
			} catch {
				console.error(
					`[oRPC Error] ${c.req.method} ${c.req.path} ${response.status} (no JSON body)`,
				);
			}
		}

		return withDbBookmark(response, context);
	});

	// =============================================================================
	// REST API ROUTES (External - /v1/*)
	// =============================================================================

	/**
	 * External REST API handler - serves OpenAPI-compliant endpoints
	 *
	 * Examples:
	 * - GET  /v1/apps              → List apps
	 * - GET  /v1/apps/{id}         → Get app by ID
	 * - POST /v1/apps              → Create app
	 * - GET  /v1/listings/search   → Search listings
	 *
	 * Only procedures accepted by `isPublicProcedure` are reachable here.
	 */
	app.all("/v1/*", async (c) => {
		// Create base context. Authentication/authorization is procedure-specific.
		const context = createContext(
			c.req.raw,
			c.env,
			c.executionCtx.waitUntil.bind(c.executionCtx),
		);

		// Log request for debugging (only in development)
		if (c.env.ENVIRONMENT === "development") {
			console.log(`[REST API] ${c.req.method} ${c.req.path}`);
		}

		const { matched, response } = await getOpenApiHandler().handle(c.req.raw, {
			prefix: "/v1",
			context,
		});

		if (!matched) {
			return c.json(
				{
					error: "Not Found",
					message: `No matching endpoint for ${c.req.method} ${c.req.path}`,
					docs: "/docs",
				},
				404,
			);
		}

		if (response && response.status >= 400) {
			if (c.env.ENVIRONMENT === "development") {
				try {
					const body = await response.clone().json();
					console.error(
						`[REST API Error] ${c.req.method} ${c.req.path} ${response.status}:`,
						JSON.stringify(body, null, 2),
					);
				} catch {
					console.error(
						`[REST API Error] ${c.req.method} ${c.req.path} ${response.status}`,
					);
				}
			} else {
				console.error(
					`[REST API Error] ${c.req.method} ${c.req.path} ${response.status}`,
				);
			}
		}

		return withDbBookmark(response, context);
	});
}
