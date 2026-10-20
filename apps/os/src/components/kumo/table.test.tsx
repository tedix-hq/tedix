import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./table";

describe("Kumo Table adapter", () => {
	it("labels the scroll region, defaults to the compact header, and forwards the row variant", () => {
		const html = renderToStaticMarkup(
			<Table scrollLabel="Workers">
				<TableCaption>Current workers</TableCaption>
				<TableHeader>
					<TableRow>
						<TableHead>Worker</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow variant="selected">
						<TableCell>Researcher</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);

		expect(html).toContain('aria-label="Workers"');
		expect(html).toContain('role="region"');
		expect(html).toContain('tabindex="0"');
		expect(html).not.toContain("scrollbar-gutter");
		expect(html).toContain('data-compact=""');
		expect(html).toContain("Current workers");
		expect(html).toContain("bg-kumo-tint");
		expect(html).toContain("[--kumo-table-row-bg:var(--color-kumo-tint)]");
		expect(html).toContain("Researcher");

		expect(
			renderToStaticMarkup(
				<Table>
					<TableHeader variant="default">
						<TableRow>
							<TableHead>Worker</TableHead>
						</TableRow>
					</TableHeader>
				</Table>,
			),
		).not.toContain('data-compact=""');
	});
});
