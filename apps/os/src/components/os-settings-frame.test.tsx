import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
	rendered: new Set<() => void>(),
	router: {
		subscribe: (_event: string, callback: () => void) => {
			state.rendered.add(callback);
			return () => state.rendered.delete(callback);
		},
	},
	pending: false,
	viewer: {
		role: "member",
		permissions: [] as string[],
	},
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => state.router,
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

function mount(pathname: string, scrollIntoView = vi.fn()) {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: scrollIntoView,
	});
	const page = document.createElement("div");
	document.body.appendChild(page);
	const root = createRoot(page);
	const navigate = (pathname: string) =>
		act(() =>
			root.render(
				<OsSettingsFrame pathname={pathname}>
					<p>Page content</p>
				</OsSettingsFrame>,
			),
		);
	cleanups.push(() => {
		act(() => root.unmount());
		page.remove();
		Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
	});
	navigate(pathname);
	return { page, navigate, scrollIntoView };
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
	it("wraps destinations onto rows below md instead of hiding them in horizontal scroll", () => {
		state.viewer.role = "owner";
		state.viewer.permissions = ["billing:manage"];
		const doc = render("/admin/connections");
		const classes =
			doc
				.querySelector('[aria-label="Settings sections"]')
				?.getAttribute("class") ?? "";
		expect(classes).toContain("flex-wrap");
		expect(classes).toContain("md:flex-nowrap");
	});
	it("reveals the active link again when authority items arrive", () => {
		state.pending = true;
		const { page, navigate, scrollIntoView } = mount("/audit");
		expect(page.querySelector('a[href="/admin"]')).toBeNull();
		expect(scrollIntoView).toHaveBeenCalledTimes(1);

		// Late authority items push Activity log sideways without changing routes.
		state.pending = false;
		state.viewer.role = "owner";
		navigate("/audit");

		expect(page.querySelector('a[href="/admin"]')).not.toBeNull();
		expect(scrollIntoView).toHaveBeenCalledTimes(2);
	});
	it("reveals the active section after router history scroll restoration", async () => {
		state.viewer.role = "owner";
		const scrollIntoView = vi.fn(function (this: HTMLElement) {
			this.closest("nav")!.scrollLeft = 670;
		});
		const { page, navigate } = mount("/admin/organization", scrollIntoView);
		navigate("/audit");
		navigate("/admin/organization");
		navigate("/audit");
		const nav = page.querySelector("nav")!;
		expect(nav.scrollLeft).toBe(670);

		await act(async () => {
			for (const callback of state.rendered) callback();
			// Router restoration runs in onRendered, after the pathname effect.
			// Its cached position must not hide the newly active section.
			nav.scrollLeft = 0;
			await Promise.resolve();
		});
		expect(nav.scrollLeft).toBe(670);
		cleanups.pop()?.();
		expect(state.rendered.size).toBe(0);
	});
});
