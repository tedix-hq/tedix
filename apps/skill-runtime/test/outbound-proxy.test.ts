import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
}));

const { OutboundProxy, fetchHttpOnly, hostMatches, videoAssetKey } =
	await import("../src/outbound-proxy");

type Props = {
	geminiApiKey?: string | null;
	googleServiceAccountKey?: string | null;
	organizationId?: string | null;
};

const SECRET = "platform-secret-fixture";
const GATE_URL =
	"https://video-assets.tedix.internal/verify-product-keyframe-gate";
const originalFetch = globalThis.fetch;
let calls: Request[] = [];

function installFetch(response: () => Response = () => new Response("ok")) {
	calls = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push(new Request(input as RequestInfo, init));
		return response();
	}) as typeof fetch;
}

function proxy(props: Props = { geminiApiKey: SECRET }) {
	const instance = new OutboundProxy({} as never, {} as never);
	Object.assign(instance, { ctx: { props }, env: {} });
	return instance;
}

beforeEach(() => installFetch());
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("hostMatches", () => {
	it("matches the exact host and true subdomains", () => {
		expect(hostMatches("example.com", "example.com")).toBe(true);
		expect(hostMatches("a.b.example.com", "example.com")).toBe(true);
	});

	it("refuses look-alike, prefix, trailing-dot and case-variant hosts", () => {
		expect(hostMatches("evil-example.com", "example.com")).toBe(false);
		expect(hostMatches("example.com.evil.com", "example.com")).toBe(false);
		expect(hostMatches("xexample.com", "example.com")).toBe(false);
		expect(hostMatches("example.com.", "example.com")).toBe(false);
		// Callers lowercase first; the helper itself is case-sensitive.
		expect(hostMatches("EXAMPLE.com", "example.com")).toBe(false);
		expect(hostMatches("", "example.com")).toBe(false);
	});
});

describe("videoAssetKey", () => {
	it("is tenant-scoped: two organizations never collide", () => {
		const a = videoAssetKey("org_a", "asset-1");
		const b = videoAssetKey("org_b", "asset-1");
		expect(a).not.toBe(b);
		expect(a).toBe("video-assets/org_a/asset-1/source.mp4");
	});
});

describe("fetchHttpOnly", () => {
	it("passes plain responses through", async () => {
		const response = await fetchHttpOnly(new Request("https://example.com/"));
		expect(await response.text()).toBe("ok");
	});

	it("closes and rejects an upstream websocket upgrade", async () => {
		const close = mock(() => {});
		installFetch(() => ({ webSocket: { close } }) as unknown as Response);
		await expect(
			fetchHttpOnly(new Request("https://example.com/")),
		).rejects.toThrow("WORKFLOW_WEBSOCKET_DISABLED");
		expect(close).toHaveBeenCalled();
	});
});

describe("OutboundProxy.fetch", () => {
	it("refuses websocket upgrades without any upstream fetch", async () => {
		await expect(
			proxy().fetch(
				new Request("https://generativelanguage.googleapis.com/ws", {
					headers: { upgrade: "websocket" },
				}),
			),
		).rejects.toThrow("WORKFLOW_WEBSOCKET_DISABLED");
		await expect(
			proxy().fetch(
				new Request("https://example.com/", {
					headers: { "sec-websocket-key": "abc" },
				}),
			),
		).rejects.toThrow("WORKFLOW_WEBSOCKET_DISABLED");
		expect(calls).toHaveLength(0);
	});

	it("injects the platform key for AI Studio and strips tenant ?key=", async () => {
		await proxy().fetch(
			new Request(
				"https://generativelanguage.googleapis.com/v1/models?key=tenant&x=1",
			),
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.headers.get("x-goog-api-key")).toBe(SECRET);
		const url = new URL(calls[0]!.url);
		expect(url.searchParams.has("key")).toBe(false);
		expect(url.searchParams.get("x")).toBe("1");
		expect(calls[0]!.redirect).toBe("manual");
	});

	it("keeps a tenant-supplied x-goog-api-key instead of overriding it", async () => {
		await proxy().fetch(
			new Request("https://generativelanguage.googleapis.com/v1/models", {
				headers: { "x-goog-api-key": "tenant-key" },
			}),
		);
		expect(calls[0]!.headers.get("x-goog-api-key")).toBe("tenant-key");
	});

	it("injects the key for Vertex global and regional hosts", async () => {
		for (const host of [
			"aiplatform.googleapis.com",
			"us-central1-aiplatform.googleapis.com",
			"UPPER.aiplatform.googleapis.com",
		]) {
			await proxy().fetch(new Request(`https://${host}/v1/x`));
		}
		expect(calls).toHaveLength(3);
		for (const call of calls)
			expect(call.headers.get("x-goog-api-key")).toBe(SECRET);
	});

	const nonAllowed = [
		"https://example.com/",
		"https://generativelanguage.googleapis.com.evil.com/v1",
		"https://evilgenerativelanguage.googleapis.com/v1",
		"https://aiplatform.googleapis.com.evil.com/v1",
		"https://aiplatform-googleapis.com/v1",
		"https://generativelanguage.googleapis.com@evil.com/v1",
		"https://evil.com/generativelanguage.googleapis.com?key=1",
		// A trailing dot is a distinct hostname string: fail closed, no secret.
		"https://generativelanguage.googleapis.com./v1",
		"http://localhost:8787/",
	];
	for (const target of nonAllowed) {
		it(`forwards ${target} without any platform credential`, async () => {
			await proxy({
				geminiApiKey: SECRET,
				googleServiceAccountKey: '{"client_email":"a","private_key":"b"}',
			}).fetch(new Request(target, { headers: { "x-tenant": "1" } }));
			expect(calls).toHaveLength(1);
			expect(calls[0]!.headers.has("x-goog-api-key")).toBe(false);
			expect(calls[0]!.headers.has("authorization")).toBe(false);
			expect(calls[0]!.url).not.toContain(SECRET);
		});
	}

	it("does not inject when the platform has no key configured", async () => {
		await proxy({}).fetch(
			new Request("https://generativelanguage.googleapis.com/v1"),
		);
		expect(calls[0]!.headers.has("x-goog-api-key")).toBe(false);
	});

	it("rejects the internal gate endpoint without an organization (400, no fetch)", async () => {
		const response = await proxy({}).fetch(
			new Request(GATE_URL, {
				method: "POST",
				body: JSON.stringify({ gateId: "x" }),
			}),
		);
		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("rejects malformed gate verification input (400)", async () => {
		const response = await proxy({ organizationId: "org_a" }).fetch(
			new Request(GATE_URL, {
				method: "POST",
				body: JSON.stringify({
					gateId: "../../org_b/x",
					receiptSha256: "z",
					productContext: "p",
				}),
			}),
		);
		expect(response.status).toBe(400);
	});

	describe("secrets in thrown errors", () => {
		it("a malformed service-account key does not echo its content", async () => {
			const bad = `{"private_key":"${SECRET}" nope`;
			let message = "";
			try {
				await proxy({ googleServiceAccountKey: bad }).fetch(
					new Request("https://aiplatform.googleapis.com/v1/x"),
				);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).not.toBe("");
			expect(message).not.toContain(SECRET);
		});

		it("a service account missing fields names only the env var", async () => {
			await expect(
				proxy({
					googleServiceAccountKey: JSON.stringify({ client_email: "a@b.c" }),
				}).fetch(new Request("https://aiplatform.googleapis.com/v1/x")),
			).rejects.toThrow("missing client_email or private_key");
			expect(calls).toHaveLength(0);
		});
	});
});
