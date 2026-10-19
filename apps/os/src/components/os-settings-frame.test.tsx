import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
const viewer = vi.hoisted(() => ({
	role: "member",
	permissions: [] as string[],
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority: viewer } }),
}));
import { OsSettingsFrame } from "./os-settings-frame";
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
		viewer.role = "member";
		viewer.permissions = [];
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
		viewer.role = "owner";
		viewer.permissions = ["billing:manage"];
		const doc = render("/admin/billing");
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
});
