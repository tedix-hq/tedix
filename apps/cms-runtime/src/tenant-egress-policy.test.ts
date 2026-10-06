import { describe, expect, it } from "vite-plus/test";
import { RPCSerializer } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
	cmsEditorProposalFetchRequest,
	descopeJwksFetchRequest,
	isConfiguredDescopeJwksRequest,
	tenantEgressDecision,
} from "./tenant-egress-policy";

const config = {
	baseUrl: "https://auth.tedix.dev",
	projectId: "P-test_123",
};
const jwksUrl = "https://auth.tedix.dev/P-test_123/.well-known/jwks.json";

describe("CMS tenant Descope JWKS egress", () => {
	it("allows only the configured identity key endpoint", () => {
		expect(isConfiguredDescopeJwksRequest(new Request(jwksUrl), config)).toBe(
			true,
		);
		expect(tenantEgressDecision(jwksUrl).decision).toBe("deny");
	});

	it("denies adjacent methods, paths, queries, ports, and hosts", () => {
		for (const [url, method] of [
			[jwksUrl, "POST"],
			["https://auth.tedix.dev/P-test_123/.well-known/jwks.json?x=1", "GET"],
			["https://auth.tedix.dev/P-test_123/.well-known/jwks.json/", "GET"],
			["https://auth.tedix.dev/P-other/.well-known/jwks.json", "GET"],
			["https://auth.tedix.dev:8443/P-test_123/.well-known/jwks.json", "GET"],
			["https://api.tedix.dev/P-test_123/.well-known/jwks.json", "GET"],
			[
				"https://auth.tedix.dev@evil.example/P-test_123/.well-known/jwks.json",
				"GET",
			],
		] as const) {
			expect(
				isConfiguredDescopeJwksRequest(new Request(url, { method }), config),
				`${method} ${url}`,
			).toBe(false);
		}
	});

	it("fails closed on missing or unsafe identity configuration", () => {
		const request = new Request(jwksUrl);
		for (const badConfig of [
			{ baseUrl: undefined, projectId: "P-test_123" },
			{ baseUrl: config.baseUrl, projectId: undefined },
			{ baseUrl: "https://api.tedix.dev", projectId: "P-test_123" },
			{ baseUrl: "http://auth.tedix.dev", projectId: "P-test_123" },
			{ baseUrl: "https://auth.tedix.dev:8443", projectId: "P-test_123" },
			{ baseUrl: config.baseUrl, projectId: "../other" },
		]) {
			expect(isConfiguredDescopeJwksRequest(request, badConfig)).toBe(false);
		}
	});

	it("removes tenant credentials and refuses redirect following", () => {
		const request = descopeJwksFetchRequest(
			new Request(jwksUrl, {
				headers: {
					Authorization: "Bearer tenant-secret",
					Cookie: "DS=tenant-session",
					"X-Tenant-Header": "untrusted",
				},
			}),
		);
		expect(request.method).toBe("GET");
		expect(request.redirect).toBe("manual");
		expect([...request.headers]).toEqual([["accept", "application/json"]]);
	});
});

const proposalUrl = "https://api.tedix.dev/rpc/sites/proposeCmsEditorDraft";
const siteId = "61da1321-315f-48f5-8774-63c48c682755";
const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJlZGl0b3IifQ.signature";
const proposal = {
	siteId,
	action: "rewrite",
	draft: {
		collection: "pages",
		entryId: "homepage",
		locale: "de",
		baseRevision: "revision-1",
		invocationId: "invocation-123456",
		fields: { title: "Entwurf", meta_description: "Noch nicht gespeichert" },
	},
};

function proposalRequest(input: unknown = proposal, headers = {}) {
	return new Request(proposalUrl, {
		method: "POST",
		body: JSON.stringify(new RPCSerializer().serialize(input)),
		headers: {
			Authorization: `Bearer ${jwt}`,
			"Content-Type": "application/json",
			...headers,
		},
	});
}

describe("CMS native editor proposal egress", () => {
	it("accepts the official RPCLink request and forwards its original body with only safe headers", async () => {
		let nativeRequest: Request | undefined;
		const link = new RPCLink({
			origin: "https://api.tedix.dev",
			url: "/rpc",
			headers: {
				Authorization: `Bearer ${jwt}`,
				Cookie: "DS=private-session",
				"X-API-Key": "service-secret",
				"X-Tenant-Header": "untrusted",
			},
			fetch: async (url, init) => {
				nativeRequest = new Request(url, init);
				return Response.json(new RPCSerializer().serialize({ ok: true }));
			},
		});
		await link.call(["sites", "proposeCmsEditorDraft"], proposal, {
			context: {},
		});
		expect(nativeRequest).toBeDefined();
		const originalBody = await nativeRequest!.clone().text();
		const forwarded = await cmsEditorProposalFetchRequest(
			nativeRequest!,
			siteId,
		);
		expect(forwarded).not.toBeNull();
		expect(forwarded!.url).toBe(proposalUrl);
		expect(forwarded!.method).toBe("POST");
		expect(forwarded!.redirect).toBe("manual");
		expect(await forwarded!.text()).toBe(originalBody);
		expect([...forwarded!.headers]).toEqual([
			["accept", "application/json"],
			["authorization", `Bearer ${jwt}`],
			["content-type", "application/json"],
		]);
		// There is no general API host exemption.
		expect(tenantEgressDecision(proposalUrl).decision).toBe("deny");
	});

	it("denies other methods, destinations, paths, queries, fragments and ports", async () => {
		for (const [url, method] of [
			[proposalUrl, "GET"],
			[proposalUrl, "PUT"],
			[proposalUrl.replace("https:", "http:"), "POST"],
			[proposalUrl.replace("api.tedix.dev", "other.tedix.dev"), "POST"],
			[
				proposalUrl.replace("api.tedix.dev", "api.tedix.dev.evil.example"),
				"POST",
			],
			[`${proposalUrl}?x=1`, "POST"],
			[`${proposalUrl}#fragment`, "POST"],
			[`${proposalUrl}/`, "POST"],
			[proposalUrl.replace("proposeCmsEditorDraft", "delete"), "POST"],
			[proposalUrl.replace("api.tedix.dev", "api.tedix.dev:8443"), "POST"],
			[
				proposalUrl.replace("api.tedix.dev", "api.tedix.dev@evil.example"),
				"POST",
			],
			[
				proposalUrl.replace("api.tedix.dev", "user:secret@api.tedix.dev"),
				"POST",
			],
		] as const) {
			expect(
				await cmsEditorProposalFetchRequest(
					new Request(url, { method }),
					siteId,
				),
				url,
			).toBeNull();
		}
	});

	it("requires a JWT bearer and unencoded JSON without accepting service credentials", async () => {
		for (const headers of [
			{ Authorization: "" },
			{ Authorization: "Bearer sk_service_key" },
			{ Authorization: "Basic credential" },
			{ "Content-Type": "text/plain" },
			{ "Content-Encoding": "gzip" },
		]) {
			expect(
				await cmsEditorProposalFetchRequest(
					proposalRequest(proposal, headers),
					siteId,
				),
			).toBeNull();
		}
	});

	it("rejects different sites and malformed or schema-invalid native inputs", async () => {
		for (const input of [
			{ ...proposal, siteId: "33715a56-b377-4b4d-a1ec-dc58868c4df7" },
			{ ...proposal, action: "publish" },
			{ ...proposal, actorId: "forged-editor" },
			{ ...proposal, action: "translate" },
			{ ...proposal, draft: { ...proposal.draft, baseRevision: "" } },
			{
				...proposal,
				draft: { ...proposal.draft, fields: { title: "x".repeat(49 * 1024) } },
			},
		]) {
			expect(
				await cmsEditorProposalFetchRequest(proposalRequest(input), siteId),
			).toBeNull();
		}
		for (const body of ["{", "null", JSON.stringify(proposal)]) {
			const request = new Request(proposalRequest(), { body });
			expect(await cmsEditorProposalFetchRequest(request, siteId)).toBeNull();
		}
	});

	it("bounds streamed bytes even when the declared length is small", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(32 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		});
		const request = new Request(
			proposalRequest(proposal, { "Content-Length": "1" }),
			{ body },
		);
		expect(await cmsEditorProposalFetchRequest(request, siteId)).toBeNull();
		expect(cancelled).toBe(true);
	});

	it("rejects declared oversize before consuming the body", async () => {
		const request = proposalRequest(proposal, {
			"Content-Length": String(64 * 1024 + 1),
		});
		expect(await cmsEditorProposalFetchRequest(request, siteId)).toBeNull();
		expect(request.bodyUsed).toBe(false);
	});
});
