/**
 * Bun HTTP server mounting the conformance fixture through Tedix's own
 * `mountMcp()` stateless transport (packages/mcp/src/transport.ts).
 *
 * Run directly (`PORT=3921 bun conformance/serve.ts`) or via
 * `bun conformance/run.ts`, which starts it, runs the official
 * `@modelcontextprotocol/conformance` CLI against it, and tears it down.
 */
import {
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse,
} from "@modelcontextprotocol/server";
import { mountMcp } from "../src/transport";
import { buildFixture } from "./fixture";

const port = Number(process.env.PORT ?? "3921");

Bun.serve({
	port,
	async fetch(request: Request): Promise<Response> {
		// DNS-rebinding protection for local serving (the conformance
		// dns-rebinding-protection scenario): reject non-localhost Host/Origin.
		const rejectedHost = hostHeaderValidationResponse(
			request,
			localhostAllowedHostnames(),
		);
		if (rejectedHost) return rejectedHost;
		const rejectedOrigin = originValidationResponse(
			request,
			localhostAllowedOrigins(),
		);
		if (rejectedOrigin) return rejectedOrigin;

		// Fresh McpServer per request — the production `mountMcp()` contract.
		const { server, options } = buildFixture();
		return mountMcp(server, request, options);
	},
});

console.log(`conformance fixture listening on http://localhost:${port}/mcp`);
