import { describe, expect, it } from "vite-plus/test";
import { SiteRoutingDefinitionSchema } from "./site-routing";

const siteRouting = { version: 1, legacyBlogs: [], retainedMedia: [] };

describe("site routing definition", () => {
	it("reads a published revision that carries the policy pack approval posture", () => {
		const parsed = SiteRoutingDefinitionSchema.safeParse({
			siteRouting,
			governancePolicy: { requireExplicitThirdPartyApprovalPolicy: false },
		});
		expect(parsed.data?.siteRouting).toEqual(siteRouting);
	});

	it("rejects any other top-level field", () => {
		expect(
			SiteRoutingDefinitionSchema.safeParse({ siteRouting, extra: true })
				.success,
		).toBe(false);
	});
});
