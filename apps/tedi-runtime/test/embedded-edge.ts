/**
 * The embedded widget capability as the runtime edge mounts it.
 *
 * `/chat/capn` hands a capability adapter to the Cap'n Web mount; this module
 * captures that adapter so a test can call each embedded operation the way the
 * widget's session does, against a signed session token, a recorded API
 * service binding and the edge harness's recorded tedi DO.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { issueGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import type { EmbeddedCapabilityAdapter } from "@tedix/chat-transport/embedded-capability";
import * as embeddedMount from "@tedix/chat-transport/embedded-mount";
import { EDGE_TEDI, edgeFetch, tediRequest } from "./tedi-edge";

// Bun's module mock, without depending on bun:test's type declarations.
const { mock } = createRequire(import.meta.url)("bun:test") as {
	mock: { module(name: string, factory: () => Record<string, unknown>): void };
};

export const captured: EmbeddedCapabilityAdapter[] = [];
mock.module("@tedix/chat-transport/embedded-mount", () => ({
	...embeddedMount,
	mountEmbeddedCapability: (
		_request: Request,
		adapter: EmbeddedCapabilityAdapter,
	) => {
		captured.push(adapter);
		return new Response("mounted");
	},
}));

export const EMBED_SECRET = "embedded-test-secret-0123456789abcdef";
export const EMBED_ORIGIN = "https://shop.example";

type Rpc = { path: string; input: Record<string, any>; headers: Headers };

/** Mount the capability for one page origin and record what it reaches. */
export async function embedded(
	answers: Record<string, (input: Record<string, any>) => unknown> = {},
	doResponse: (request: Request) => Response | Promise<Response> = () =>
		Response.json({ ok: true }),
) {
	const rpcs: Rpc[] = [];
	const env = {
		SECRETS_MASTER_KEY: EMBED_SECRET,
		API_SERVICE: {
			fetch: async (request: Request) => {
				const path = new URL(request.url).pathname.replace(/^\/rpc\//, "");
				const body = (await request.json().catch(() => ({}))) as {
					json?: Record<string, any>;
				};
				const input = body.json ?? {};
				rpcs.push({ path, input, headers: request.headers });
				const answer = answers[path];
				return Response.json({ json: answer ? await answer(input) : null });
			},
		},
	};
	const before = captured.length;
	const run = await edgeFetch(
		tediRequest("/chat/capn", { headers: { Origin: EMBED_ORIGIN } }),
		{ env, doResponse },
	);
	assert.equal(await run.response.text(), "mounted");
	assert.equal(captured.length, before + 1);
	return { adapter: captured.at(-1)!, rpcs, forwarded: run.forwarded, env };
}

export async function embeddedToken(claims: Record<string, unknown> = {}) {
	return issueGatewayBrowserToken({
		secret: EMBED_SECRET,
		tediId: EDGE_TEDI.id,
		subject: "browser-user",
		expiresAt: Math.floor(Date.now() / 1000) + 600,
		allowedOrigin: EMBED_ORIGIN,
		sessionKey: "embed:shop:1",
		hostUserId: "host-user-1",
		hostOrganizationId: "367",
		hostOrganizationLabel: "Example organization",
		...claims,
	});
}
