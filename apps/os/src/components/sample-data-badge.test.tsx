import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SampleDataBadge } from "./sample-data-badge";

describe("SampleDataBadge", () => {
	it("labels the shell while the data is the sample company", () => {
		const html = renderToStaticMarkup(<SampleDataBadge show />);
		expect(html).toContain("Sample data");
		expect(html).toContain("Sending and scheduling are switched off");
	});

	it("renders nothing in a deployed build", () => {
		expect(renderToStaticMarkup(<SampleDataBadge show={false} />)).toBe("");
	});
});
