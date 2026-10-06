import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
	KumoTabs,
	nextTabsOverflowState,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "./tabs";

describe("Kumo Tabs adapter", () => {
	it("renders composed and controlled tabs with their labels and content", () => {
		const composed = renderToStaticMarkup(
			<Tabs defaultValue="all">
				<TabsList aria-label="Status" variant="line">
					<TabsTrigger value="all">All</TabsTrigger>
					<TabsTrigger value="done">Done</TabsTrigger>
				</TabsList>
				<TabsContent value="all">All items</TabsContent>
			</Tabs>,
		);
		expect(composed).toContain('aria-label="Status"');
		expect(composed).toContain('data-kumo-part="tab"');
		expect(composed).toContain("All items");

		const controlled = renderToStaticMarkup(
			<KumoTabs
				aria-label="Status"
				size="sm"
				value="all"
				tabs={[
					{ value: "all", label: "All" },
					{ value: "done", label: "Done" },
				]}
			/>,
		);
		expect(controlled).toContain('data-kumo-component="Tabs"');
		expect(controlled).toContain('role="group"');
		expect(controlled).toContain("All");
		expect(controlled).toContain("Done");
	});

	it("derives both routed-tab overflow directions from the scroll viewport", () => {
		const current = {
			isOverflowing: false,
			canScrollStart: false,
			canScrollEnd: false,
		};
		expect(
			nextTabsOverflowState(
				{ clientWidth: 320, scrollLeft: 0, scrollWidth: 560 } as HTMLElement,
				current,
			),
		).toEqual({
			isOverflowing: true,
			canScrollStart: false,
			canScrollEnd: true,
		});
		expect(
			nextTabsOverflowState(
				{ clientWidth: 320, scrollLeft: 240, scrollWidth: 560 } as HTMLElement,
				current,
			),
		).toEqual({
			isOverflowing: true,
			canScrollStart: true,
			canScrollEnd: false,
		});
	});
});
