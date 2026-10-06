import { describe, expect, it } from "vite-plus/test";
import {
	chatWidgetTargetsFromMetadata,
	MAX_CHAT_WIDGETS_PER_MESSAGE,
} from "./chat-widget-targets";

describe("chatWidgetTargetsFromMetadata", () => {
	it("finds and deduplicates validated MCP App resources in durable metadata", () => {
		const target = "ui://widgets/mcp-app/metabase/dashboard.html";
		expect(
			chatWidgetTargetsFromMetadata({
				toolResult: { _meta: { ui: { resourceUri: target } } },
				mirrored: { resourceUri: target },
			}),
		).toEqual([{ appSlug: "metabase", resourceUri: target }]);
	});

	it("rejects non-widget and malformed resources", () => {
		expect(
			chatWidgetTargetsFromMetadata({
				_meta: { ui: { resourceUri: "https://untrusted.example/widget" } },
				other: { resourceUri: "ui://widgets/mcp-app/Bad!/chart.html" },
			}),
		).toEqual([]);
	});

	it("keeps the bounded initial result attached to its canonical target", () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/comparison.html";
		const toolResult = {
			rows: [{ product: "Alpha", price: 42 }],
			_meta: { ui: { resourceUri } },
		};
		expect(
			chatWidgetTargetsFromMetadata({
				delegatedResult: {
					version: 1,
					widgets: [{ resourceUri, toolResult }],
				},
			}),
		).toEqual([{ appSlug: "acme", resourceUri, toolResult }]);
	});

	it("caps a chat turn at the intentional widget stack limit", () => {
		const metadata = Object.fromEntries(
			Array.from({ length: MAX_CHAT_WIDGETS_PER_MESSAGE + 1 }, (_, index) => [
				`widget-${index}`,
				{ resourceUri: `ui://widgets/mcp-app/app-${index}/view.html` },
			]),
		);
		expect(chatWidgetTargetsFromMetadata(metadata)).toHaveLength(
			MAX_CHAT_WIDGETS_PER_MESSAGE,
		);
	});
});

describe("widget provenance", () => {
	const target = "ui://widgets/mcp-app/metabase/dashboard.html";

	/**
	 * The defect this closes: `widgetTargetFromResourceUri` validates the URI's
	 * SHAPE and constrains nothing about WHICH app slug appears, so a result
	 * from app A could declare app B's widget and have it render inside the
	 * assistant's turn. The kernel now stamps the app whose tool actually ran.
	 */
	it("refuses a widget whose declared app disagrees with its producer", () => {
		expect(
			chatWidgetTargetsFromMetadata({
				delegatedResult: {
					widgets: [{ resourceUri: target, producedByAppSlug: "acme" }],
				},
			}),
		).toEqual([]);
	});

	it("does not rediscover a rejected resource in its nested result", () => {
		expect(
			chatWidgetTargetsFromMetadata({
				delegatedResult: {
					widgets: [
						{
							resourceUri: target,
							producedByAppSlug: "acme",
							toolResult: { _meta: { ui: { resourceUri: target } } },
						},
					],
				},
			}),
		).toEqual([]);
	});

	it("renders when the producer agrees", () => {
		expect(
			chatWidgetTargetsFromMetadata({
				delegatedResult: {
					widgets: [{ resourceUri: target, producedByAppSlug: "metabase" }],
				},
			}),
		).toEqual([{ appSlug: "metabase", resourceUri: target }]);
	});

	/**
	 * Unstamped is UNKNOWN provenance, not mismatched. The walk deliberately
	 * finds three shapes and only one comes from the kernel; rejecting the rest
	 * would break rendering that predates the field.
	 */
	it("still renders a shape that carries no stamp", () => {
		expect(
			chatWidgetTargetsFromMetadata({
				toolResult: { _meta: { ui: { resourceUri: target } } },
			}),
		).toEqual([{ appSlug: "metabase", resourceUri: target }]);
	});

	it("keeps walking past a mismatch to find a legitimate sibling", () => {
		const own = "ui://widgets/mcp-app/acme/compare.html";
		expect(
			chatWidgetTargetsFromMetadata({
				spoofed: { resourceUri: target, producedByAppSlug: "acme" },
				real: { resourceUri: own, producedByAppSlug: "acme" },
			}),
		).toEqual([{ appSlug: "acme", resourceUri: own }]);
	});
});
