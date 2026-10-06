import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Badge } from "./badge";

describe("Kumo Badge adapter", () => {
	it("renders one semantic badge root carrying its label", () => {
		const html = renderToStaticMarkup(<Badge variant="info">Connected</Badge>);

		expect(html).toMatch(/^<span/);
		expect(html.match(/<span/g)).toHaveLength(1);
		expect(html).toContain("Connected");
	});
});
