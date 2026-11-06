import { describe, expect, it } from "vite-plus/test";
import { hostSetting, platformDomains } from "./platform-hosts";

describe("hostSetting", () => {
	it("falls back to the Tedix hostname when unset or blank", () => {
		expect(hostSetting(undefined, "cms.tedix.dev")).toBe("cms.tedix.dev");
		expect(hostSetting("  ", "cms.tedix.dev")).toBe("cms.tedix.dev");
	});
	it("uses the configured hostname, trimmed and lowercased", () => {
		expect(hostSetting(" .CMS.Example.com ", "cms.tedix.dev")).toBe(
			"cms.example.com",
		);
	});
});

describe("platformDomains", () => {
	it("defaults to the Tedix Cloud domains", () => {
		expect(platformDomains({})).toEqual(["tedix.dev", "tedix.tech"]);
		expect(platformDomains({ PLATFORM_DOMAINS: " , " })).toEqual([
			"tedix.dev",
			"tedix.tech",
		]);
	});
	it("reads a comma-separated override", () => {
		expect(
			platformDomains({
				PLATFORM_DOMAINS: "Example.com, example.dev,example.com",
			}),
		).toEqual(["example.com", "example.dev"]);
	});
});
