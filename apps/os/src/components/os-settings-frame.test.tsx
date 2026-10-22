import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
	pending: false,
	viewer: {
		role: "member",
		permissions: [] as string[],
	},
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: state.pending ? undefined : { authority: state.viewer },
	}),
}));
import { OsSettingsFrame } from "./os-settings-frame";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	state.pending = false;
	state.viewer.role = "member";
	state.viewer.permissions = [];
});

function render(pathname: string) {
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<OsSettingsFrame pathname={pathname}>
				<p>Page content</p>
			</OsSettingsFrame>,
		),
		"text/html",
	);
}
describe("Settings navigation", () => {
	it("preserves member reads without exposing admin or billing links", () => {
		state.viewer.role = "member";
		state.viewer.permissions = [];
		const doc = render("/compute");
		expect(doc.querySelector('a[href="/admin"]')).toBeNull();
		expect(doc.querySelector('a[href="/admin/billing"]')).toBeNull();
		expect(
			doc.querySelector('[aria-label="Settings sections"]')?.textContent,
		).toContain("Usage & billing");
		expect(doc.querySelector('a[href="/audit"]')?.textContent).toBe(
			"Activity log",
		);
		expect(doc.body.textContent).toContain("Page content");
	});
	it("groups usage and billing and marks their shared section active", () => {
		state.viewer.role = "owner";
		state.viewer.permissions = ["billing:manage"];
		const doc = render("/admin/billing");
		expect(
			[...doc.querySelectorAll('a[href="/compute"]')].map(
				(link) => link.textContent,
			),
		).toEqual(["Usage & billing", "Usage"]);
		expect(doc.querySelector('a[href="/admin/billing"]')?.textContent).toBe(
			"Billing",
		);
		expect(doc.querySelector('a[href="/admin"]')?.textContent).toBe("Settings");
		expect(
			doc.querySelector('a[href="/compute"]')?.getAttribute("aria-current"),
		).toBe("page");
		expect(
			doc
				.querySelector('a[href="/admin/billing"]')
				?.getAttribute("aria-current"),
		).toBe("page");
		expect(
			doc.querySelector('a[href="/admin/billing"]')?.parentElement?.textContent,
		).toBe("UsageBilling");
	});
	it("keeps the Settings rail off ordinary pages", () => {
		expect(render("/team").querySelector("nav")).toBeNull();
	});
	it("reveals the active link again when authority items arrive", () => {
		const scrollIntoView = vi.fn();
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: scrollIntoView,
		});
		cleanups.push(() => {
			Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
		});
		state.pending = true;
		const page = document.createElement("div");
		document.body.appendChild(page);
		const root = createRoot(page);
		act(() =>
			root.render(
				<OsSettingsFrame pathname="/audit">
					<p>Page content</p>
				</OsSettingsFrame>,
			),
		);
		cleanups.push(() => {
			act(() => root.unmount());
			page.remove();
		});
		expect(page.querySelector('a[href="/admin"]')).toBeNull();
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		// The authority read resolves after the pathname commit: the admin links
		// prepend ahead of "Activity log" and push it right, so the reveal must
		// run again against the new item set.
		state.pending = false;
		state.viewer.role = "owner";
		act(() =>
			root.render(
				<OsSettingsFrame pathname="/audit">
					<p>Page content</p>
				</OsSettingsFrame>,
			),
		);

		expect(page.querySelector('a[href="/admin"]')).not.toBeNull();
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
	});
});
