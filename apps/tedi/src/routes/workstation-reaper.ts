/**
 * Fleet reaper for workstation container bodies nothing leases any more.
 *
 * Why it lives here and not in the apps/api cron: the Sandbox Durable Object
 * namespace is bound in this Worker. The cron in apps/api owns the schedule and
 * the D1 lease lifecycle; only this edge can name and stop a container.
 *
 * Why it is safe to stop anything at all: `listReapableWorkstationBodies`
 * returns a body only when every lease that recorded that body is terminal, and
 * only when the body was recorded rather than guessed. Stopping on a single
 * terminal lease would kill a container a still-live lease is executing in;
 * stopping a recomputed name would kill a container the lease never held. Both
 * are why no instance could be stopped by hand in production.
 *
 * Mounted before tedi resolution: a reap is fleet-scoped and has no subdomain.
 */

import { createDbClient } from "@tedix/db/client";
import { listReapableWorkstationBodies } from "@tedix/db/queries/workstations";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { Hono } from "hono";
import type { AppEnv } from "../types";

/**
 * Bounded per call. Each reap is a Durable Object round trip that tears a
 * container down, so a backlog drains over several ticks rather than holding
 * one invocation open past its time budget.
 */
const MAX_BODIES_PER_REAP = 10;

export interface WorkstationBodyReapResult {
	instanceName: string;
	leaseCount: number;
	reaped: boolean;
	error?: string;
}

const workstationReaper = new Hono<AppEnv>();

// authz: service binding only. Stopping containers is a fleet mutation; the
// scheduled caller is apps/api's workstation-lease reaper tick.
workstationReaper.post("/internal/workstation/reap", async (c) => {
	if (!isServiceBinding(c.req.raw.headers)) {
		return c.json({ ok: false, error: "Service binding required" }, 401);
	}
	if (!c.env.DB) {
		return c.json({ ok: false, error: "Database is not bound" }, 503);
	}
	const namespace = c.env.TEDI_WORKSTATION_RUNTIME_SANDBOX;
	if (!namespace) {
		return c.json(
			{ ok: false, error: "Workstation runtime is not bound" },
			503,
		);
	}

	const bodies = await listReapableWorkstationBodies(createDbClient(c.env.DB), {
		limit: MAX_BODIES_PER_REAP,
	});
	const results: WorkstationBodyReapResult[] = [];
	for (const body of bodies) {
		try {
			const sandbox = namespace.getByName(body.instanceName);
			await sandbox.destroy();
			results.push({
				instanceName: body.instanceName,
				leaseCount: body.leaseCount,
				reaped: true,
			});
		} catch (error) {
			results.push({
				error: error instanceof Error ? error.message : String(error),
				instanceName: body.instanceName,
				leaseCount: body.leaseCount,
				reaped: false,
			});
		}
	}
	// Logged on every call including zero: a reaper that silently stops looks
	// exactly like a fleet with nothing to reclaim.
	console.log(
		JSON.stringify({
			candidates: bodies.length,
			reaped: results.filter((result) => result.reaped).length,
			signal: "workstation.body.reaped",
		}),
	);
	return c.json({ ok: true, candidates: bodies.length, results });
});

export { workstationReaper };
