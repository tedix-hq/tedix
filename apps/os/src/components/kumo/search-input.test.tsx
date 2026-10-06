import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SearchInput } from "./search-input";

describe("Kumo SearchInput adapter", () => {
	it("renders one labelled search field inside an InputGroup with an optional end addon", () => {
		const html = renderToStaticMarkup(
			<SearchInput
				aria-label="Search workspaces"
				placeholder="Search workspaces"
				trailing={<span>3 workspaces</span>}
			/>,
		);

		expect(html).toContain('data-kumo-component="SearchInput"');
		expect(html).toContain('data-slot="input-group"');
		expect(html).toContain('data-slot="input-group-addon-start"');
		expect(html).toContain('type="search"');
		expect(html).toContain('aria-label="Search workspaces"');
		expect(html).toContain('data-slot="input-group-addon-end"');
		expect(html).toContain("3 workspaces");
	});
});
