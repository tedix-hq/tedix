import { Hono } from "hono";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import type { AppEnv } from "../types";

// Workspace hosts have no tedi slug. Resolve their signed scope in the runtime,
// before the ordinary edge middleware tries to resolve a tedi from the host.
export const workspaceAppRuntime = new Hono<AppEnv>();
workspaceAppRuntime.post("/__internal/workspace-app/call", async (c) => {
	if (!isServiceBinding(c.req.raw.headers)) return c.text("Forbidden", 403);
	if (!c.env.TEDI_RUNTIME_SERVICE)
		return c.text("App runtime unavailable", 503);
	return c.env.TEDI_RUNTIME_SERVICE.fetch(c.req.raw);
});
