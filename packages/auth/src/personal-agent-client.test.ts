import { describe, expect, it, vi } from "vite-plus/test";
import { exportJWK, generateKeyPair } from "jose";
import {
	createPersonalAgentClient,
	PersonalAgentClientError,
	SIMULATED_PERSONAL_AGENT_IDENTITIES,
	type PersonalAgentIdentity,
} from "./personal-agent-client";
import { createPersonalAgentSessionVerifier } from "./personal-agent-session";

const clientId = "https://agent.example/agent.json";
const company = "https://company.example";
const mcpUrl = "https://mcp.example.com/mcp";
const now = 1_800_000_000;

const discoveryDocument = {
	protocol_version: "1.0",
	organization: { name: "Example Company", domain: "company.example" },
	auth: { disabled: true },
	agent: {
		protocols: [
			{
				type: "poppy",
				endpoint: "https://mcp.example.com/mcp/poppy/conversations",
				description: "Company agent",
			},
		],
	},
	apis: [{ type: "mcp", url: mcpUrl, description: "Shared work" }],
};

async function fixture() {
	const root = await generateKeyPair("ES256", { extractable: true });
	const rootJwk = await exportJWK(root.privateKey);
	let clock = now * 1000;
	const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
		if (url === clientId)
			return Response.json({
				client_id: clientId,
				jwks_uri: "https://agent.example/jwks.json",
			});
		if (url === "https://agent.example/jwks.json")
			return Response.json({ keys: [] });
		if (url === `${company}/.well-known/poppy.json`)
			return Response.json(discoveryDocument);
		return new Response("not found", { status: 404 });
	});
	// The verifier fetches the client's published keys; serve the real public
	// JWK once the client has loaded its key material.
	const verifierFetch = vi.fn(async (url: string, init?: RequestInit) => {
		if (url === "https://agent.example/jwks.json") {
			const jwks = await client.jwks();
			return Response.json(jwks);
		}
		return fetchFn(url, init);
	});
	const client = createPersonalAgentClient({
		clientId,
		signingKey: rootJwk,
		fetchFn,
		now: () => clock,
	});
	const verify = createPersonalAgentSessionVerifier({
		fetchFn: verifierFetch,
		now: () => clock,
	});
	return {
		client,
		verify,
		rootJwk,
		fetchFn,
		verifierFetch,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

async function signedRequest(
	f: Awaited<ReturnType<typeof fixture>>,
	identity: PersonalAgentIdentity,
	url = `${mcpUrl}?page=2`,
	method = "POST",
) {
	const headers = await f.client.sessionHeaders({
		audience: `https://${discoveryDocument.organization.domain}`,
		url,
		method,
		identity,
	});
	return new Request(url, { method, headers });
}

describe("personal agent client", () => {
	it("publishes a client metadata document and a same-host jwks_uri", async () => {
		const f = await fixture();
		const metadata = await f.client.clientMetadata();
		expect(metadata).toEqual({
			client_id: clientId,
			jwks_uri: "https://agent.example/jwks.json",
		});
		const jwks = await f.client.jwks();
		expect(jwks.keys).toHaveLength(1);
		expect(jwks.keys[0]).toMatchObject({
			kty: "EC",
			crv: "P-256",
			alg: "ES256",
			use: "sig",
		});
		expect(jwks.keys[0]).not.toHaveProperty("d");
		expect(() =>
			createPersonalAgentClient({
				clientId,
				signingKey: f.rootJwk,
				jwksUri: "https://other.example/jwks.json",
			}),
		).toThrowError(PersonalAgentClientError);
	});

	it("discovers a company's poppy.json and derives the session audience", async () => {
		const f = await fixture();
		const discovery = await f.client.discoverCompany(company);
		expect(discovery).toMatchObject({
			protocolVersion: "1.0",
			audience: "https://company.example",
			mcpUrl,
			agentUrl: "https://mcp.example.com/mcp/poppy/conversations",
			discoveryUrl: `${company}/.well-known/poppy.json`,
		});
		expect(f.fetchFn).toHaveBeenCalledWith(
			`${company}/.well-known/poppy.json`,
			expect.anything(),
		);
	});

	it("rejects company documents that are not Poppy 1.x", async () => {
		const f = await fixture();
		f.fetchFn.mockImplementation(async (url: string) =>
			url === `${company}/.well-known/poppy.json`
				? Response.json({ protocol_version: "0.4" })
				: new Response("not found", { status: 404 }),
		);
		await expect(f.client.discoverCompany(company)).rejects.toMatchObject({
			code: "invalid_company",
		});
	});

	it.each(SIMULATED_PERSONAL_AGENT_IDENTITIES.map((i) => [i.id, i] as const))(
		"mints a session the existing verifier accepts for %s",
		async (_label, identity) => {
			const f = await fixture();
			const request = await signedRequest(f, identity);
			const result = await f.verify({
				request,
				audience: "https://company.example",
			});
			expect(result).toEqual({
				clientId,
				sessionId: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
				userId: identity.userId,
				agentId: identity.agentId,
				version: "1.0",
			});
		},
	);

	it("answers an unsigned request as an invalid session", async () => {
		const f = await fixture();
		const unsigned = new Request(`${mcpUrl}?page=2`, {
			method: "POST",
			headers: { "Poppy-Version": "1.0" },
		});
		await expect(
			f.verify({ request: unsigned, audience: "https://company.example" }),
		).rejects.toMatchObject({ code: "invalid_session" });
		// No version header at all is a version failure, still not identified.
		const bare = new Request(mcpUrl, { method: "POST" });
		await expect(
			f.verify({ request: bare, audience: "https://company.example" }),
		).rejects.toMatchObject({ code: "version_unsupported" });
	});

	it("binds htu to the URL without its query and rejects a mismatched audience", async () => {
		const f = await fixture();
		const identity = SIMULATED_PERSONAL_AGENT_IDENTITIES[0]!;
		const request = await signedRequest(f, identity);
		await expect(
			f.verify({ request, audience: "https://other.example" }),
		).rejects.toMatchObject({ code: "invalid_session" });
		await expect(
			f.verify({ request, audience: "https://company.example" }),
		).resolves.toMatchObject({ clientId });
	});

	it("sends a signed call with Poppy headers and an unsigned one without", async () => {
		const f = await fixture();
		const identity = SIMULATED_PERSONAL_AGENT_IDENTITIES[1]!;
		const seen: Request[] = [];
		const callFetch = vi.fn(async (url: string, init?: RequestInit) => {
			seen.push(new Request(url, init));
			return Response.json({ ok: true });
		});
		const client = createPersonalAgentClient({
			clientId,
			signingKey: f.rootJwk,
			fetchFn: callFetch,
			now: () => now * 1000,
		});
		await client.call({
			url: `${mcpUrl}/poppy/conversations`,
			method: "POST",
			body: { id: "req-1", message: { author: { type: "agent" }, text: "Hi" } },
			identity,
			audience: "https://company.example",
		});
		await client.call({
			url: `${mcpUrl}/poppy/conversations`,
			method: "POST",
			body: { id: "req-2" },
			identity,
			audience: "https://company.example",
			signed: false,
		});
		expect(seen[0]!.headers.get("Poppy-Version")).toBe("1.0");
		expect(seen[0]!.headers.get("Poppy-Session")).toBeTruthy();
		expect(seen[1]!.headers.get("Poppy-Session")).toBeNull();
		expect(seen[1]!.headers.get("Poppy-Version")).toBeNull();
	});

	it("rejects a non-ES256 or malformed signing key", async () => {
		await expect(
			createPersonalAgentClient({
				clientId,
				signingKey: { kty: "EC", crv: "P-256", x: "x", y: "y" } as never,
			}).jwks(),
		).rejects.toBeInstanceOf(PersonalAgentClientError);
	});
});
