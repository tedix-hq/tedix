import { describe, expect, it } from "vite-plus/test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
	CapabilityNavigation,
	CAPABILITY_NAV_CLASSNAME,
	CAPABILITY_NAV_EDGE_TOLERANCE,
	CAPABILITY_NAV_ITEMS,
	CAPABILITY_NAV_TRACK_CLASSNAME,
	CAPABILITY_NAV_VIEWPORT_CLASSNAME,
	getCapabilityNavOverflowState,
} from "./capability-navigation";

async function renderNavigation(
	active: Parameters<typeof CapabilityNavigation>[0]["active"],
) {
	const container = document.createElement("div");
	document.body.append(container);
	await act(async () => {
		createRoot(container).render(
			createElement(CapabilityNavigation, { active }),
		);
	});
	// The overflow state is measured in an animation frame.
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
	});
	return container;
}

describe("CapabilityNavigation", () => {
	it("keeps the shared capability destinations in their stable order", () => {
		expect(CAPABILITY_NAV_ITEMS.map((item) => item.id)).toEqual([
			"gateway",
			"installed",
			"browse",
			"skills",
			"organization",
			"personal",
		]);
	});

	it("uses one contained horizontal rail and reveals the active route", () => {
		expect(CAPABILITY_NAV_VIEWPORT_CLASSNAME).toContain(
			"overflow-x-auto overscroll-x-contain",
		);
		expect(CAPABILITY_NAV_VIEWPORT_CLASSNAME).toContain("min-w-0 flex-1");
		expect(CAPABILITY_NAV_VIEWPORT_CLASSNAME).toContain("scroll-px-3");
		expect(CAPABILITY_NAV_CLASSNAME).toContain("flex");
		expect(CAPABILITY_NAV_TRACK_CLASSNAME).toContain("flex w-max min-w-full");
		expect(CAPABILITY_NAV_CLASSNAME).not.toContain("flex-wrap");
		expect(CAPABILITY_NAV_TRACK_CLASSNAME).not.toContain("flex-wrap");
	});

	it("gives directional controls layout space instead of overlaying labels", async () => {
		// A rail wider than its viewport, scrolled to the middle: both
		// directions have hidden destinations.
		const metrics = { clientWidth: 300, scrollWidth: 900, scrollLeft: 200 };
		const restore = (["clientWidth", "scrollWidth", "scrollLeft"] as const).map(
			(key) => {
				const original = Object.getOwnPropertyDescriptor(
					HTMLElement.prototype,
					key,
				);
				Object.defineProperty(HTMLElement.prototype, key, {
					configurable: true,
					get: () => metrics[key],
					set: () => {},
				});
				return () => {
					if (original)
						Object.defineProperty(HTMLElement.prototype, key, original);
					else
						delete (
							HTMLElement.prototype as unknown as Record<string, unknown>
						)[key];
				};
			},
		);
		try {
			const container = await renderNavigation("skills");
			const nav = container.querySelector("nav")!;
			const back = nav.querySelector(
				'[aria-label="Scroll capability navigation left"]',
			);
			const forward = nav.querySelector(
				'[aria-label="Scroll capability navigation right"]',
			);
			for (const control of [back, forward]) {
				expect(control).not.toBeNull();
				expect(control!.parentElement).toBe(nav);
				expect(control!.className).toContain("shrink-0");
				expect(control!.className).not.toMatch(/\babsolute\b|\bz-10\b/);
			}
			container.remove();
		} finally {
			for (const undo of restore) undo();
		}
	});

	it("shows only the direction with hidden destinations", () => {
		expect(CAPABILITY_NAV_EDGE_TOLERANCE).toBe(12);
		expect(
			getCapabilityNavOverflowState({
				clientWidth: 358,
				scrollLeft: 0,
				scrollWidth: 521,
			}),
		).toEqual({ canScrollBack: false, canScrollForward: true });
		expect(
			getCapabilityNavOverflowState({
				clientWidth: 288,
				scrollLeft: 9,
				scrollWidth: 521,
			}),
		).toEqual({ canScrollBack: false, canScrollForward: true });
		expect(
			getCapabilityNavOverflowState({
				clientWidth: 358,
				scrollLeft: 163,
				scrollWidth: 521,
			}),
		).toEqual({ canScrollBack: true, canScrollForward: false });
		expect(
			getCapabilityNavOverflowState({
				clientWidth: 521,
				scrollLeft: 0,
				scrollWidth: 521,
			}),
		).toEqual({ canScrollBack: false, canScrollForward: false });
	});

	it("uses real Kumo route links instead of button-role anchors", async () => {
		const container = await renderNavigation("skills");
		const links = [...container.querySelectorAll("nav a")];
		expect(links.map((link) => link.getAttribute("href"))).toEqual(
			CAPABILITY_NAV_ITEMS.map((item) => item.to),
		);
		for (const link of links) expect(link.getAttribute("role")).toBeNull();
		expect(
			links
				.filter((link) => link.getAttribute("aria-current") === "page")
				.map((link) => link.textContent),
		).toEqual(["Skills"]);
		container.remove();
	});
});
