import type {
	MetricTile as MetricTileData,
	MetricTileMeasured,
} from "@tedix/api-contract/schemas/metric-tile";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MetricTile } from "./metric-tile";

const measured = (
	overrides: Partial<MetricTileMeasured> = {},
): MetricTileData => ({
	state: "measured",
	label: "Runs settled",
	value: "42",
	window: "last 7 days",
	source: "run ledger",
	...overrides,
});

describe("MetricTile", () => {
	it("renders a measured value only alongside its window and source", () => {
		const html = renderToStaticMarkup(<MetricTile tile={measured()} />);
		expect(html).toContain('data-slot="metric-item"');
		expect(html).toContain("Runs settled");
		expect(html).toContain(">42<");
		expect(html).toContain('data-slot="metric-provenance"');
		expect(html).toContain("last 7 days · run ledger");
	});

	it("can never render a value whose provenance is missing", () => {
		// A tile that reaches the renderer without source or window — stale
		// data, a hand-built object, a contract drift — must not leak its
		// number. It degrades to an honest "Not measured" instead.
		for (const malformed of [
			{
				state: "measured",
				label: "Runs settled",
				value: "42",
				window: "last 7 days",
			},
			{
				state: "measured",
				label: "Runs settled",
				value: "42",
				source: "run ledger",
			},
			{
				state: "measured",
				label: "Runs settled",
				window: "last 7 days",
				source: "run ledger",
			},
		]) {
			const html = renderToStaticMarkup(
				// Deliberately ill-typed: simulates a tile reaching the renderer
				// from outside the type system.
				<MetricTile tile={malformed as unknown as MetricTileData} />,
			);
			expect(html).not.toContain(">42<");
			expect(html).toContain("Not measured");
			expect(html).toContain("Runs settled");
			expect(html).not.toContain('data-slot="metric-provenance"');
		}
	});

	it("renders an empty tile's reason and setup link instead of a number", () => {
		const html = renderToStaticMarkup(
			<MetricTile
				tile={{
					state: "empty",
					label: "Spent this period",
					emptyReason: "No settlement total is available",
					setupHref: "/admin/billing?section=subscription",
					setupLabel: "Manage plan",
				}}
			/>,
		);
		expect(html).toContain("Spent this period");
		expect(html).toContain("No settlement total is available");
		expect(html).toContain('href="/admin/billing?section=subscription"');
		expect(html).toContain("Manage plan");
		expect(html).not.toContain('data-slot="metric-provenance"');
	});

	it("labels the setup link 'Set up' when none is given and omits it without a href", () => {
		const withDefault = renderToStaticMarkup(
			<MetricTile
				tile={{
					state: "empty",
					label: "Delegation rate",
					emptyReason: "Not measured yet",
					setupHref: "/work/deck",
				}}
			/>,
		);
		expect(withDefault).toContain("Set up");
		expect(withDefault).toContain('href="/work/deck"');
		const noLink = renderToStaticMarkup(
			<MetricTile
				tile={{
					state: "empty",
					label: "Delegation rate",
					emptyReason: "Not measured yet",
				}}
			/>,
		);
		expect(noLink).not.toContain("<a");
		expect(noLink).toContain("Not measured yet");
	});

	it("links the measured value when the tile carries a drill-down href", () => {
		const html = renderToStaticMarkup(
			<MetricTile tile={measured({ href: "/work/interactions" })} />,
		);
		expect(html).toContain('href="/work/interactions"');
		expect(html).toContain(">42<");
	});
});
