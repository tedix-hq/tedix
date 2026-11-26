import { afterEach, expect, it, vi } from "vite-plus/test";
import {
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	SignJWT,
} from "jose";
import { createPersonalAgentSessionVerifier } from "@tedix/auth/personal-agent-session";
import { checkSignedOutPersonalAgentSession } from "./personal-agent-session";
import { extractCallerIdentity } from "./mcp/server-factory";
import { ToolHandler, type ToolExecutionContext } from "./mcp/handler";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";

afterEach(() => vi.unstubAllGlobals());

it("checks each Poppy request before a signed-out agent receives connected provider results", async () => {
	const appId = "20000000-0000-4000-8000-000000000001";
	const organizationId = "10000000-0000-4000-8000-000000000001";
	const clientId = "https://agent.example/agent.json";
	const url = "https://store.example/mcp";
	const now = Math.floor(Date.now() / 1000);
	const root = await generateKeyPair("ES256");
	const delegated = await generateKeyPair("ES256", { extractable: true });
	const jwk = await exportJWK(delegated.publicKey);
	const rootJwk = {
		...(await exportJWK(root.publicKey)),
		kid: "root",
		alg: "ES256",
	};
	const delegation = await new SignJWT({
		iss: clientId,
		iat: now,
		exp: now + 3600,
		jti: "delegation",
		cnf: { jwk },
	})
		.setProtectedHeader({
			alg: "ES256",
			typ: "poppy-delegation+jwt",
			kid: "root",
		})
		.sign(root.privateKey);
	const token = await new SignJWT({
		iss: clientId,
		aud: "https://store.example",
		sid: "session-example",
		sub: "visitor-example",
		htm: "POST",
		htu: url,
		iat: now,
		jti: "request-example",
	})
		.setProtectedHeader({
			alg: "ES256",
			typ: "poppy-session+jwt",
			kid: await calculateJwkThumbprint(jwk),
			poppy_dlg: delegation,
		})
		.sign(delegated.privateKey);
	const verify = createPersonalAgentSessionVerifier({
		fetchFn: async (target) =>
			Response.json(
				target === clientId
					? { client_id: clientId, jwks_uri: "https://agent.example/jwks.json" }
					: { keys: [rootJwk] },
			),
	});
	let credentialCalls = 0;
	let sessionChecks = 0;
	const binding = {
		fetch: async (request: Request) => {
			const body = (await request.json()) as { json: Record<string, unknown> };
			if (request.url.includes("osTenant/personalAgentSession")) {
				sessionChecks++;
				try {
					const identity = await verify({
						request: new Request(String(body.json.url), {
							method: String(body.json.method),
							headers: {
								"Poppy-Session": String(body.json.sessionToken),
								"Poppy-Version": "1.0",
							},
						}),
						audience: "https://store.example",
						policy: { allowedClientIds: [clientId] },
					});
					return Response.json({ json: { status: "accepted", identity } });
				} catch {
					return Response.json({ json: { status: "invalid_session" } });
				}
			}
			expect(request.url).toContain("connections/fetchPoppyToken");
			expect(request.headers.get("X-Tedix-Auth-Poppy-App-Id")).toBe(appId);
			expect(body.json).toMatchObject({
				appId,
				organizationId,
				providerId: "example",
				toolId: "search_products",
				mcpServerUrl: "https://provider.example/mcp",
				mcpToolName: "search",
			});
			credentialCalls++;
			return Response.json({ json: { accessToken: "fixture-provider-token" } });
		},
	} as Fetcher;
	const env = { ENVIRONMENT: "test", API_SERVICE: binding } as CloudflareEnv;
	const upstream = vi.fn(async (_target: unknown, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		expect(new Headers(init.headers).get("Authorization")).toBe(
			"Bearer fixture-provider-token",
		);
		return Response.json({
			jsonrpc: "2.0",
			id: body.id,
			result:
				body.method === "server/discover"
					? {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: {} },
						}
					: {
							resultType: "complete",
							content: [
								{
									type: "text",
									text: JSON.stringify({
										products: [{ name: "Walking shoes" }],
									}),
								},
							],
						},
		});
	});
	vi.stubGlobal("fetch", upstream);
	const dispatch = async (sessionToken: string) => {
		const request = new Request(url, {
			method: "POST",
			headers: { "Poppy-Session": sessionToken, "Poppy-Version": "1.0" },
		});
		let verifiedPoppyAppId: string | undefined;
		const error = await checkSignedOutPersonalAgentSession({
			request,
			appId,
			organizationId,
			env,
			onVerified: () => {
				verifiedPoppyAppId = appId;
			},
		});
		if (error) return { status: error.status };
		const callerIdentity = extractCallerIdentity(request);
		expect(callerIdentity?.userId).toBeUndefined();
		expect(callerIdentity?.tediId).toBeUndefined();
		const context = {
			verifiedPoppyAppId,
			appId,
			app: { id: appId, slug: "store", organizationId },
			appCapabilities: {},
			env,
			config: {
				transport: "mcp",
				mcpServerUrl: "https://provider.example/mcp",
				mcpToolName: "search",
				auth: { type: "connection", connectionId: "example" },
			},
			toolId: "search_products",
			requestId: "request-example",
			callerIdentity,
		} as ToolExecutionContext<ToolConfig>;
		return new ToolHandler().execute({ query: "shoes" }, context);
	};
	await expect(dispatch(token)).resolves.toMatchObject({
		status: 200,
		data: { products: [{ name: "Walking shoes" }] },
	});
	const callsAfterSuccess = upstream.mock.calls.length;
	await expect(dispatch("invalid-token")).resolves.toEqual({ status: 400 });
	expect(sessionChecks).toBe(2);
	expect(credentialCalls).toBe(1);
	expect(upstream).toHaveBeenCalledTimes(callsAfterSuccess);
});
