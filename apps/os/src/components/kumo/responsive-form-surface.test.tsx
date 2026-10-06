import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ResponsiveFormSurface } from "./responsive-form-surface";

const roots: Array<ReturnType<typeof createRoot>> = [];
const originalMatchMedia = window.matchMedia;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderSurface(matches: boolean) {
	window.matchMedia = ((query: string) =>
		({
			matches,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		}) as unknown as MediaQueryList) as typeof window.matchMedia;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	function Harness() {
		const [open, setOpen] = useState(false);
		return (
			<ResponsiveFormSurface
				title="Create record"
				description="Secondary mutation with complete desktop guidance"
				mobileDescription="Secondary mutation"
				mobileOpen={open}
				onMobileOpenChange={setOpen}
			>
				<form aria-label="Create record form" />
			</ResponsiveFormSurface>
		);
	}
	act(() => root.render(<Harness />));
	return container;
}

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.replaceChildren();
	window.matchMedia = originalMatchMedia;
});

describe("ResponsiveFormSurface", () => {
	it("starts closed on phones and opens the same form through its labeled trigger", () => {
		const container = renderSurface(true);
		const surface = container.querySelector(
			'[data-kumo-component="ResponsiveFormSurface"]',
		);
		const trigger = container.querySelector<HTMLButtonElement>("button");

		expect(surface?.getAttribute("data-responsive-form-layout")).toBe("mobile");
		expect(surface?.getAttribute("data-responsive-form-state")).toBe("closed");
		expect(trigger?.textContent).toContain("Create record");
		expect(trigger?.textContent).toContain("Secondary mutation");
		expect(trigger?.textContent).not.toContain("complete desktop guidance");
		expect(container.querySelectorAll("form")).toHaveLength(1);

		act(() => trigger?.click());
		expect(surface?.getAttribute("data-responsive-form-state")).toBe("open");
		expect(container.querySelectorAll("form")).toHaveLength(1);
		expect(container.textContent).toContain("complete desktop guidance");
	});

	it("forces the single form open on desktop", () => {
		const container = renderSurface(false);
		const surface = container.querySelector(
			'[data-kumo-component="ResponsiveFormSurface"]',
		);

		expect(surface?.getAttribute("data-responsive-form-layout")).toBe(
			"desktop",
		);
		expect(surface?.getAttribute("data-responsive-form-state")).toBe("open");
		expect(container.querySelectorAll("form")).toHaveLength(1);
	});
});
