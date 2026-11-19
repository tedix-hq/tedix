import type { Hono } from "hono";

export function registerMachineRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	/**
	 * A machine opens its connection for tool calls here. Outside the `/rpc/*`
	 * and `/v1/*` rate limits on purpose: one upgrade stays open for hours.
	 */
	// authz: public the handler accepts only a signed, one-minute ticket that a checked claim returned
	app.get("/machines/connect", async (c) => {
		const { handleMachineConnect } =
			await import("../services/machine-connection-route");
		return handleMachineConnect(c.req.raw, c.env);
	});
}
