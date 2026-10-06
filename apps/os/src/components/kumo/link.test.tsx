import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Link } from "./link";
import { KumoLinkProvider } from "./link-provider";

describe("Kumo Link adapter", () => {
	it("renders every variant as a real anchor and tags the Tedix roles", () => {
		const inline = renderToStaticMarkup(
			<Link href="https://os.tedix.dev">os.tedix.dev</Link>,
		);
		expect(inline).toMatch(/^<a/);
		expect(inline).toContain('href="https://os.tedix.dev"');
		expect(inline).not.toContain("data-link-role");

		const record = renderToStaticMarkup(
			<Link variant="record" href="/work/items/abc">
				Ship the deploy gate
			</Link>,
		);
		expect(record).toMatch(/^<a/);
		expect(record).toContain('href="/work/items/abc"');
		expect(record).toContain('data-link-role="record"');
		expect(record).toContain("Ship the deploy gate");

		const section = renderToStaticMarkup(
			<KumoLinkProvider>
				<Link
					variant="section"
					href="#organization-appearance"
					aria-current="location"
				>
					Appearance
				</Link>
			</KumoLinkProvider>,
		);
		expect(section).toMatch(/^<a/);
		expect(section).toContain('aria-current="location"');
		expect(section).toContain('data-link-role="section"');
		expect(section).not.toContain('role="button"');
	});
});
