/**
 * `controlPlane.listPlatformCronHealth` returns TEDIX's own infrastructure:
 * every platform cron id, its cadence and freshness SLO, the raw error string
 * of its last failed fire, and a deep link into the Tedix Cloudflare account.
 * `platform_cron_executions` carries no org column, so the handler cannot scope
 * the result by tenant — the guard IS the boundary.
 *
 * It shipped on `AUTHZ.analyticsRead` (an ordinary tenant permission) behind a
 * bare `requireOrgId`, which asserts the caller HAS an org and scopes nothing.
 * Every tenant's Automation page therefore rendered our fleet. Reference
 * identity on the middleware chain is what freezes the correction: a future
 * edit that swaps the guard back to any tenant-reachable plane fails here.
 */

import { Procedure, unlazyRouter } from "@orpc/server";
import { describe, expect, it } from "vite-plus/test";
import { AUTHZ } from "../orpc";
import { apiRouter } from "./index";

async function middlewaresOf(
	namespace: string,
	name: string,
): Promise<unknown[]> {
	const flat = (await unlazyRouter(apiRouter)) as Record<
		string,
		Record<string, unknown>
	>;
	const procedure = flat[namespace]?.[name];
	if (!(procedure instanceof Procedure)) {
		throw new Error(`${namespace}.${name} is not a procedure`);
	}
	const internal = (
		procedure as unknown as {
			"~orpc": { orderedMiddlewares?: Array<{ middleware: unknown }> };
		}
	)["~orpc"];
	return (internal.orderedMiddlewares ?? []).map((entry) => entry.middleware);
}

describe("platform cron health authority", () => {
	it("is guarded by platform authority, not a tenant permission", async () => {
		const middlewares = await middlewaresOf(
			"controlPlane",
			"listPlatformCronHealth",
		);

		expect(middlewares).toContain(AUTHZ.platformAdmin);
		expect(middlewares).not.toContain(AUTHZ.analyticsRead);
	}, 120_000);
});
