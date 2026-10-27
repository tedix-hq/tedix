/**
 * Tedix API Worker — application module (lazily loaded)
 *
 * This module owns the Hono app, oRPC handlers, and cron/queue handlers. It is
 * dynamically imported from src/index.ts on the first event so the full
 * router/contract/schema graph is evaluated at request time, not at script
 * startup (Cloudflare deploy validation enforces a 1-second startup CPU limit,
 * error 10021).
 */
import { Hono } from "hono";
import { scheduled } from "./jobs/scheduled-dispatch";
import { registerCorsAndLimits } from "./http/cors-and-limits";
import { registerPublicIntakeRoutes } from "./http/public-intake-routes";
import { registerPublicBlueprintRoutes } from "./http/public-blueprint-routes";
import { registerRpcRoutes } from "./http/rpc-routes";
import { registerOpenApiDocs } from "./http/openapi-docs";
import { registerKernelRoutes } from "./http/kernel-routes";
import { registerSkillMediaRoutes } from "./http/skill-media-routes";
import { registerOsSharedRoutes } from "./http/os-shared-routes";
import { registerExportsAndRenders } from "./http/exports-and-renders";
import { registerArtifactRoutes } from "./http/artifact-routes";
import { registerWebhookRoutes } from "./http/webhook-routes";

const app = new Hono<{ Bindings: CloudflareEnv }>();
registerCorsAndLimits(app);
registerPublicIntakeRoutes(app);
registerPublicBlueprintRoutes(app);
registerRpcRoutes(app);
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
export type { ApiRouter } from "./rpc/routers/index";
