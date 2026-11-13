import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Subscription } from "./types";
import { callbackTokenHash } from "./types";
const mocks = vi.hoisted(() => ({
	ingest: vi.fn(),
	channel: vi.fn(),
	row: vi.fn(),
	update: vi.fn(),
	decrypt: vi.fn(),
}));
vi.mock("./mcp-events", () => ({ ingestProviderEvent: mocks.ingest }));
vi.mock("@tedix/db/utils/secrets-encryption", () => ({
	decryptSecret: mocks.decrypt,
}));
vi.mock("@tedix/db/queries/provider-events", () => ({
	resolveProviderEventChannel: mocks.channel,
	getProviderEventSubscription: mocks.row,
	updateProviderEventSubscription: mocks.update,
}));
vi.mock("./subscriptions", () => ({ queueReconciliation: vi.fn() }));
vi.mock("../../rpc/orpc", () => ({
	createContext: () => ({ db: {}, env: { SECRETS_MASTER_KEY: "master" } }),
}));
import { githubWebhookAdapter, verifyWebhookSignature } from "./signed-webhook";
import { handleProviderEventWebhook } from "../../webhooks/provider-events";
const row = {
	id: "sub",
	adapter: "github_webhook",
	organizationId: "org",
	resourceKey: "example/project",
	eventArguments: { events: ["issues"] },
	connectionScope: "tenant",
	deliveryMode: "push",
	status: "active",
} as Subscription;
const secret = "fixture signing secret";
const body = JSON.stringify({
	repository: { full_name: row.resourceKey },
	issue: { title: "test" },
});
async function sign(raw: string, keyText = secret) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(keyText),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)),
	);
	return `sha256=${[...bytes].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function app() {
	const api = new Hono<{ Bindings: CloudflareEnv }>();
	api.post("/:adapter/:id", (c) =>
		handleProviderEventWebhook(c, c.req.param("adapter"), c.req.param("id")),
	);
	return api;
}
async function delivery(
	raw = body,
	extra: Record<string, string> = {},
	signedBody = raw,
) {
	return app().request("/github_webhook/channel", {
		method: "POST",
		body: raw,
		headers: {
			"X-GitHub-Event": "issues",
			"X-GitHub-Delivery": "delivery",
			"X-Hub-Signature-256": await sign(signedBody),
			...extra,
		},
	});
}
beforeEach(async () => {
	vi.clearAllMocks();
	mocks.row.mockResolvedValue({ ...row });
	mocks.channel.mockResolvedValue({
		id: "channel",
		subscriptionId: "sub",
		organizationId: "org",
		status: "active",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		signingSecretCiphertext: "encrypted",
		tokenHash: await callbackTokenHash(secret),
	});
	mocks.decrypt.mockResolvedValue(secret);
	mocks.ingest.mockResolvedValue("queued");
});
describe("signed repository webhooks", () => {
	it("validates the selected repository, registers TLS JSON delivery and deletes only its hook", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ full_name: row.resourceKey }))
			.mockResolvedValueOnce(Response.json({ id: 42, active: true }))
			.mockResolvedValueOnce(new Response(null, { status: 404 }));
		const adapter = githubWebhookAdapter(request);
		await adapter.validateResource("token", row);
		const registration = await adapter.register(
			"token",
			row,
			"channel",
			secret,
			"https://api.test/callback",
		);
		expect(registration).toMatchObject({
			providerChannelId: "42",
			resourceId: row.resourceKey,
		});
		expect(Date.parse(registration.expiresAt)).toBeGreaterThan(Date.now());
		expect(JSON.parse(String(request.mock.calls[1]![1]!.body))).toEqual({
			name: "web",
			active: true,
			events: ["issues"],
			config: {
				url: "https://api.test/callback",
				content_type: "json",
				insecure_ssl: "0",
				secret,
			},
		});
		await adapter.stop("token", "42", row.resourceKey);
		expect(request.mock.calls[2]![0]).toBe(
			"https://api.github.com/repos/example/project/hooks/42",
		);
		expect(request.mock.calls[2]![1]!.method).toBe("DELETE");
	});
	it("rejects malformed resources and invalid registration responses", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ id: "wrong" }));
		const adapter = githubWebhookAdapter(request);
		await expect(
			adapter.validateResource("token", {
				...row,
				resourceKey: "../../internal",
			}),
		).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
		await expect(
			adapter.register(
				"token",
				row,
				"channel",
				secret,
				"https://api.test/callback",
			),
		).rejects.toThrow();
	});
	it("matches GitHub's published HMAC test vector", async () => {
		expect(
			await verifyWebhookSignature(
				"It's a Secret to Everybody",
				"Hello, World!",
				"sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
			),
		).toBe(true);
	});
	it("verifies the exact raw body before admitting and acknowledges only after the durable queue", async () => {
		const response = await delivery();
		expect(response.status).toBe(202);
		expect(mocks.ingest).toHaveBeenCalledWith(expect.anything(), row, {
			eventId: await callbackTokenHash(body),
			name: row.resourceKey,
			data: { event: "issues", payload: JSON.parse(body) },
		});
		expect(mocks.decrypt).toHaveBeenCalledWith("master", "org", "encrypted");
		mocks.ingest.mockRejectedValueOnce(new Error("storage failed"));
		expect((await delivery()).status).toBe(500);
	});
	it("rejects missing, malformed, wrong-secret and modified-body signatures without persistence", async () => {
		for (const signature of ["", "sha256=bad", await sign(body, "wrong")])
			expect(
				(await delivery(body, { "X-Hub-Signature-256": signature })).status,
			).toBe(403);
		expect((await delivery(body + " ", {}, body)).status).toBe(403);
		expect(mocks.ingest).not.toHaveBeenCalled();
	});
	it("rejects wrong repositories, unsubscribed events, disabled subscriptions and oversized bodies", async () => {
		expect(
			(
				await delivery(
					JSON.stringify({ repository: { full_name: "other/project" } }),
				)
			).status,
		).toBe(403);
		expect((await delivery(body, { "X-GitHub-Event": "push" })).status).toBe(
			403,
		);
		expect((await delivery("x".repeat(256_001))).status).toBe(413);
		mocks.row.mockResolvedValue({ ...row, status: "disabled" });
		expect((await delivery()).status).toBe(404);
		expect(mocks.ingest).not.toHaveBeenCalled();
	});
	it("accepts signed setup pings and rejects inactive event delivery", async () => {
		const channel = await mocks.channel();
		mocks.channel.mockResolvedValue({ ...channel, status: "pending" });
		expect((await delivery(body, { "X-GitHub-Event": "ping" })).status).toBe(
			204,
		);
		expect((await delivery()).status).toBe(403);
		expect(mocks.ingest).not.toHaveBeenCalled();
	});
	it("uses signed body identity even when unsigned delivery headers change", async () => {
		await delivery(body, { "X-GitHub-Delivery": "one" });
		mocks.ingest.mockResolvedValueOnce("duplicate");
		expect((await delivery(body, { "X-GitHub-Delivery": "two" })).status).toBe(
			202,
		);
		expect(mocks.ingest.mock.calls[0]![2].eventId).toBe(
			mocks.ingest.mock.calls[1]![2].eventId,
		);
	});
});
