import { describe, expect, it } from "vite-plus/test";
import {
	CAPABILITY_NAV_ITEMS,
	CAPABILITY_SUB_NAV_ITEMS,
	capabilityTab,
} from "./capability-navigation";

describe("CapabilityNavigation destinations", () => {
	it("keeps the shared capability destinations in their stable order", () => {
		expect(CAPABILITY_NAV_ITEMS.map((item) => item.id)).toEqual([
			"apps",
			"accounts",
			"skills",
		]);
		expect(
			Object.values(CAPABILITY_SUB_NAV_ITEMS).flatMap((views) =>
				views.map((view) => view.to),
			),
		).toEqual([
			"/apps",
			"/explore/apps",
			"/admin/connections",
			"/account/connections",
		]);
	});

	it("maps every view to its owning tab", () => {
		expect(capabilityTab("installed")).toBe("apps");
		expect(capabilityTab("browse")).toBe("apps");
		expect(capabilityTab("organization")).toBe("accounts");
		expect(capabilityTab("personal")).toBe("accounts");
		expect(capabilityTab("skills")).toBe("skills");
	});

	it("names no gateway tab", () => {
		expect(
			CAPABILITY_NAV_ITEMS.some((item) =>
				/gateway|connection/i.test(item.label),
			),
		).toBe(false);
	});
});
