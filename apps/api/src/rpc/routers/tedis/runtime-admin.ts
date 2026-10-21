import { type BaseContext, getProvisioningConfig } from "./helpers";

/**
 * Fetch the isolate DO admin endpoint through the tedi edge Worker.
 *
 * Reachability: apps/api → `TEDI_SERVICE` service binding → apps/tedi edge
 * Worker → (isolate branch) forwards the raw request to apps/tedi-runtime. We
 * reuse `getProvisioningConfig`, which already carries the `TEDI_SERVICE`
 * fetcher + the canonical `{slug}.tedi.{domain}` workerUrl. Auth: the isolate
 * DO admin guard accepts `X-Tedix-Admin-Token == env.SECRETS_MASTER_KEY` (and
 * the service-binding trust shape the provisioning client already sets).
 */
export type AgentAdminFetchFailure =
	| "no_provisioning_config"
	| "secrets_master_key_unavailable"
	| "timeout"
	| "transport_failure";

export async function agentAdminFetch(
	context: BaseContext,
	tedi: { slug: string | null },
	path:
		| "/__admin/agent-diag"
		| "/__admin/pi-recovery"
		| "/__admin/dequeue"
		| "/__admin/schedules"
		| "/__admin/agent-memory/inspect"
		| "/__admin/agent-memory/delete-profile",
	options: {
		method: "GET" | "POST";
		body?: unknown;
		query?: Record<string, string | undefined>;
		timeoutMs: number;
	},
): Promise<
	| { ok: boolean; status: number; json: unknown }
	| { error: string; failure: AgentAdminFetchFailure }
> {
	const provConfig = getProvisioningConfig(tedi, context.env);
	if (!provConfig)
		return {
			error: "no_provisioning_config",
			failure: "no_provisioning_config",
		};

	const masterKey = context.env.SECRETS_MASTER_KEY;
	if (!masterKey)
		return {
			error: "secrets_master_key_unavailable",
			failure: "secrets_master_key_unavailable",
		};

	const url = new URL(`${provConfig.workerUrl.replace(/\/+$/, "")}${path}`);
	for (const [key, value] of Object.entries(options.query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Tedix-Admin-Token": masterKey,
	};
	if (provConfig.fetcher || provConfig.isDev) {
		headers["X-Service-Binding"] = "true";
	}
	if (provConfig.hostOverride) {
		headers["X-Tedix-Host"] = provConfig.hostOverride;
	}

	const fetchFn = provConfig.fetcher?.fetch.bind(provConfig.fetcher) ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await fetchFn(url.toString(), {
			method: options.method,
			headers,
			body:
				options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: controller.signal,
		});
		controller.signal.throwIfAborted();
		let json: unknown = null;
		try {
			json = await response.json();
		} catch {
			json = null;
		}
		// Body parsing can swallow an abort; the original owned deadline still wins.
		controller.signal.throwIfAborted();
		return { ok: response.ok, status: response.status, json };
	} catch (error) {
		return {
			error: controller.signal.aborted
				? `timeout_after_${options.timeoutMs}ms`
				: error instanceof Error
					? error.message
					: String(error),
			failure: controller.signal.aborted ? "timeout" : "transport_failure",
		};
	} finally {
		clearTimeout(timeout);
	}
}
