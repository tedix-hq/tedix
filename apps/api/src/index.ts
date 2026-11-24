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
import { bindMcpServicePrincipal } from "./service-principal";
import { releaseManifest } from "@tedix/api-contract/utils/release-manifest";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { isolateColo } from "@tedix/worker-kit/colo";
import {
	jobKind,
	runQueuePlaced,
	runScheduledPlaced,
	serveRelay,
} from "./placed-relay";
import {
	DurableObject,
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
// Bound as MACHINE_CONNECTIONS where an installation has the connection
// service; without the binding the class is exported and never used.
export { MachineConnectionDO } from "./services/machine-connection-do";
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
	if (new URL(request.url).pathname === "/release-manifest.json") {
		const headers = { "Cache-Control": "no-store" };
		if (request.method !== "GET")
			return new Response(null, {
				status: 405,
				headers: { ...headers, Allow: "GET" },
			});
		const manifest = releaseManifest({
			repository: env.RELEASE_REPOSITORY,
			commitSha: env.GIT_SHA,
			surface: "api",
			deploymentRunId: env.SHIP_RUN_ID,
		});
		return Response.json(
			manifest ?? { error: "Release metadata is unavailable" },
			{ status: manifest ? 200 : 503, headers },
		);
	}
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
	async reserveRuntimeVoice(
		input: import("@tedix/voice/billing").RuntimeVoiceAdmission,
	): Promise<import("@tedix/voice/billing").RuntimeVoiceAdmissionResult> {
		const { reserveVoiceUsage, VoiceCreditRefusal } =
			await import("./services/voice-billing");
		try {
			const reservationId = await reserveVoiceUsage(
				this.env,
				{ ...input, source: "operator" },
				input.attempt,
				new Date().toISOString(),
			);
			return { reservationId };
		} catch (error) {
			if (!(error instanceof VoiceCreditRefusal)) throw error;
			return {
				refusal: {
					code: error.code,
					message: error.message,
					scope: error.scope,
				},
			};
		}
	}

	async finishRuntimeVoice(
		input: import("@tedix/voice/billing").RuntimeVoiceCompletion,
	) {
		const { finishRuntimeVoiceUsage } =
			await import("./services/voice-billing");
		await finishRuntimeVoiceUsage(this.env, input);
	}

	override fetch(request: Request): Promise<Response> {
		if (
			new URL(request.url).pathname === "/__internal/identity-cache/invalidate"
		) {
			return import("./services/identity-cache-invalidation").then(
				({ invalidateIdentityCache }) =>
					invalidateIdentityCache(request, this.env),
			);
		}
		if (
			new URL(request.url).pathname ===
			"/__internal/repository-candidate-access"
		) {
			return import("./services/work-repository-candidate-access").then(
				({ repositoryCandidateAccess }) =>
					repositoryCandidateAccess(request, this.env),
			);
		}
		if (new URL(request.url).pathname === "/__internal/desktop-sign-in-code") {
			return import("./services/desktop-sign-in-code").then(
				({ desktopSignInCode }) => desktopSignInCode(request, this.env),
			);
		}
		if (
			new URL(request.url).pathname === "/__internal/workspace-session-access"
		) {
			return import("./services/os-workspace-session-access").then(
				({ workspaceSessionAccess }) =>
					workspaceSessionAccess(request, this.env),
			);
		}
		return serveFetch(request, this.env, this.ctx);
	}
}

/** Dedicated RPC capability for the workspace store; no public HTTP route. */
export class WorkspaceConnectionsEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
	async availableConnections(
		input: import("@tedix/api-contract/schemas/workspace-available-connections").WorkspaceConnectionDiscoveryInput,
	): Promise<
		import("@tedix/api-contract/schemas/workspace-available-connections").AvailableWorkspaceConnection[]
	> {
		const { readAvailableWorkspaceConnections } =
			await import("./services/workspace-available-connections");
		return readAvailableWorkspaceConnections(this.env, input);
	}

	async readLinkedAccount(
		input: import("@tedix/api-contract/schemas/workspace-connection-read").WorkspaceConnectionReadInput,
	): Promise<
		import("@tedix/api-contract/schemas/workspace-connection-read").WorkspaceConnectionReadResult
	> {
		const { readLinkedWorkspaceAccount } =
			await import("./services/workspace-connection-read");
		return readLinkedWorkspaceAccount(this.env, input);
	}

	/**
	 * Reserve credits for one workspace chat model call, on the same path the
	 * kernel and the tedi runtime use. Only the workspace object binds this
	 * entrypoint.
	 */
	async authorizeWorkspaceInference(
		input: import("@tedix/api-contract/schemas/runtime-entitlements").AuthorizeWorkspaceInferenceInput,
	): Promise<
		import("@tedix/api-contract/schemas/runtime-entitlements").AuthorizeRuntimeInferenceResponse
	> {
		const [{ AuthorizeWorkspaceInferenceInputSchema }, { createDbClient }] =
			await Promise.all([
				import("@tedix/api-contract/schemas/runtime-entitlements"),
				import("@tedix/db/client"),
			]);
		const { authorizeWorkspaceInference } =
			await import("./services/workspace-inference-admission");
		return authorizeWorkspaceInference({
			db: createDbClient(this.env.DB),
			env: this.env,
			request: AuthorizeWorkspaceInferenceInputSchema.parse(input),
		});
	}

	/** Return the hold of a workspace chat call that never used it. */
	async releaseInferenceReservation(
		input: import("@tedix/api-contract/schemas/runtime-entitlements").ReleaseInferenceReservationInput,
	): Promise<{ released: boolean }> {
		const [{ ReleaseInferenceReservationInputSchema }, { createDbClient }] =
			await Promise.all([
				import("@tedix/api-contract/schemas/runtime-entitlements"),
				import("@tedix/db/client"),
			]);
		const { releaseInferenceReservation } =
			await import("./services/workspace-inference-admission");
		return releaseInferenceReservation({
			db: createDbClient(this.env.DB),
			wallet: (await import("./lib/wallet-rpc")).walletRpc(this.env),
			request: ReleaseInferenceReservationInputSchema.parse(input),
		});
	}

	/** Record a person's tray decision on a held linked-account read. */
	async decideLinkedAccountApproval(
		input: import("@tedix/api-contract/schemas/workspace-connection-read").WorkspaceConnectionDecisionInput,
	): Promise<
		import("@tedix/api-contract/schemas/workspace-connection-read").WorkspaceConnectionDecisionResult
	> {
		const { decideLinkedWorkspaceAccountApproval } =
			await import("./services/workspace-connection-read");
		return decideLinkedWorkspaceAccountApproval(this.env, input);
	}

	/**
	 * List the organization's machines, queue a tool call for one, or read a
	 * call, for the person who sent a workspace chat turn.
	 */
	async useMachine(
		input: import("@tedix/api-contract/schemas/workspace-machine").WorkspaceMachineInput,
	): Promise<
		import("@tedix/api-contract/schemas/workspace-machine").WorkspaceMachineResult
	> {
		const { useWorkspaceMachine } =
			await import("./services/workspace-machine");
		return useWorkspaceMachine(this.env, input);
	}

	/** Publish the sender's conversation draft through the app author procedures. */
	async publishWorkspaceAppDraft(
		input: import("@tedix/api-contract/schemas/workspace-app-draft").WorkspacePublishAppDraft,
	) {
		const { publishWorkspaceAppDraft } =
			await import("./services/workspace-app-draft");
		return publishWorkspaceAppDraft(this.env, input);
	}

	/** Read personal memory only in a workspace nobody but the sender can open. */
	async readPersonMemory(
		input: import("@tedix/api-contract/schemas/workspace-person-memory").WorkspacePersonMemoryInput,
	): Promise<
		import("@tedix/api-contract/schemas/workspace-person-memory").WorkspacePersonMemoryResult
	> {
		const { readWorkspacePersonMemory } =
			await import("./services/workspace-person-memory");
		return readWorkspacePersonMemory(this.env, input);
	}
}

/** Only the MCP Worker is configured to bind this service capability. */
export class McpEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
	override fetch(request: Request): Promise<Response> {
		bindMcpServicePrincipal(request);
		return serveFetch(request, this.env, this.ctx);
	}
}

/** Cron work, inside the D1 query ledger; runs where placed-relay.ts sends it. */
async function runScheduled(
	controller: ScheduledController,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<void> {
	const [{ default: handlers }, { withD1Ledger }] = await Promise.all([
		loadApp(),
		import("@tedix/db/slow-query"),
	]);
	await withD1Ledger(`cron ${controller.cron}`, async () =>
		handlers.scheduled(controller, env, ctx),
	);
}

/** Queue work, inside the D1 query ledger; runs where placed-relay.ts sends it. */
async function runQueue(
	batch: { queue: string; messages: readonly unknown[] },
	env: CloudflareEnv,
	ctx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<void> {
	const [{ default: handlers }, { withD1Ledger }] = await Promise.all([
		loadApp(),
		import("@tedix/db/slow-query"),
	]);
	await withD1Ledger(`queue ${batch.queue}`, async () =>
		handlers.queue(batch, env, ctx),
	);
}

/**
 * Runs cron events and queue batches near D1 for `placed-relay.ts`: one of
 * PLACED_JOB_RUNNERS named objects created with a Western Europe location
 * hint. It stores nothing and only this Worker can reach it.
 */
export class PlacedJobRunner extends DurableObject<CloudflareEnv> {
	override async fetch(request: Request): Promise<Response> {
		const kind = jobKind(request);
		if (!kind) return new Response("Unknown job", { status: 404 });
		console.log(
			JSON.stringify({
				_tr: "placed_job",
				kind,
				colo: isolateColo() ?? "pending",
			}),
		);
		return serveRelay(kind, request, this.env, {
			scheduled: runScheduled,
			queue: runQueue,
		});
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
		await runScheduledPlaced(controller, env, ctx, runScheduled);
	},
	async queue(
		batch: Parameters<typeof runQueuePlaced>[0],
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<void> {
		await runQueuePlaced(batch, env, ctx, runQueue);
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
