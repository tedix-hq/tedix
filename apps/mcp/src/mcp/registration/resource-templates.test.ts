import { describe, expect, it } from "vite-plus/test";
import {
	isSelfObservedCatalogResource,
	isTedixOwnedResourceTemplate,
	normalizeConfiguredWidgetRoute,
	protocolSafeResourceAnnotations,
} from "./resource-templates";

describe("catalog MCP resource registration", () => {
	it("rejects self-observed resources to prevent runtime feedback loops", () => {
		expect(
			isSelfObservedCatalogResource({
				appSlug: "wise",
				sourceAppSlug: "WISE",
			}),
		).toBe(true);
	});

	it("retains resources originating from aggregate and upstream apps", () => {
		expect(
			isSelfObservedCatalogResource({
				appSlug: "tedix-unified",
				sourceAppSlug: "wise",
			}),
		).toBe(false);
		expect(
			isSelfObservedCatalogResource({
				appSlug: "wise",
				sourceAppSlug: null,
			}),
		).toBe(false);
	});

	it("keeps the generated widget template owned by the Tedix edge", () => {
		expect(
			isTedixOwnedResourceTemplate(
				"ui://widgets/mcp-app/{appSlug}/{+widgetPath}",
			),
		).toBe(true);
		expect(
			isTedixOwnedResourceTemplate("provider://{account}/{resource}"),
		).toBe(false);
	});

	it("normalizes a stored widget route for legacy Gadget resources", () => {
		expect(
			normalizeConfiguredWidgetRoute("r/initech-setup-decision-intake"),
		).toBe("/r/initech-setup-decision-intake");
		expect(
			normalizeConfiguredWidgetRoute("/r/initech-setup-decision-intake.html"),
		).toBe("/r/initech-setup-decision-intake");
		expect(normalizeConfiguredWidgetRoute("not-a-widget-route")).toBeNull();
	});

	it("filters invalid stored audiences only at protocol registration", () => {
		expect(
			protocolSafeResourceAnnotations({
				audience: ["assistant", "internal"],
				priority: 0.7,
				lastModified: "2026-09-23T20:00:00Z",
			}),
		).toEqual({
			audience: ["assistant"],
			priority: 0.7,
			lastModified: "2026-09-23T20:00:00Z",
		});
		expect(protocolSafeResourceAnnotations({ audience: ["internal"] })).toBe(
			undefined,
		);
	});
});
