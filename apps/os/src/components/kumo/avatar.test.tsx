import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Avatar, AvatarFallback } from "./avatar";

describe("Kumo Avatar adapter", () => {
	it("renders fallback initials", () => {
		const html = renderToStaticMarkup(
			<Avatar size="sm">
				<AvatarFallback>TS</AvatarFallback>
			</Avatar>,
		);

		expect(html).toContain("TS");
	});
});
