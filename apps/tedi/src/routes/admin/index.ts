/**
 * Admin API routes — protected by service binding detection
 *
 * These are called by apps/api for control-plane operations via Cloudflare
 * Service Bindings. Direct HTTP access is not supported.
 */

import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { workstation } from "./workstation/router";

const admin = new Hono<AppEnv>();

// Admin routes are reachable only over a trusted service binding.
admin.use("*", async (c, next) => {
	if (isServiceBinding(c.req.raw.headers)) {
		await next();
		return;
	}

	return c.json(
		{
			error:
				"Service binding required. Direct HTTP access to admin routes is not supported.",
		},
		401,
	);
});

admin.route("/workstation", workstation);

export { admin };
