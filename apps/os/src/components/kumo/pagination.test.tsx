import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Pagination } from "./pagination";

describe("Kumo Pagination adapter", () => {
	it("renders labelled previous and next controls", () => {
		const html = renderToStaticMarkup(
			<Pagination page={2} perPage={25} totalCount={100} setPage={() => {}}>
				<Pagination.Info />
				<Pagination.Controls controls="simple" />
			</Pagination>,
		);

		expect(html).toContain('data-slot="pagination-controls"');
		expect(html).toContain('aria-label="Previous page"');
		expect(html).toContain('aria-label="Next page"');
	});
});
