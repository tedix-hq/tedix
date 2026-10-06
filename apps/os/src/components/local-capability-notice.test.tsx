import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { LocalCapabilityNotice } from "./local-capability-notice";

describe("local capability notices", () => {
	it("separates Home provider charges from worker usage", () => {
		const html = renderToStaticMarkup(
			<LocalCapabilityNotice capability="billing" />,
		);
		expect(html).toContain("Billing is off locally");
		expect(html).toContain("not runs by your saved worker");
		expect(html).toContain("provider account for charges");
	});
	it("explains catalog absence without suggesting local storage failed", () => {
		const html = renderToStaticMarkup(
			<LocalCapabilityNotice capability="catalog" />,
		);
		expect(html).toContain("App browsing is off locally");
		expect(html).toContain("saved content still work");
	});
});
