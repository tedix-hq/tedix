import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
	viewer: {
		role: "member",
		permissions: [] as string[],
	},
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority: state.viewer } }),
}));
import { OsSettingsFrame } from "./os-settings-frame";

afterEach(() => {
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

const nav = (doc: Document) =>
	doc.querySelector('nav[aria-label="Settings sections"]')!;
const current = (doc: Document) =>
	[...nav(doc).querySelectorAll('[aria-current="page"]')].map(
		(link) => link.textContent,
	);

describe("Settings sidebar", () => {
	it("preserves member reads without exposing admin or billing links", () => {
		const doc = render("/compute");
		expect(doc.querySelector('a[href="/admin"]')).toBeNull();
		expect(doc.querySelector('a[href="/admin/api-keys"]')).toBeNull();
		expect(doc.querySelector('a[href="/admin/billing"]')).toBeNull();
		expect(
			[...nav(doc).querySelectorAll('[data-sidebar="group-label"]')].map(
				(label) => label.textContent,
			),
		).toEqual(["Organization", "Connections", "Billing", "History"]);
		expect(nav(doc).textContent).toContain("Usage & billing");
		expect(doc.querySelector('a[href="/audit"]')?.textContent).toBe(
			"Activity log",
		);
		expect(doc.body.textContent).toContain("Page content");
	});
	it("groups every admin destination with an icon", () => {
		state.viewer.role = "owner";
		state.viewer.permissions = ["billing:manage"];
		const doc = render("/admin/connections");
		const groups = [...nav(doc).querySelectorAll('[data-sidebar="group"]')].map(
			(group) => [
				group.querySelector('[data-sidebar="group-label"]')?.textContent,
				[...group.querySelectorAll("a")].map((link) => link.textContent),
			],
		);
		expect(groups).toEqual([
			[
				"Organization",
				["Settings", "Organization", "Website chat", "Templates"],
			],
			["Connections", ["Connected accounts", "My accounts", "API keys"]],
			["Billing", ["Usage & billing", "Payments"]],
			["History", ["Activity log"]],
		]);
		for (const link of nav(doc).querySelectorAll("a"))
			expect(link.querySelector("svg"), link.textContent ?? "").not.toBeNull();
	});
	it("marks only the current page with aria-current and the active state", () => {
		state.viewer.role = "owner";
		const doc = render("/admin/connections");
		expect(current(doc)).toEqual(["Connected accounts"]);
		const active = nav(doc).querySelector('[aria-current="page"]');
		expect(active?.hasAttribute("data-active")).toBe(true);
		expect(active?.hasAttribute("data-settings-active")).toBe(true);
		expect(nav(doc).querySelectorAll("[data-active]")).toHaveLength(1);
	});
	it("nests usage and billing and marks their shared section active", () => {
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
		expect(current(doc)).toEqual(["Usage & billing", "Billing"]);
		expect(
			doc.querySelector('a[href="/admin/billing"]')?.closest("ul")?.textContent,
		).toBe("UsageBilling");
	});
	it("keeps the Settings sidebar off ordinary pages", () => {
		expect(render("/team").querySelector("nav")).toBeNull();
	});
});
