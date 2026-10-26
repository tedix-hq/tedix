import type { OsBlueprintPublicPage } from "@tedix/api-contract/contracts/os-workspaces";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	BlueprintLanding,
	blueprintInstallPath,
	blueprintShareUrl,
} from "./blueprint-landing-page";

const ID = "00000050-0000-4000-8000-000000000001";

function page(
	overrides: Partial<OsBlueprintPublicPage> = {},
): OsBlueprintPublicPage {
	return {
		id: ID,
		name: "Revenue Ops Starter",
		description: "Workspace template for weekly revenue reporting",
		publishedAt: "2026-10-20T10:00:00.000Z",
		featured: true,
		apps: [{ name: "Revenue Dashboard" }],
		needs: {
			connections: [{ providerId: "gmail" }],
			resources: [{ label: "Team calendar", providerId: "google-calendar" }],
			skills: [{ slug: "weekly-revenue-report" }],
			outputs: [{ title: "Weekly revenue", kind: "sheet" }],
		},
		...overrides,
	};
}

describe("blueprint landing page", () => {
	it("builds the share link and the sign-in install path from the id", () => {
		expect(blueprintShareUrl("https://acme.os.tedix.dev", ID)).toBe(
			`https://acme.os.tedix.dev/blueprint/${ID}`,
		);
		expect(blueprintInstallPath(ID)).toBe(`/blueprints?install=${ID}`);
	});

	it("says what the blueprint sets up and needs, with one install action", () => {
		const html = renderToStaticMarkup(
			<BlueprintLanding
				blueprint={page()}
				shareUrl={`https://acme.os.tedix.dev/blueprint/${ID}`}
			/>,
		);
		expect(html).toContain("Revenue Ops Starter");
		expect(html).toContain("Featured");
		expect(html).toContain("Revenue Dashboard");
		expect(html).toContain("Weekly revenue");
		expect(html).toContain("gmail");
		expect(html).toContain("Team calendar");
		expect(html).toContain("weekly-revenue-report");
		expect(html).toContain(`href="/blueprints?install=${ID}"`);
		expect(html).toContain("Use this blueprint");
	});

	it("tells the visitor when there is nothing to connect first", () => {
		const html = renderToStaticMarkup(
			<BlueprintLanding
				blueprint={page({
					featured: false,
					apps: [],
					needs: { connections: [], resources: [], skills: [], outputs: [] },
				})}
				shareUrl="https://acme.os.tedix.dev/blueprint/x"
			/>,
		);
		expect(html).toContain("Nothing to connect first.");
		expect(html).toContain("An empty workspace you can add apps to.");
		expect(html).not.toContain("Featured");
	});
});
