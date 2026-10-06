/**
 * Health check routes — no auth required
 */

import { Hono } from "hono";
import type { AppEnv } from "../types";

const health = new Hono<AppEnv>();

/** Bound so a wedged runtime cannot hold the edge's health check open. */
const RUNTIME_PROBE_TIMEOUT_MS = 2_000;

/**
 * The runtime's own release SHA, read over the service binding.
 *
 * `apps/tedi-runtime` declares no routes, so its `/health` is unreachable from
 * outside — which left "is the runtime carrying commit X?" answerable only by
 * inferring it from behaviour. The edge is bound to it in every environment, so
 * it can answer on the runtime's behalf.
 *
 * Never throws and never blocks: any failure degrades to "unreachable" so the
 * edge's own health signal stays independent of the runtime's.
 */
async function runtimeDeployedSha(env: AppEnv["Bindings"]): Promise<string> {
	const service = env.TEDI_RUNTIME_SERVICE;
	if (!service) return "unbound";
	try {
		const response = await service.fetch("http://tedi-runtime/health", {
			signal: AbortSignal.timeout(RUNTIME_PROBE_TIMEOUT_MS),
		});
		if (!response.ok) return "unreachable";
		const body = (await response.json()) as { deployedSha?: unknown };
		return typeof body.deployedSha === "string" ? body.deployedSha : "unknown";
	} catch {
		return "unreachable";
	}
}

// authz: public — liveness and release signal for uptime checks and deploy
// verification. Reports only the environment name and two release SHAs; no
// tenant, identity, or configuration data crosses this boundary.
health.get("/health", async (c) => {
	return c.json({
		status: "ok",
		service: "tedi",
		env: c.env.ENVIRONMENT,
		// The release SHA this Worker is running.
		deployedSha: String(c.env.GIT_SHA || "unknown"),
		// The runtime deploys on its own cadence and can lag this Worker, so it
		// gets its own field rather than being folded into the one above.
		runtimeDeployedSha: await runtimeDeployedSha(c.env),
	});
});

export { health };
