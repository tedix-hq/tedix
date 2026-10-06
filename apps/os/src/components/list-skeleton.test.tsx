import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ListSkeleton } from "./list-skeleton";

describe("ListSkeleton", () => {
	it("inherits the Kumo 8px radius while preserving row geometry", () => {
		const html = renderToStaticMarkup(
			<ListSkeleton rows={2} rowClassName="h-20" />,
		);

		expect(html.match(/data-slot="skeleton"/g)).toHaveLength(2);
		expect(html.match(/rounded-lg/g)).toHaveLength(2);
		expect(html.match(/h-20/g)).toHaveLength(2);
		expect(html).not.toContain("rounded-xl");
		expect(html).toContain('aria-hidden="true"');
	});
});
