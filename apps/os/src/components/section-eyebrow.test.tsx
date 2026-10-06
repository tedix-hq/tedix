import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SectionEyebrow } from "./section-eyebrow";

describe("SectionEyebrow", () => {
	it("keeps the compact evidence-label treatment by default", () => {
		const html = renderToStaticMarkup(<SectionEyebrow title="Evidence" />);
		expect(html).toContain("uppercase");
		expect(html).toContain("bg-kumo-hairline");
	});

	it("puts the shared eyebrow on the Tedix caption role", () => {
		const html = renderToStaticMarkup(
			<SectionEyebrow title="Evidence" count={3} />,
		);
		expect(html).toContain("type-tedix-caption");
		expect(html).not.toContain("text-[11px]");
	});

	it("supports Cloudflare-console section hierarchy with a count pill", () => {
		const html = renderToStaticMarkup(
			<SectionEyebrow title="Work items" count={14_146} variant="console" />,
		);
		expect(html).toContain("text-kumo-strong");
		expect(html).toContain("type-tedix-body");
		expect(html).toContain("type-tedix-label");
		expect(html).toContain("rounded-full");
		expect(html).toContain("14,146");
		expect(html).not.toContain("uppercase");
	});

	it("stacks actions within the available width on narrow screens", () => {
		const html = renderToStaticMarkup(
			<SectionEyebrow
				title="Audit events"
				count={576_261}
				actions={<button type="button">All resources</button>}
			/>,
		);
		expect(html).toContain("flex-col");
		expect(html).toContain("sm:flex-row");
		expect(html).toContain("w-full sm:w-auto sm:shrink-0");
		expect(html).toContain("All resources");
	});
});
