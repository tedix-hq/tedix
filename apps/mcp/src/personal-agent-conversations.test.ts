import { beforeEach, expect, it, vi } from "vite-plus/test";
import { handlePersonalAgentConversations } from "./personal-agent-conversations";
const call = vi.hoisted(() => vi.fn());
vi.mock("./lib/api-client", () => ({
	getApiClient: () => ({ osTenant: { personalAgentConversation: call } }),
}));
const base = "https://public.example/mcp/poppy/conversations";
const invoke = (request: Request) =>
	handlePersonalAgentConversations({
		request,
		appId: "app",
		organizationId: "org",
		env: {} as CloudflareEnv,
	});
beforeEach(() => {
	vi.clearAllMocks();
	call.mockResolvedValue({
		httpStatus: 201,
		body: { conversation_id: "conversation" },
	});
});
it("forwards protocol input with a private response and no owner cookies or bearer", async () => {
	const response = await invoke(
		new Request(base, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Poppy-Session": "fictional-proof",
				"Poppy-Version": "1.0",
				Cookie: "owner=private",
				Authorization: "Bearer private",
			},
			body: JSON.stringify({
				id: "request",
				message: { author: { type: "agent" }, text: "Hi" },
			}),
		}),
	);
	expect(response.status).toBe(201);
	expect(response.headers.get("Cache-Control")).toContain("no-store");
	expect(await response.json()).toEqual({ conversation_id: "conversation" });
	expect(call).toHaveBeenCalledWith(
		expect.objectContaining({
			appId: "app",
			organizationId: "org",
			sessionToken: "fictional-proof",
			version: "1.0",
		}),
	);
	expect(JSON.stringify(call.mock.calls)).not.toContain("private");
});
it("bounds streamed bodies even when Content-Length is false", async () => {
	const response = await invoke(
		new Request(base, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Content-Length": "1" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("x".repeat(32769)));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit),
	);
	expect(response.status).toBe(400);
	expect(call).not.toHaveBeenCalled();
});
it.each(["{", "null"])(
	"handles malformed or empty input without leaking errors (%s)",
	async (body) => {
		call.mockResolvedValue({
			httpStatus: 400,
			body: { error: "invalid_request" },
		});
		const response = await invoke(
			new Request(base, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			}),
		);
		expect(response.status).toBe(400);
	},
);
it("keeps rate limits and transport failures bounded", async () => {
	call.mockResolvedValue({ httpStatus: 429, body: { error: "rate_limited" } });
	const response = await invoke(new Request(`${base}/conversation/events`));
	expect(response.status).toBe(429);
	expect(response.headers.get("Retry-After")).toBe("60");
	call.mockRejectedValue(Error("private JWT"));
	expect(await (await invoke(new Request(base))).json()).toEqual({
		error: "unavailable",
	});
});
it("rejects unsupported methods and non-JSON posts", async () => {
	expect((await invoke(new Request(base, { method: "DELETE" }))).status).toBe(
		405,
	);
	expect(
		(await invoke(new Request(base, { method: "POST", body: "{}" }))).status,
	).toBe(400);
	expect(call).not.toHaveBeenCalled();
});
