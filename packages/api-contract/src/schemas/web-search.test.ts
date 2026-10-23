import { expect, it } from "vite-plus/test";
import { OrganizationMetadataSchema } from "./organization";
import { ToolPolicySchema } from "./tedi";
import {
	resolveWebSearchAccess,
	WEB_SEARCH_DEFAULT_RESULTS,
	WebSearchPolicySchema,
} from "./web-search";

it("validates provider selection in organization metadata", () => {
	for (const provider of ["tavily", "firecrawl", "ai-gateway"]) {
		expect(
			OrganizationMetadataSchema.parse({
				webSearch: { enabled: true, provider, fallbackProvider: "firecrawl" },
			}).webSearch,
		).toMatchObject({ provider, fallbackProvider: "firecrawl" });
	}
	expect(
		WebSearchPolicySchema.safeParse({ enabled: true, provider: "unknown" })
			.success,
	).toBe(false);
});

it("keeps web search off unless the organization enables it", () => {
	expect(resolveWebSearchAccess({ organization: undefined })).toEqual({
		enabled: false,
	});
	expect(resolveWebSearchAccess({ organization: { enabled: false } })).toEqual({
		enabled: false,
	});
	expect(resolveWebSearchAccess({ organization: { enabled: "yes" } })).toEqual({
		enabled: false,
	});
	expect(resolveWebSearchAccess({ organization: { enabled: true } })).toEqual({
		enabled: true,
		maxResults: WEB_SEARCH_DEFAULT_RESULTS,
	});
});

it("lets a tedi opt out and honours an explicit runtime-tool ceiling", () => {
	const organization = { enabled: true, maxResults: 3 };
	expect(resolveWebSearchAccess({ organization, tediPolicy: "off" })).toEqual({
		enabled: false,
	});
	expect(
		resolveWebSearchAccess({
			organization,
			runtimeTools: ["browser_markdown"],
		}),
	).toEqual({ enabled: false });
	expect(
		resolveWebSearchAccess({
			organization,
			tediPolicy: "inherit",
			runtimeTools: ["web_search"],
		}),
	).toEqual({ enabled: true, maxResults: 3 });
});

it("accepts the switch in organization metadata and tedi tool policy", () => {
	expect(
		OrganizationMetadataSchema.parse({ webSearch: { enabled: true } })
			.webSearch,
	).toEqual({ enabled: true });
	expect(() =>
		OrganizationMetadataSchema.parse({
			webSearch: { enabled: true, maxResults: 50 },
		}),
	).toThrow();
	expect(ToolPolicySchema.parse({ webSearch: "off" }).webSearch).toBe("off");
	expect(ToolPolicySchema.parse({}).webSearch).toBeUndefined();
});
