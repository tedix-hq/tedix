import { describe, expect, it, vi } from "vite-plus/test";
import { getSiteBuilderSandbox } from "./sandbox";

describe("CMS Site Builder Sandbox lookup", () => {
	it("addresses the app-owned Durable Object by organization slug", () => {
		const resolved = { id: "sandbox" };
		const getByName = vi.fn(() => resolved);
		expect(
			getSiteBuilderSandbox(
				{ SITE_BUILDER_SANDBOX: { getByName } as never },
				"acme",
			),
		).toBe(resolved);
		expect(getByName).toHaveBeenCalledWith("acme");
	});
});
