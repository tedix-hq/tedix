import { isLoopbackHostname, LOCAL_DEMO_TOKEN } from "@tedix/auth/local-demo";
import type { ProxyOptions } from "vite";

/**
 * Build the product-evaluation proxy used only by the root local launcher.
 * The deterministic local credential must never be forwarded off the machine.
 */
export function localApiProxyOptions(
	rawTarget: string | undefined,
): ProxyOptions | undefined {
	const value = rawTarget?.trim();
	if (!value) return undefined;

	const target = new URL(value);
	if (
		target.protocol !== "http:" ||
		!isLoopbackHostname(target.hostname) ||
		target.username ||
		target.password ||
		target.pathname !== "/" ||
		target.search ||
		target.hash
	) {
		throw new Error(
			"TEDIX_LOCAL_API_PROXY_URL must be an HTTP loopback origin with no credentials or path",
		);
	}

	return {
		target: target.origin,
		changeOrigin: true,
		headers: { authorization: `Bearer ${LOCAL_DEMO_TOKEN}` },
		rewrite: (path) => path.replace(/^\/api(?=\/|$)/, "") || "/",
	};
}
