/**
 * Tedix API Worker — application module (lazily loaded)
 *
 * This module owns the Hono app, oRPC handlers, and cron/queue handlers. It is
 * dynamically imported from src/index.ts on the first event so the full
 * router/contract/schema graph is evaluated at request time, not at script
 * startup (Cloudflare deploy validation enforces a 1-second startup CPU limit,
 * error 10021).
 */
import { ORPCError } from "@orpc/client";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import {
	RequestLimitHandlerPlugin,
	RethrowHandlerPlugin,
} from "@orpc/server/plugins";
import { Hono } from "hono";
import { scheduled } from "./jobs/scheduled-dispatch";
import { enrichInputValidationError } from "./rpc/input-validation-error";
import { isPublicProcedure } from "./rpc/openapi-filter";
import { type BaseContext, logProcedureCall } from "./rpc/orpc";
import { type ApiRouter, apiRouter } from "./rpc/routers/index";
import { registerCorsAndLimits } from "./http/cors-and-limits";
import { registerPublicIntakeRoutes } from "./http/public-intake-routes";
import { registerRpcRoutes } from "./http/rpc-routes";
import { registerOpenApiDocs } from "./http/openapi-docs";
import { registerKernelRoutes } from "./http/kernel-routes";
import { registerSkillMediaRoutes } from "./http/skill-media-routes";
import { registerOsSharedRoutes } from "./http/os-shared-routes";
import { registerExportsAndRenders } from "./http/exports-and-renders";
import { registerArtifactRoutes } from "./http/artifact-routes";
import { registerWebhookRoutes } from "./http/webhook-routes";

// =============================================================================
// ORPC HANDLERS (Dual: RPC + OpenAPI)
// =============================================================================

/**
 * RPC handler for internal oRPC calls
 * Works with RPCLink client - uses oRPC's custom wire protocol for type preservation
 * Used by: Tedix OS, MCP service, internal workflows
 */

const handlerPlugins = [
	new RequestLimitHandlerPlugin({ maxBodySize: 10 * 1024 * 1024 }),
	new RethrowHandlerPlugin({
		filter: (error: unknown) => !(error instanceof ORPCError),
	}),
];

/**
 * Lift the failing field name(s) out of oRPC's generic "Input validation failed"
 * rejection into the error message (see ./rpc/input-validation-error). Runs as a
 * client interceptor because those wrap the procedure client — and input-schema
 * validation runs inside it, so the throw is catchable here. `data.issues` is
 * preserved, so structured consumers are unchanged.
 */
const clientInterceptors = [
	// Outermost: covers every procedure uniformly, including the input-validation
	// rejections enriched below. Replaces the former per-procedure
	// `.use(withLogging)` (725 call sites, and ordering-dependent — see
	// ./rpc/orpc's logProcedureCall).
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

/**
 * OpenAPI handler for external REST API
 * Works with any HTTP client - standard REST/JSON format
 * Used by: external developers and public API consumers
 *
 * Uses the explicit operation manifest; backend procedures are private by default.
 *
 * LAZY. Constructing this walks the whole ~600-procedure router to build its
 * REST route table, and it is only ever needed by the `/v1/*` REST surface.
 * The dominant traffic here is `/rpc/*` (apps/mcp, the Tedix OS, the CLI), which
 * never touches it.
 *
 * Why that matters more than it looks: this module is itself loaded lazily on
 * the first request of each isolate (see index.ts — the entrypoint stays thin
 * to survive the 1s script-startup CPU limit). So everything at module scope
 * here is paid per isolate, on a request, and cold isolates are common. Work
 * that most isolates never use must not be in that path.
 */
let openApiHandlerInstance: OpenAPIHandler<BaseContext> | undefined;
function getOpenApiHandler(): OpenAPIHandler<BaseContext> {
	openApiHandlerInstance ??= new OpenAPIHandler(apiRouter, {
		plugins: handlerPlugins,
		clientInterceptors,
		filter: isPublicProcedure,
	});
	return openApiHandlerInstance;
}

const app = new Hono<{ Bindings: CloudflareEnv }>();
registerCorsAndLimits(app);
registerPublicIntakeRoutes(app);
registerRpcRoutes(app, rpcHandler, getOpenApiHandler);
registerOpenApiDocs(app);
registerKernelRoutes(app);
registerSkillMediaRoutes(app);
registerOsSharedRoutes(app);
registerExportsAndRenders(app);
registerArtifactRoutes(app);
registerWebhookRoutes(app);

// =============================================================================
// EXPORTS
// =============================================================================

export default {
	fetch: app.fetch,
	scheduled,
	// tedix-automation-events consumer: generic push-based workflow triggers.
	// The message is the config (org + tedi + skill-workflow-or-turn); the
	// handler holds zero tenant-specific logic. See jobs/automation-events.ts.
	async queue(
		batch: { queue: string; messages: readonly unknown[] },
		env: CloudflareEnv,
		ctx: { waitUntil: (p: Promise<unknown>) => void },
	) {
		const { consumeAutomationEvents } =
			await import("./jobs/automation-events");
		await consumeAutomationEvents(
			env,
			batch.messages as readonly import("./jobs/automation-events").AutomationQueueMessage[],
			{ waitUntil: ctx.waitUntil.bind(ctx) },
		);
	},
};

// Durable Object and Workflow classes are exported from src/index.ts (the
// Worker entrypoint). This module is dynamically imported from that entrypoint
// so the router/contract graph stays off the script-startup path (Cloudflare's
// 1-second startup CPU validation limit, error 10021).
// Export router type for typed client generation
export type { ApiRouter };
