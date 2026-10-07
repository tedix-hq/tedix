/**
 * Tedix API Worker — thin entrypoint (startup-CPU guard)
 *
 * Cloudflare deploy validation enforces a 1-second script-startup CPU limit
 * (error 10021). Evaluating the full router/contract/schema graph at module
 * scope exceeds it, so this entrypoint keeps startup minimal:
 *
 * - The Hono app + oRPC handlers + cron/queue handlers live in ./worker-app and are
 *   loaded via dynamic import on the first event.
 * - Durable Objects must be exported as real classes, so they (and their
 *   shared import graph) stay eager — measured well under the limit.
 * - Workflow classes are lazy shims: the runtime only needs the exported
 *   class at startup; each shim dynamically imports its implementation when
 *   `run()` fires.
 *
 * Do not add static imports of the router graph (./rpc/**, ./workflows/**)
 * here — that silently re-eagers the whole bundle and re-breaks deploys.
 */
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import {
	WorkerEntrypoint,
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";

// Durable Objects (wrangler.jsonc durable_objects bindings) must be exported
// as concrete classes at startup; their import graph is the eager floor.
// KERNEL binding → KernelDOv4 (migration v9 force-restart rename; the
// conceptual `KernelDO` survives as a type alias in kernel-do.ts).
export { KernelDOv4 } from "./kernel/kernel-do";
export { KernelVoiceDO } from "./kernel/kernel-voice-do";
export { KernelVoiceInputDO } from "./kernel/kernel-voice-input-do";
// Export router type for typed client generation
export type { ApiRouter } from "./rpc/routers/index";

type AppModule = typeof import("./worker-app");

let appModule: Promise<AppModule> | undefined;
const loadApp = (): Promise<AppModule> => {
	appModule ??= import("./worker-app");
	return appModule;
};

async function serveFetch(
	request: Request,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	// Liveness, answered before loadApp(). `/health` in worker-app.ts is a
	// static JSON literal — no bindings, no D1 — but reaching it costs a full
	// evaluation of the worker-app module graph, which on a cold isolate is
	// seconds of CPU, so every probe on a cold isolate would pay init.
	//
	// A liveness probe that boots the whole application is both a useless
	// signal (it cannot distinguish "edge is up" from "app is healthy") and a
	// source of the very pressure it is meant to detect: each probe evaluates
	// the graph again. Answering here keeps the response byte-identical while
	// costing nothing.
	//
	// Exact match only. `/health/skill-runtime` must still route through the
	// app — the deploy lane compares it against the runtime's own health
	// endpoint to catch a stale service binding, and short-circuiting that
	// would silently pass a broken deploy.
	if (request.method === "GET" && new URL(request.url).pathname === "/health") {
		// deployedSha is the unauthenticated answer to "is my commit live".
		// Deploy job conclusions are not: a superseded deploy exits 0 having
		// shipped nothing, so green means "ran", not "shipped".
		return Response.json({
			status: "ok",
			service: "api",
			// `wrangler types` generates a LITERAL type from the wrangler.jsonc
			// placeholder, but --var replaces it with a real SHA at deploy
			// time, so the generated type is narrower than reality. String()
			// widens it without a cast. Inlined rather than shared with
			// worker-app.ts because this is the eager path (check-lazy-imports).
			deployedSha: String(env.GIT_SHA || "unknown"),
			timestamp: new Date().toISOString(),
		});
	}
	const { default: handlers } = await loadApp();
	return handlers.fetch(request, env, ctx);
}

/**
 * Service-binding ingress. Internal callers bind with
 * `"entrypoint": "InternalEntrypoint"`; the internet reaches only the default
 * export, which strips the `X-Service-Binding` marker, so binding trust is
 * unreachable from a public request.
 */
export class InternalEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
	override fetch(request: Request): Promise<Response> {
		return serveFetch(request, this.env, this.ctx);
	}
}

export default {
	fetch(
		request: Request,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return serveFetch(stripServiceBindingMarker(request), env, ctx);
	},
	async scheduled(
		controller: ScheduledController,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<void> {
		const { default: handlers } = await loadApp();
		await handlers.scheduled(controller, env, ctx);
	},
	async queue(
		batch: { queue: string; messages: readonly unknown[] },
		env: CloudflareEnv,
		ctx: { waitUntil: (p: Promise<unknown>) => void },
	): Promise<void> {
		const { default: handlers } = await loadApp();
		await handlers.queue(batch, env, ctx);
	},
};

// =============================================================================
// LAZY WORKFLOW SHIMS (wrangler.jsonc workflows bindings)
// =============================================================================
// The Workflows engine instantiates the exported class with (ctx, env) and
// calls `run(event, step)`. None of the implementations define custom
// constructors or extra engine-facing methods, so delegating `run` to a
// dynamically imported instance is behavior-preserving while keeping the
// workflow module graphs off the startup path.

type WorkflowImplClass = new (
	ctx: ExecutionContext,
	env: CloudflareEnv,
) => {
	run(event: never, step: WorkflowStep): Promise<unknown>;
};

abstract class LazyWorkflow extends WorkflowEntrypoint<CloudflareEnv> {
	protected abstract loadImpl(): Promise<WorkflowImplClass>;

	override async run(
		event: Readonly<WorkflowEvent<unknown>>,
		step: WorkflowStep,
	): Promise<unknown> {
		const Impl = await this.loadImpl();
		return new Impl(this.ctx, this.env).run(event as never, step);
	}
}

export class ApprovalWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/approval-workflow");
		return m.ApprovalWorkflow as unknown as WorkflowImplClass;
	}
}
export class CatalogDriftWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/catalog-drift-workflow");
		return m.CatalogDriftWorkflow as unknown as WorkflowImplClass;
	}
}
export class CatalogIntegrityWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/catalog-integrity-workflow");
		return m.CatalogIntegrityWorkflow as unknown as WorkflowImplClass;
	}
}
export class CatalogSyncWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/catalog-sync-workflow");
		return m.CatalogSyncWorkflow as unknown as WorkflowImplClass;
	}
}
export class ContentIngestionWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/content-ingestion");
		return m.ContentIngestionWorkflow as unknown as WorkflowImplClass;
	}
}
export class ContentSyncWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/content-sync");
		return m.ContentSyncWorkflow as unknown as WorkflowImplClass;
	}
}
export class CmsDeprovisionWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/cms-deprovision-workflow");
		return m.CmsDeprovisionWorkflow as unknown as WorkflowImplClass;
	}
}
export class GraphProjectionDrainWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/graph-projection-drain-workflow");
		return m.GraphProjectionDrainWorkflow as unknown as WorkflowImplClass;
	}
}
export class GraphGdsRefreshWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/graph-gds-refresh-workflow");
		return m.GraphGdsRefreshWorkflow as unknown as WorkflowImplClass;
	}
}
export class ImportWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/import-workflow");
		return m.ImportWorkflow as unknown as WorkflowImplClass;
	}
}
export class KernelGoalLoopWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/kernel-goal-loop-workflow");
		return m.KernelGoalLoopWorkflow as unknown as WorkflowImplClass;
	}
}
export class McpEvalWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/mcp-eval-workflow");
		return m.McpEvalWorkflow as unknown as WorkflowImplClass;
	}
}
export class McpScanWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/mcp-scan-workflow");
		return m.McpScanWorkflow as unknown as WorkflowImplClass;
	}
}
export class MemoryReflectionWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/memory-reflection-workflow");
		return m.MemoryReflectionWorkflow as unknown as WorkflowImplClass;
	}
}
export class OpenApiSyncWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/openapi-sync-workflow");
		return m.OpenApiSyncWorkflow as unknown as WorkflowImplClass;
	}
}
export class TediMcpAccessHealthWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/tedi-mcp-access-health-workflow");
		return m.TediMcpAccessHealthWorkflow as unknown as WorkflowImplClass;
	}
}
export class ToolSchemaSyncWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/tool-schema-sync-workflow");
		return m.ToolSchemaSyncWorkflow as unknown as WorkflowImplClass;
	}
}
export class McpToolTestWorkflow extends LazyWorkflow {
	protected async loadImpl(): Promise<WorkflowImplClass> {
		const m = await import("./workflows/tool-test-workflow");
		return m.McpToolTestWorkflow as unknown as WorkflowImplClass;
	}
}
