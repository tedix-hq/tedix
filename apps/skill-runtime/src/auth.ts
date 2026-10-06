/**
 * Inbound auth for skill-runtime.
 *
 * skill-runtime is an internal-only Worker — it's invoked from apps/api
 * (and apps/mcp via cognitive.skills.runWorkflow). External traffic is
 * rejected. Two acceptable shapes:
 *
 *  1. Cloudflare service-binding fetch (`X-Service-Binding: true`, honored
 *     only on the InternalEntrypoint; public ingress strips it).
 *  2. Bearer token equal to `env.PLATFORM_SERVICE_TOKEN` (used during
 *     local dev where service bindings aren't always wired up).
 */

import {
	extractBearerToken,
	isServiceBinding,
	secureEqual,
} from "@tedix/worker-kit/request-auth";

export async function isAuthenticated(
	request: Request,
	platformServiceToken: string,
): Promise<boolean> {
	const headers = request.headers;
	if (isServiceBinding(headers)) {
		return true;
	}

	return secureEqual(
		extractBearerToken(headers.get("Authorization")),
		platformServiceToken,
	);
}
