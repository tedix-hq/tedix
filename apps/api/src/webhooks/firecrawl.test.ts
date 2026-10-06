import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Hono } from "hono";
import { handleFirecrawlWebhook } from "./firecrawl";
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const appId = "22222222-2222-4222-8222-222222222222";
const secret = "synthetic-webhook-secret";
const terminal = (type = "agent.completed") => ({
	type,
	success: type === "agent.completed",
	id: jobId,
	metadata: { workflowInstanceId: "workflow-1", appId },
	data: [{ creditsUsed: 3, data: { items: [{ title: "Example" }] } }],
});
async function signature(raw: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const bytes = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(raw),
	);
	return (
		"sha256=" +
		Array.from(new Uint8Array(bytes), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("")
	);
}
async function send(
	body: unknown,
	mode: "valid" | "missing" | "tampered" = "valid",
	fail: false | "get" | "send" = false,
	failure?: Error,
) {
	const enqueue = vi.fn(async (_event: unknown) => {
		if (fail === "send") throw failure ?? new Error("delivery unavailable");
	});
	const get = vi.fn(async () => {
		if (fail === "get") throw failure ?? new Error("lookup unavailable");
		return { sendEvent: enqueue };
	});
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	app.post("/webhook", handleFirecrawlWebhook);
	const raw = typeof body === "string" ? body : JSON.stringify(body);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (mode !== "missing")
		headers["X-Firecrawl-Signature"] = await signature(
			mode === "tampered" ? raw + " " : raw,
		);
	vi.spyOn(console, "error").mockImplementation(() => {});
	const response = await app.request(
		"/webhook",
		{ method: "POST", headers, body: raw },
		{
			FIRECRAWL_WEBHOOK_SECRET: secret,
			EXTRACTION_WORKFLOW: { get },
			ENVIRONMENT: "production",
		} as unknown as CloudflareEnv,
	);
	return { response, get, enqueue };
}
afterEach(() => vi.restoreAllMocks());
describe("signed Firecrawl callbacks", () => {
	it.each(["missing", "tampered"] as const)(
		"rejects %s signatures before lookup",
		async (mode) => {
			const x = await send(terminal(), mode);
			expect(x.response.status).toBe(401);
			expect(x.get).not.toHaveBeenCalled();
		},
	);
	it.each(["agent.completed", "agent.failed", "agent.cancelled"])(
		"routes %s by provider job",
		async (type) => {
			const x = await send(terminal(type));
			expect(x.response.status).toBe(200);
			expect(x.get).toHaveBeenCalledWith("workflow-1");
			expect(x.enqueue).toHaveBeenCalledWith({
				type: `firecrawl-agent-${jobId}`,
				payload: expect.objectContaining({
					firecrawlJobId: jobId,
					success: type === "agent.completed",
					status: type.slice(6),
					creditsUsed: 3,
				}),
			});
		},
	);
	it("normalizes a valid uppercase callback UUID to the selected event type", async () => {
		const x = await send({ ...terminal(), id: jobId.toUpperCase() });
		expect(x.response.status).toBe(200);
		expect(x.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				type: `firecrawl-agent-${jobId}`,
				payload: expect.objectContaining({ firecrawlJobId: jobId }),
			}),
		);
	});
	it.each(["agent.failed", "agent.cancelled"])(
		"accepts empty %s data and supplies a reason",
		async (type) => {
			const x = await send({ ...terminal(type), data: [] });
			expect(x.response.status).toBe(200);
			expect(x.enqueue.mock.calls[0]?.[0]).toMatchObject({
				payload: { success: false, error: expect.any(String) },
			});
		},
	);
	it.each([
		"invalid JSON",
		null,
		{ ...terminal(), id: "job" },
		{ ...terminal(), id: "A".repeat(1000) },
		{ ...terminal(), success: false },
		{ ...terminal(), metadata: {} },
		{ ...terminal(), metadata: { workflowInstanceId: "bad/id", appId } },
		{
			...terminal(),
			metadata: { workflowInstanceId: "workflow-1", appId: "invalid" },
		},
		{ ...terminal(), data: {} },
		{ ...terminal(), data: [{ creditsUsed: -1 }] },
		{ ...terminal(), error: 3 },
	])("rejects signed malformed terminal input", async (body) => {
		const x = await send(body);
		expect(x.response.status).toBe(400);
		expect(x.get).not.toHaveBeenCalled();
	});
	it("acknowledges unknown progress without reading data", async () => {
		const x = await send({ type: "agent.future-progress" });
		expect(x.response.status).toBe(200);
		expect(x.get).not.toHaveBeenCalled();
	});
	it("bounds the provider failure reason without inspecting extracted result shape", async () => {
		const x = await send({
			...terminal("agent.cancelled"),
			error: "x".repeat(900),
			data: [{ data: { arbitrary: [1, null, { nested: true }] } }],
		});
		expect(x.response.status).toBe(200);
		expect(x.enqueue.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				error: "x".repeat(500),
				data: { arbitrary: [1, null, { nested: true }] },
			},
		});
	});
	it("forwards the exact completed extraction to the selected workflow instance", async () => {
		const x = await send(terminal());
		expect(x.response.status).toBe(200);
		expect(x.get).toHaveBeenCalledWith("workflow-1");
		expect(x.enqueue).toHaveBeenCalledWith({
			type: `firecrawl-agent-${jobId}`,
			payload: {
				success: true,
				status: "completed",
				firecrawlJobId: jobId,
				creditsUsed: 3,
				error: undefined,
				data: { items: [{ title: "Example" }] },
			},
		});
	});
	it("returns retryable failure when instance lookup fails", async () => {
		const x = await send(terminal(), "valid", "get");
		expect(x.response.status).toBe(500);
		expect(x.get).toHaveBeenCalledWith("workflow-1");
		expect(x.enqueue).not.toHaveBeenCalled();
	});
	it("returns retryable failure when enqueue fails", async () => {
		const x = await send(terminal(), "valid", "send");
		expect(x.response.status).toBe(500);
		expect(x.enqueue).toHaveBeenCalledTimes(1);
	});
	it("logs bounded cause-chain metadata without workflow failure content", async () => {
		const marker = "private-extraction-payload-marker";
		const failure = new Error(marker, { cause: new Error(marker) });
		const x = await send(terminal(), "valid", "send", failure);
		expect(x.response.status).toBe(500);
		const logs = vi.mocked(console.error).mock.calls.flat().join(" ");
		expect(logs).toContain("firecrawl.webhook.processing_failed");
		expect(logs).toContain('"causeChain"');
		expect(logs).not.toContain(marker);
	});
	it("redacts attacker-controlled signature algorithm text", async () => {
		const marker = "private-signature-marker";
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		app.post("/webhook", handleFirecrawlWebhook);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const response = await app.request(
			"/webhook",
			{
				method: "POST",
				headers: { "X-Firecrawl-Signature": `${marker}=hash` },
				body: JSON.stringify(terminal()),
			},
			{ FIRECRAWL_WEBHOOK_SECRET: secret } as CloudflareEnv,
		);
		expect(response.status).toBe(401);
		expect(log.mock.calls.flat().join(" ")).not.toContain(marker);
	});
	it("logs signature computation failures without exception content", async () => {
		const marker = "private-crypto-marker";
		const app = new Hono<{ Bindings: CloudflareEnv }>();
		app.post("/webhook", handleFirecrawlWebhook);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(
			new Error(marker),
		);
		const response = await app.request(
			"/webhook",
			{
				method: "POST",
				headers: { "X-Firecrawl-Signature": "sha256=hash" },
				body: JSON.stringify(terminal()),
			},
			{ FIRECRAWL_WEBHOOK_SECRET: secret } as CloudflareEnv,
		);
		expect(response.status).toBe(401);
		const logs = log.mock.calls.flat().join(" ");
		expect(logs).toContain("firecrawl.webhook.signature_failed");
		expect(logs).not.toContain(marker);
	});
});
