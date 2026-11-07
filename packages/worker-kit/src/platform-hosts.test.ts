import { describe, expect, it } from "vite-plus/test";
import { hostSetting, platformDomain, platformDomains } from "./platform-hosts";

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

describe("platformDomain", () => {
	it("follows the lane when PLATFORM_DOMAIN is unset", () => {
		expect(platformDomain({ ENVIRONMENT: "production" })).toBe("tedix.dev");
		expect(platformDomain({ ENVIRONMENT: "development" })).toBe("tedix.tech");
		expect(platformDomain({})).toBe("tedix.tech");
	});
	it("uses PLATFORM_DOMAIN on any lane", () => {
		expect(
			platformDomain({
				ENVIRONMENT: "production",
				PLATFORM_DOMAIN: " Example.com",
			}),
		).toBe("example.com");
	});
});
