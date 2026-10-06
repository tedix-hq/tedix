import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "./button";
import { DataTable } from "./data-table";

describe("Kumo DataTable adapter", () => {
	it("keeps rows semantic, labels the scroll region, and exposes explicit cell actions", () => {
		const html = renderToStaticMarkup(
			<DataTable
				data={[{ id: "evt-1", name: "Started" }]}
				rowKey="id"
				scrollLabel="Activity events"
				columns={[
					{ header: "Event", accessor: "name", sticky: "left" },
					{
						header: "Actions",
						accessor: () => <Button aria-label="View event">View</Button>,
						sticky: "right",
					},
				]}
			/>,
		);

		expect(html).not.toMatch(/<tr[^>]+role="button"/);
		expect(html).toContain('aria-label="View event"');
		expect(html).toContain('aria-label="Activity events"');
		expect(html).toContain('role="region"');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('scope="col"');
		expect(html).toContain("Started");
	});
});
