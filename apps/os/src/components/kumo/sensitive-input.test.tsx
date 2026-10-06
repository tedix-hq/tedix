import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SensitiveInput } from "./sensitive-input";

describe("Kumo SensitiveInput adapter", () => {
	it("masks the value behind Kumo's reveal and copy affordances and passes field chrome through", () => {
		const html = renderToStaticMarkup(
			<SensitiveInput
				defaultValue="sk_live_abc123"
				description="Rotate this from the provider console."
				error="This key is expired."
				label="Provider key"
				name="apiKey"
			/>,
		);

		expect(html).toContain('data-kumo-component="SensitiveInput"');
		expect(html).toContain('type="password"');
		expect(html).toContain('name="apiKey"');
		// The value stays in the field (it is a real input) but is masked: the
		// control is aria-hidden behind Kumo's dot mask until revealed.
		expect(html).toContain("••••••••");
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('aria-label="Reveal value"');
		expect(html.toLowerCase()).toContain("copy");
		expect(html).toContain("Provider key");
		expect(html).toContain("This key is expired.");
	});
});
