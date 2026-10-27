import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/first-party-mcp", () => ({
	requestFirstPartyMcp: request,
}));

import { factoryChatReader } from "./factory-chat-tools";

const env = {
	MCP_SERVICE: { fetch: vi.fn() },
	MCP_URL: "https://mcp.example.test",
} as never;
const lanes = {
	structuredContent: {
		executionId: "sample-exec",
		result: JSON.stringify({
			total: 1,
			lanes: [{ slug: "sample-inbox", name: "Sample inbox" }],
		}),
	},
};

beforeEach(() => request.mockReset());

describe("factory chat reader", () => {
	it("retries a failed read once", async () => {
		request
			.mockResolvedValueOnce({ isError: true, content: [] })
			.mockResolvedValueOnce(lanes);
		await expect(
			factoryChatReader(env, "org-1", "sample-tools").lanes(),
		).resolves.toEqual({
			total: 1,
			lanes: [{ slug: "sample-inbox", name: "Sample inbox" }],
		});
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("reports a read that fails twice", async () => {
		request.mockResolvedValue({ isError: true, content: [] });
		await expect(
			factoryChatReader(env, "org-1", "sample-tools").health("sample-inbox"),
		).rejects.toThrow("Factory health could not be read");
		expect(request).toHaveBeenCalledTimes(2);
	});
});
