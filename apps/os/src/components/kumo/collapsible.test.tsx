import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./collapsible";

describe("Collapsible", () => {
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
