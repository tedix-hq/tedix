import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { FeaturesSection } from "@/components/organization-features-section";

describe("FeaturesSection", () => {
	it("renders plan entitlements as one labeled Kumo collection", () => {
		const html = renderToStaticMarkup(
			<FeaturesSection
				features={{
					maxApps: 12,
					maxTeamMembers: -1,
					customDomain: true,
					sso: false,
					apiAccess: true,
					prioritySupport: false,
					advancedAnalytics: true,
					whiteLabel: false,
				}}
			/>,
		);

		expect(html).toContain('data-slot="collection"');
		expect(html).toContain('aria-label="Plan features"');
		expect(html.match(/<li/g)).toHaveLength(8);
		expect(html).toContain("Up to 12 apps");
		expect(html).toContain("Unlimited team members");
		expect(html).toContain("Included");
		expect(html).toContain("Not included");
	});

	it("does not rebuild each feature as an independently bordered panel", () => {
		const html = renderToStaticMarkup(
			<FeaturesSection features={{ maxApps: -1, maxTeamMembers: -1 }} />,
		);

		expect(html).not.toContain('data-slot="surface"');
		expect(html).not.toContain('data-tier="panel"');
	});
});
