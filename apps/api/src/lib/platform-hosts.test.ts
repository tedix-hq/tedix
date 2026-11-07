import { describe, expect, it } from "vite-plus/test";
import { tediHost } from "./platform-hosts";

describe("tediHost", () => {
	it("defaults to Tedix Cloud's tedi host for the lane", () => {
		expect(tediHost({ ENVIRONMENT: "production" }, "acme")).toBe(
			"acme.tedi.tedix.dev",
		);
		expect(tediHost({ ENVIRONMENT: "development" }, "acme")).toBe(
			"acme.tedi.tedix.tech",
		);
	});

	it("follows PLATFORM_DOMAIN, and TEDI_HOST_SUFFIX over it", () => {
		expect(
			tediHost(
				{ ENVIRONMENT: "production", PLATFORM_DOMAIN: "example.com" },
				"acme",
			),
		).toBe("acme.tedi.example.com");
		expect(tediHost({ TEDI_HOST_SUFFIX: "agents.example.com" }, "acme")).toBe(
			"acme.agents.example.com",
		);
	});
});
