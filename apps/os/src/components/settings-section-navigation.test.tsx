import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/components/kumo/link", () => ({
	Link: ({
		variant: _variant,
		...props
	}: React.ComponentProps<"a"> & { variant?: string }) => <a {...props} />,
}));

vi.mock("@/components/kumo/button", () => ({
	Button: ({
		size: _size,
		variant: _variant,
		...props
	}: React.ComponentProps<"button"> & { size?: string; variant?: string }) => (
		<button {...props} />
	),
}));

import { SettingsSectionNavigation } from "./settings-section-navigation";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
const items = [
	["Details", "settings-details"],
	["Access", "settings-access"],
] as const;

afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	window.history.replaceState(null, "", window.location.pathname);
});

function renderNavigation() {
	const page = document.createElement("div");
	page.dataset.slot = "page";
	document.body.appendChild(page);
	const root = createRoot(page);
	act(() => {
		root.render(
			<>
				<SettingsSectionNavigation
					ariaLabel="Test settings sections"
					items={items}
				/>
				<div id="settings-details" />
				<div id="settings-access" />
			</>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		page.remove();
	});
	return page;
}

describe("SettingsSectionNavigation", () => {
	it("renders durable anchors and marks exactly one current section", () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		cleanups.push(() => {
			Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
		});
		window.history.replaceState(null, "", "#settings-access");
		const page = renderNavigation();
		const navigation = page.querySelector("nav");
		const links = Array.from(page.querySelectorAll("a"));

		expect(navigation?.getAttribute("aria-label")).toBe(
			"Test settings sections",
		);
		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"#settings-details",
			"#settings-access",
		]);
		expect(
			links.filter((link) => link.getAttribute("aria-current") === "location"),
		).toHaveLength(1);
		expect(links[1]?.getAttribute("aria-current")).toBe("location");
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
	});

	it("tracks hash navigation without replacing link semantics", () => {
		const page = renderNavigation();
		const links = Array.from(page.querySelectorAll("a"));

		act(() => {
			window.history.replaceState(null, "", "#settings-access");
			window.dispatchEvent(new HashChangeEvent("hashchange"));
		});

		expect(links[0]?.hasAttribute("aria-current")).toBe(false);
		expect(links[1]?.getAttribute("aria-current")).toBe("location");
	});

	it("restores a deep link while lazy settings content settles", async () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		cleanups.push(() => {
			Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
		});
		window.history.replaceState(null, "", "#settings-access");
		const page = renderNavigation();
		scrollIntoView.mockClear();

		await act(async () => {
			page.appendChild(document.createElement("div"));
			await Promise.resolve();
		});

		expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
	});

	it("selects the final section when the scroll root reaches its end", () => {
		const page = renderNavigation();
		const navigation = page.querySelector("nav");
		const details = page.querySelector<HTMLElement>("#settings-details");
		const access = page.querySelector<HTMLElement>("#settings-access");
		const links = Array.from(page.querySelectorAll("a"));
		Object.defineProperties(page, {
			scrollTop: { configurable: true, value: 900 },
			clientHeight: { configurable: true, value: 100 },
			scrollHeight: { configurable: true, value: 1000 },
		});
		navigation!.getBoundingClientRect = () => ({ bottom: 40 }) as DOMRect;
		details!.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
		access!.getBoundingClientRect = () => ({ top: 800 }) as DOMRect;

		act(() => page.dispatchEvent(new Event("scroll")));

		expect(links[0]?.hasAttribute("aria-current")).toBe(false);
		expect(links[1]?.getAttribute("aria-current")).toBe("location");
	});
});
