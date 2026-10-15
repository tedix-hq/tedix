import { describe, expect, it } from "vite-plus/test";
import { ownsSlideKeys, slideNavigationTarget } from "./slide-navigation";

describe("slide navigation", () => {
	it("maps the navigation keys and clamps at the ends", () => {
		expect(slideNavigationTarget("ArrowRight", 0, 3)).toBe(1);
		expect(slideNavigationTarget(" ", 2, 3)).toBe(2);
		expect(slideNavigationTarget("PageUp", 0, 3)).toBe(0);
		expect(slideNavigationTarget("End", 0, 3)).toBe(2);
		expect(slideNavigationTarget("Home", 2, 3)).toBe(0);
		expect(slideNavigationTarget("x", 0, 3)).toBeNull();
		expect(slideNavigationTarget("ArrowRight", 0, 0)).toBeNull();
	});

	it("leaves keys to fields, buttons and menus", () => {
		for (const tag of ["input", "textarea", "button"]) {
			expect(ownsSlideKeys(document.createElement(tag))).toBe(true);
		}
		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		const item = document.createElement("div");
		menu.appendChild(item);
		expect(ownsSlideKeys(item)).toBe(true);
		expect(ownsSlideKeys(document.createElement("div"))).toBe(false);
	});
});
