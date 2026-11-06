import { describe, expect, it } from "vite-plus/test";
import { cmsRuntimePlatformHosts } from "./platform-hosts";

describe("cmsRuntimePlatformHosts", () => {
	it("keeps Tedix Cloud's hosts when no var is set", () => {
		expect(cmsRuntimePlatformHosts({})).toEqual({
			healthHostname: "cms.tedix.dev",
			marketingBlogHostname: "blog.tedix.dev",
		});
	});

	it("uses a self-hosted installation's hosts", () => {
		expect(
			cmsRuntimePlatformHosts({
				CMS_TENANT_HOST_SUFFIX: "sites.example.com",
				MARKETING_BLOG_HOST: "blog.example.com",
			}),
		).toEqual({
			healthHostname: "sites.example.com",
			marketingBlogHostname: "blog.example.com",
		});
	});
});
