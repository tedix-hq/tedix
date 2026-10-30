import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "./collapsible";

describe("Collapsible", () => {
	it("uses Kumo's styled disclosure with one caret and keeps closed content hidden", () => {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<Collapsible>
				<CollapsibleDefaultTrigger>Technical details</CollapsibleDefaultTrigger>
				<CollapsibleDefaultContent keepMounted>
					Saved record
				</CollapsibleDefaultContent>
			</Collapsible>,
		);
		const trigger = host.querySelector(
			'button[data-kumo-part="default-trigger"]',
		);
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		expect(trigger?.querySelectorAll("svg")).toHaveLength(1);
		const panel = host.querySelector("[hidden]");
		expect(panel?.textContent).toBe("Saved record");
	});
	it("renders the Kumo trigger and shows the panel body when open by default", () => {
		const html = renderToStaticMarkup(
			<Collapsible defaultOpen>
				<CollapsibleTrigger>Operational details</CollapsibleTrigger>
				<CollapsibleContent>Body</CollapsibleContent>
			</Collapsible>,
		);

		expect(html).toContain('data-kumo-component="CollapsibleTrigger"');
		expect(html).toContain("Operational details");
		expect(html).toContain("Body");
	});
});
