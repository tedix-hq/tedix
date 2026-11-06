import { describe, expect, it } from "vite-plus/test";
import { cmsPlatformHosts } from "./platform-hosts";

describe("cmsPlatformHosts", () => {
	it("keeps Tedix Cloud's hosts when no var is set", () => {
		const hosts = cmsPlatformHosts({});
		expect(hosts.siteBuilderHostname).toBe("builder.tedix.dev");
		expect(hosts.platformDomains).toEqual(["tedix.dev", "tedix.tech"]);
		expect(hosts.tenantOrigin("acme")).toBe("https://acme.cms.tedix.dev");
	});

	it("uses a self-hosted installation's hosts", () => {
		const hosts = cmsPlatformHosts({
			CMS_TENANT_HOST_SUFFIX: "sites.example.com",
			SITE_BUILDER_HOSTNAME: "builder.example.com",
			PLATFORM_DOMAINS: "example.com",
		});
		expect(hosts.siteBuilderHostname).toBe("builder.example.com");
		expect(hosts.platformDomains).toEqual(["example.com"]);
		expect(hosts.tenantOrigin("acme")).toBe("https://acme.sites.example.com");
	});
});
