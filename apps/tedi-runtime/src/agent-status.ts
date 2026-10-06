import { isServiceBinding } from "@tedix/worker-kit/request-auth";

export interface AgentStatusTedi {
	id: string;
	isolateAgentId: string;
	orgId: string | null;
	slug: string;
}

export interface AgentHealthProbe {
	body: unknown;
	error?: string;
	ms: number;
	ok: boolean;
	status: number;
}

export function buildAgentHealthRequest(
	request: Request,
	tedi: AgentStatusTedi,
): Request {
	const healthUrl = new URL(request.url);
	healthUrl.pathname = "/health";
	healthUrl.search = "";

	const headers = new Headers(request.headers);
	headers.set("X-Tedi-Id", tedi.id);
	if (tedi.orgId) headers.set("X-Tedi-Org-Id", tedi.orgId);
	headers.set("X-Tedi-Slug", tedi.slug);

	return new Request(healthUrl.toString(), {
		headers,
		method: "GET",
	});
}

export function parseAgentHealthBody(text: string): unknown {
	if (!text.startsWith("{") && !text.startsWith("[")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export type CronSyncEdgeDecision =
	| "not_cron_sync"
	| "deny_internal_path"
	| "method_not_allowed"
	| "forbidden"
	| "forward";

/**
 * Classify the cron projection repair before the generic Worker-to-DO
 * passthrough. The canonical DO path is private to an already-authorized
 * service-binding forward and must never be addressable by public ingress.
 */
export function cronSyncEdgeDecision(request: Request): CronSyncEdgeDecision {
	const path = new URL(request.url).pathname;
	if (path === "/__internal/cron/sync") return "deny_internal_path";
	if (path !== "/api/cron/sync") return "not_cron_sync";
	if (request.method !== "POST") return "method_not_allowed";
	return isServiceBinding(request.headers) ? "forward" : "forbidden";
}

/** The config refresh alias is private to the platform service binding. */
export function configRefreshEdgeDecision(
	request: Request,
): Exclude<CronSyncEdgeDecision, "not_cron_sync"> | "not_config_refresh" {
	const path = new URL(request.url).pathname;
	if (path === "/__internal/config/refresh") return "deny_internal_path";
	if (path !== "/api/admin/invalidate-config") return "not_config_refresh";
	if (request.method !== "POST") return "method_not_allowed";
	return isServiceBinding(request.headers) ? "forward" : "forbidden";
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function agentStatusPayload(
	tedi: AgentStatusTedi,
	health: AgentHealthProbe,
) {
	const healthBody = record(health.body);
	const ready = health.ok;
	const recentTurnCount =
		typeof healthBody.recentTurnCount === "number"
			? healthBody.recentTurnCount
			: 0;
	return {
		apiBaseUrl: null,
		osBaseUrl: null,
		diskUsage: null,
		exposedPorts: [],
		codeContexts: [],
		health: {
			status: health.ok ? "healthy" : "unhealthy",
			httpStatus: health.status,
			ms: health.ms,
			...(health.error ? { error: health.error } : {}),
		},
		mcpBaseUrl: null,
		ok: ready,
		processId: tedi.isolateAgentId,
		processSummary: {
			gatewayLiveCount: ready ? 1 : 0,
			historyCount: recentTurnCount,
			liveCount: ready ? 1 : 0,
			runningCount: ready ? 1 : 0,
			terminalCount: 0,
		},
		processes: ready
			? [
					{
						command: "agent-runtime",
						id: tedi.isolateAgentId,
						status: "running",
					},
				]
			: [],
		processTracking: { mode: "agent-runtime" },
		readiness: {
			failing: ready ? [] : ["agent_do_health"],
			httpStatus: health.status,
			ready,
		},
		runtimeBaseUrl: null,
		runtimeKind: "agent",
		service: "tedi-runtime-agent",
		slug: tedi.slug,
		status: ready ? "running" : "starting",
		tediId: tedi.id,
		watchersStartedInWorker: true,
	};
}

export function agentWakePayload(
	tedi: AgentStatusTedi,
	health: AgentHealthProbe,
	waitMs: number,
) {
	const ready = health.ok;
	return {
		attempts: 1,
		message: ready
			? "Agent runtime is reachable."
			: (health.error ?? `Agent runtime health returned ${health.status}.`),
		processId: tedi.isolateAgentId,
		ready,
		recoveredBySandboxReset: false,
		restoredFromBackup: false,
		status: ready ? "running" : "starting",
		success: ready,
		waitMs,
		woke: !health.error,
	};
}
