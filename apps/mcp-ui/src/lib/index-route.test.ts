import { describe, expect, it } from "vite-plus/test";

import { GET, HEAD } from "../pages/index";

describe("widget technical origin", () => {
	it.each([GET, HEAD])("does not expose a browsable index", async (handler) => {
		const response = await handler({} as Parameters<typeof handler>[0]);

		expect(response).toBeInstanceOf(Response);
		expect((response as Response).status).toBe(404);
		expect((response as Response).headers.get("cache-control")).toBe(
			"no-store",
		);
		expect((response as Response).headers.get("x-robots-tag")).toBe(
			"noindex, nofollow, noarchive",
		);
		expect(await (response as Response).text()).toBe("");
	});
});
