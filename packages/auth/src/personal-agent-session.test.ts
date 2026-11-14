import { describe, expect, it, vi } from "vite-plus/test";
import {
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	SignJWT,
	type JWK,
} from "jose";
import { createPersonalAgentSessionVerifier } from "./personal-agent-session";

const clientId = "https://agent.example/agent.json";
const audience = "https://company.example";
const resource = "https://api.example/mcp";
const now = 1_800_000_000;

async function fixture(algorithm = "ES256") {
	const root = await generateKeyPair(algorithm, { extractable: true });
	const delegated = await generateKeyPair("ES256", { extractable: true });
	const rootJwk = {
		...(await exportJWK(root.publicKey)),
		kid: "root",
		alg: algorithm,
	};
	const delegatedJwk = await exportJWK(delegated.publicKey);
	const kid = await calculateJwkThumbprint(delegatedJwk);
	let clock = now * 1000;
	const fetchFn = vi.fn(async (url: string, _init?: RequestInit) =>
		Response.json(
			url === clientId
				? { client_id: clientId, jwks_uri: "https://agent.example/jwks.json" }
				: { keys: [rootJwk] },
		),
	);
	const verify = createPersonalAgentSessionVerifier({
		fetchFn,
		now: () => clock,
	});
	async function token(
		p: {
			claims?: Record<string, unknown>;
			header?: Record<string, unknown>;
			grant?: Record<string, unknown>;
			grantHeader?: Record<string, unknown>;
			key?: JWK;
			rotate?: boolean;
		} = {},
	) {
		const signer = p.rotate
			? await generateKeyPair("ES256", { extractable: true })
			: delegated;
		const signerJwk = p.rotate
			? await exportJWK(signer.publicKey)
			: delegatedJwk;
		const delegation = await new SignJWT({
			iss: clientId,
			iat: now,
			exp: now + 3600,
			jti: "grant-1",
			cnf: { jwk: p.key ?? signerJwk },
			...p.grant,
		})
			.setProtectedHeader({
				alg: algorithm,
				typ: "poppy-delegation+jwt",
				kid: "root",
				...p.grantHeader,
			})
			.sign(root.privateKey);
		return new SignJWT({
			iss: clientId,
			aud: audience,
			sid: "session-1",
			sub: "user-1",
			htm: "GET",
			htu: resource,
			iat: now,
			jti: "request-1",
			...p.claims,
		})
			.setProtectedHeader({
				alg: "ES256",
				typ: "poppy-session+jwt",
				kid: p.rotate ? await calculateJwkThumbprint(signerJwk) : kid,
				poppy_dlg: delegation,
				...p.header,
			})
			.sign(signer.privateKey);
	}
	function request(jwt: string, headers: Record<string, string> = {}) {
		return new Request(`${resource}?page=2`, {
			headers: { "Poppy-Version": "1.0", "Poppy-Session": jwt, ...headers },
		});
	}
	return {
		verify,
		fetchFn,
		token,
		request,
		delegatedJwk,
		rootJwk,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("personal agent Session verification", () => {
	it("permits delegated-key replacement without changing Session identity", async () => {
		const f = await fixture();
		const first = await f.verify({
			request: f.request(await f.token()),
			audience,
		});
		const second = await f.verify({
			request: f.request(await f.token({ rotate: true })),
			audience,
		});
		expect(second).toEqual(first);
	});
	it("rejects a forged Session signature", async () => {
		const f = await fixture();
		const parts = (await f.token()).split(".");
		parts[2] = `${parts[2]!.startsWith("A") ? "B" : "A"}${parts[2]!.slice(1)}`;
		await expect(
			f.verify({ request: f.request(parts.join(".")), audience }),
		).rejects.toMatchObject({ code: "invalid_session" });
	});
	it("accepts a newly published root kid after refreshing keys", async () => {
		const f = await fixture();
		await f.verify({ request: f.request(await f.token()), audience });
		f.fetchFn.mockImplementation(async (url: string) =>
			Response.json(
				url === clientId
					? { client_id: clientId, jwks_uri: "https://agent.example/jwks.json" }
					: { keys: [{ ...f.rootJwk, kid: "rotated" }] },
			),
		);
		f.advance(30_000);
		await expect(
			f.verify({
				request: f.request(await f.token({ grantHeader: { kid: "rotated" } })),
				audience,
			}),
		).resolves.toMatchObject({ clientId });
		expect(f.fetchFn).toHaveBeenCalledTimes(4);
	});
	it.each(["ES256", "PS384"])(
		"accepts %s delegations and caches metadata and keys",
		async (alg) => {
			const f = await fixture(alg);
			const result = await f.verify({
				request: f.request(await f.token()),
				audience,
			});
			expect(result).toEqual({
				clientId,
				sessionId: "session-1",
				userId: "user-1",
				agentId: undefined,
				version: "1.0",
			});
			await f.verify({ request: f.request(await f.token()), audience });
			expect(f.fetchFn).toHaveBeenCalledTimes(2);
			expect(f.fetchFn.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
		},
	);
	it.each([
		{ claims: { aud: [audience] } },
		{ claims: { aud: `${audience}/` } },
		{ claims: { htm: "POST" } },
		{ claims: { htu: `${resource}?page=2` } },
		{ claims: { iat: now - 61 } },
		{ claims: { iat: now + 61 } },
		{ claims: { sub: undefined } },
		{ claims: { sid: undefined } },
		{ claims: { ath: "unexpected" } },
		{ header: { typ: "JWT" } },
		{ header: { kid: "wrong" } },
		{ header: { poppy_dlg: undefined } },
		{ grant: { exp: now - 1 } },
		{ grant: { exp: now + 86401 } },
		{ grant: { iss: "https://other.example/agent.json" } },
		{ grantHeader: { typ: "JWT" } },
		{ grantHeader: { kid: "unknown" } },
	])("rejects a malformed or misbound signed token: %j", async (mutation) => {
		const f = await fixture();
		await expect(
			f.verify({ request: f.request(await f.token(mutation)), audience }),
		).rejects.toMatchObject({
			code: "invalid_session",
			message: "invalid_session",
		});
	});
	it("rejects private delegated keys and never exposes fetched error bodies", async () => {
		const f = await fixture();
		await expect(
			f.verify({
				request: f.request(
					await f.token({ key: { ...f.delegatedJwk, d: "private" } }),
				),
				audience,
			}),
		).rejects.toMatchObject({ message: "invalid_session" });
		f.fetchFn.mockImplementationOnce(
			async () => new Response("sensitive upstream error", { status: 500 }),
		);
		f.advance(5 * 60_000);
		await expect(
			f.verify({ request: f.request(await f.token()), audience }),
		).rejects.toMatchObject({ message: "invalid_session" });
	});
	it("checks version and policy before fetching any client-chosen URL", async () => {
		const f = await fixture();
		const jwt = await f.token();
		for (const version of ["", "0.4", "2.0", "1.0.0"]) {
			await expect(
				f.verify({
					request: f.request(jwt, { "Poppy-Version": version }),
					audience,
				}),
			).rejects.toMatchObject({ code: "version_unsupported" });
		}
		for (const policy of [
			{ allowedClientIds: [] },
			{ blockedClientIds: [clientId] },
		]) {
			await expect(
				f.verify({ request: f.request(jwt), audience, policy }),
			).rejects.toMatchObject({ code: "invalid_session" });
		}
		expect(f.fetchFn).not.toHaveBeenCalled();
	});
	it("binds ath to a separately validated token and its client", async () => {
		const f = await fixture();
		const value = "fictional-access-token";
		const ath = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		).toString("base64url");
		const request = f.request(await f.token({ claims: { ath } }), {
			Authorization: `Bearer ${value}`,
		});
		await expect(
			f.verify({ request, audience, accessToken: { value, clientId } }),
		).resolves.toMatchObject({ clientId });
		await expect(
			f.verify({
				request,
				audience,
				accessToken: { value, clientId: "other-client" },
			}),
		).rejects.toMatchObject({ code: "invalid_session" });
		await expect(f.verify({ request, audience })).rejects.toMatchObject({
			code: "invalid_session",
		});
	});
	it("bounds metadata size, blocks private URLs and refuses redirects", async () => {
		for (const response of [
			new Response("x".repeat(65537)),
			new Response(null, {
				status: 302,
				headers: { Location: "https://redirect.example/agent.json" },
			}),
			Response.json({
				client_id: clientId,
				jwks_uri: "https://127.0.0.1/jwks",
			}),
			Response.json({
				client_id: clientId,
				jwks_uri: "https://other.example/jwks",
			}),
		]) {
			const f = await fixture();
			f.fetchFn.mockImplementation(async () => response);
			await expect(
				f.verify({ request: f.request(await f.token()), audience }),
			).rejects.toMatchObject({ code: "invalid_session" });
			expect(f.fetchFn).toHaveBeenCalledTimes(1);
		}
	});
	it("refetches unknown kids after cooldown, without letting random kids amplify fetches", async () => {
		const f = await fixture();
		await f.verify({ request: f.request(await f.token()), audience });
		const unknown = await f.token({ grantHeader: { kid: "rotated" } });
		await expect(
			f.verify({ request: f.request(unknown), audience }),
		).rejects.toMatchObject({ code: "invalid_session" });
		expect(f.fetchFn).toHaveBeenCalledTimes(2);
		f.advance(30_000);
		await expect(
			f.verify({ request: f.request(unknown), audience }),
		).rejects.toMatchObject({ code: "invalid_session" });
		expect(f.fetchFn).toHaveBeenCalledTimes(4);
		await expect(
			f.verify({ request: f.request(unknown), audience }),
		).rejects.toMatchObject({ code: "invalid_session" });
		expect(f.fetchFn).toHaveBeenCalledTimes(4);
	});
});
