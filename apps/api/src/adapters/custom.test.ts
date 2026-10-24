import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CustomAdapter } from "./custom";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("CustomAdapter", () => {
	it("preserves caller cancellation instead of reporting a timeout", async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValue(new DOMException("Caller cancelled", "AbortError"));
		vi.stubGlobal("fetch", fetcher);
		const controller = new AbortController();
		controller.abort();
		const adapter = new CustomAdapter({
			id: "adapter-1",
			appId: "app-1",
			name: "example",
			displayName: null,
			adapterType: "custom",
			config: {
				baseUrl: "https://example.com",
				endpoints: { search: "/search" },
			},
			fieldMappings: null,
			verticals: null,
			enabled: true,
			priority: 0,
			createdAt: null,
			updatedAt: null,
		});

		const result = await adapter.search(
			"example",
			{},
			{
				env: {},
				signal: controller.signal,
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "Caller cancelled",
			errorCode: "request_failed",
		});
		expect(fetcher).toHaveBeenCalledOnce();
	});
});
