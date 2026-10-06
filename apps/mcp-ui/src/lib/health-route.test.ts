import { describe, expect, it, vi } from "vite-plus/test";

const runtime = vi.hoisted(() => ({
	env: { GIT_SHA: "3cea01c4b3e07a325f08c9ccd6ca06fc5cb1b95a" },
}));

vi.mock("cloudflare:workers", () => runtime);

import { GET } from "../pages/health";

describe("widget health", () => {
	it("reports the deploy-time release SHA", async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(response).toBeInstanceOf(Response);
		expect(await (response as Response).json()).toEqual({
			status: "ok",
			deployedSha: "3cea01c4b3e07a325f08c9ccd6ca06fc5cb1b95a",
		});
	});

	it("keeps the release field explicit when no SHA is available", async () => {
		runtime.env.GIT_SHA = "";

		const response = await GET({} as Parameters<typeof GET>[0]);

		expect(await (response as Response).json()).toEqual({
			status: "ok",
			deployedSha: "unknown",
		});
	});
});
