import type { SkillRuntimeEnv } from "./env";
import { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import { stripServiceBindingMarker } from "@tedix/worker-kit/request-auth";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { ArtifactBridge } from "./artifacts";
import { isAuthenticated } from "./auth";
import { logRuntimeFailure } from "./control-log";
import { skillRuntimeHealth } from "./health";
import { skillRunEnvironment } from "./db";
import { EvidenceBridge } from "./evidence";
import { ReasonBridge } from "./reason";
import { McpBridge } from "./mcp-bridge";
import { OutboundProxy } from "./outbound-proxy";
import { RationaleBridge } from "./rationale";
import { reconcileSkillRuns } from "./reconciler";
import { SkillWorkflow } from "./skill-workflow";
import { type AppEnv } from "./control-requests";
import { registerRunRoutes } from "./routes/run";
import { registerStatusRoutes } from "./routes/status";
import { registerLifecycleRoutes } from "./routes/lifecycle";
import { registerApprovalRoutes } from "./routes/approvals";

/**
 * @tedix/skill-runtime
 *
 * Cloudflare Worker that runs executable skill workflows in per-tenant
 * Dynamic Worker isolates with durable execution semantics
 * (`step.do/sleep/waitForEvent`).
 *
 * Entry points:
 *
 *  - POST /run     — optional idempotent runId + pinned snapshot → run handle
 *  - POST /status  — { runId } → mapped + raw engine lifecycle state
 *  - POST /pause, /resume, /restart, /cancel — native Workflow controls
 *
 * Internal-only. Auth via service binding or PLATFORM_SERVICE_TOKEN. See
 * `auth.ts`.
 *
 * Architecture:
 *
 *  - The static `SkillWorkflow` class (created via
 *    `@cloudflare/dynamic-workflows`) is bound to the Workflows runtime
 *    by the `WORKFLOWS` binding in `cloudflare.config.ts`.
 *  - On `/run` we wrap the binding with `wrapWorkflowBinding()` so the
 *    dispatcher metadata (skillId/tediId/orgId/runId) is stashed on the
 *    workflow params. The Workflow engine later invokes our static class,
 *    which uses that metadata to load the right tenant Worker via
 *    env.LOADER and forwards `run()` to it.
 *  - `DynamicWorkflowBinding` is re-exported so Cloudflare auto-registers
 *    it on the Worker's `exports` (required by `wrapWorkflowBinding`).
 *
 * @see https://blog.cloudflare.com/dynamic-workflows/
 * @see https://blog.cloudflare.com/dynamic-workers/
 */
// Required exports for Cloudflare to register dynamic-workflows, workflow engine,
// and tenant capability bridges on ctx.exports.
export {
	ArtifactBridge,
	DynamicWorkflowBinding,
	EvidenceBridge,
	McpBridge,
	OutboundProxy,
	RationaleBridge,
	ReasonBridge,
	SkillWorkflow,
};

const app = new Hono<AppEnv>();

installHonoErrorHandlers(app, { service: "skill-runtime" });

// Auth gate — every route requires an internal caller.
app.use("*", async (c, next) => {
	if (c.req.method === "GET" && c.req.path === "/health") return next();
	if (!(await isAuthenticated(c.req.raw, c.env.PLATFORM_SERVICE_TOKEN))) {
		return c.json({ error: "unauthorized" }, 401);
	}
	return next();
});

// authz: public — the app-wide gate above deliberately waves GET /health through; liveness probe only.
app.get("/health", (c) => c.json(skillRuntimeHealth(c.env)));

/**
 * POST /benchmark/drive-turn
 * Drive one native Agent-runtime turn through `/hooks/chat-stream` over the
 * TEDI_RUNTIME_SERVICE binding. First-party (not tenant-sandboxed), so it
 * runs the real `do.ts` turn and ESCAPES the 30s Code Mode executor budget the
 * external `code`-tool path hits. Buffers the SSE stream and returns the final
 * assistant reply. Foundation for the tau2-bench retail benchmark workflow.
 */
app.post("/benchmark/drive-turn", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as {
		slug?: string;
		text?: string;
		session_key?: string;
		client_request_id?: string;
	};
	const { slug, text, session_key, client_request_id } = body;
	if (!slug || !text || !session_key || !client_request_id) {
		return c.json(
			{ error: "missing slug/text/session_key/client_request_id" },
			400,
		);
	}
	const isolate = c.env.TEDI_RUNTIME_SERVICE;
	if (!isolate) {
		return c.json({ error: "TEDI_RUNTIME_SERVICE binding unavailable" }, 500);
	}
	const url = `https://tedi-runtime.internal/hooks/chat-stream?slug=${encodeURIComponent(slug)}`;
	const started = Date.now();
	const res = await isolate.fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			"X-Service-Binding": "true",
		},
		body: JSON.stringify({ session_key, text, client_request_id }),
		// SSE turns can be long; cap so a stalled stream can't wedge the request.
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok || !res.body) {
		const detail = await res.text().catch(() => "");
		return c.json(
			{ error: `chat-stream ${res.status}`, detail: detail.slice(0, 500) },
			502,
		);
	}
	// Read the SSE stream INCREMENTALLY and stop at the `done`/`error` frame —
	// the stream may not close promptly, so buffering with res.text() can hang.
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let assistant = "";
	let runId: string | null = null;
	let errMsg: string | null = null;
	let finished = false;
	try {
		while (!finished) {
			const { value, done: streamDone } = await reader.read();
			if (streamDone) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line.startsWith("data:")) continue;
				try {
					const frame = JSON.parse(line.slice(5).trim());
					if (frame.kind === "done") {
						assistant = typeof frame.text === "string" ? frame.text : assistant;
						runId = frame.runId ?? frame.sessionKey ?? runId;
						finished = true;
					} else if (frame.kind === "error") {
						errMsg = frame.message ?? "error";
						finished = true;
					}
				} catch {
					/* skip non-JSON data lines */
				}
				nl = buf.indexOf("\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (errMsg) return c.json({ error: errMsg, ms: Date.now() - started }, 502);
	return c.json({
		ok: true,
		assistant,
		run_id: runId,
		ms: Date.now() - started,
	});
});
registerRunRoutes(app);
registerStatusRoutes(app);
registerLifecycleRoutes(app);
registerApprovalRoutes(app);

/**
 * Service-binding ingress. Internal callers bind with
 * `"entrypoint": "InternalEntrypoint"`; the internet reaches only the default
 * export, which strips the `X-Service-Binding` marker, so binding trust is
 * unreachable from a public request.
 */
export class InternalEntrypoint extends WorkerEntrypoint<SkillRuntimeEnv> {
	override async fetch(request: Request): Promise<Response> {
		return app.fetch(request, this.env, this.ctx);
	}
}

export default {
	fetch: (request, env, ctx) =>
		app.fetch(stripServiceBindingMarker(request), env, ctx),
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(
			(async () => {
				try {
					const summary = await reconcileSkillRuns({
						DB: env.DB,
						WORKFLOWS: env.WORKFLOWS,
						ENVIRONMENT: skillRunEnvironment(env.ENVIRONMENT),
					});
					console.log(
						JSON.stringify({
							service: "skill-runtime",
							event: "reconciler.tick",
							ts: new Date().toISOString(),
							...summary,
						}),
					);
				} catch (err) {
					logRuntimeFailure("workflow.reconciler_tick.failed", err);
				}
			})(),
		);
	},
} satisfies ExportedHandler<SkillRuntimeEnv>;
