import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Skeleton } from "./skeleton";

describe("Kumo Skeleton adapter", () => {
	it("renders the skeleton slot and preserves an explicit caller background", () => {
		expect(renderToStaticMarkup(<Skeleton />)).toContain(
			'data-slot="skeleton"',
		);
		expect(
			renderToStaticMarkup(<Skeleton style={{ backgroundColor: "red" }} />),
		).toContain('style="background-color:red"');
	});
});
