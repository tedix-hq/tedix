import assert from "node:assert/strict";
import { chromium } from "playwright";
import type { WebMcpSpecTool } from "@tedix/webmcp-core/model-context";
import { createDeckSourceFixture, chooseSource } from "./deck-source-fixture";

const { origin, fixture, title, close } = await createDeckSourceFixture(true);
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [390, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.addInitScript(() => {
			const tools = new Map<string, WebMcpSpecTool>();
			(window as unknown as { deckTools: typeof tools }).deckTools = tools;
			(document as unknown as { modelContext: unknown }).modelContext = {
				registerTool(tool: WebMcpSpecTool, options?: { signal?: AbortSignal }) {
					tools.set(tool.name, tool);
					options?.signal?.addEventListener("abort", () => {
						if (tools.get(tool.name) === tool) tools.delete(tool.name);
					});
				},
			};
		});
		await fixture(page);
		await page.goto(`${origin}/work?view=deck`);
		await page.getByRole("region", { name: title(-1), exact: true }).waitFor();
		// waitForFunction treats an async predicate's pending Promise as truthy,
		// so it never waited for the sheet rows. Poll the tool until the full
		// queue is there and judge the order on that same snapshot.
		const readQueue = () =>
			page.evaluate(async () => {
				const tools = (
					window as unknown as { deckTools: Map<string, WebMcpSpecTool> }
				).deckTools;
				const snapshot = (await tools
					.get("get_decision_deck_card")
					?.execute({})) as { queue?: { label: string }[] } | undefined;
				return snapshot?.queue?.map((card) => card.label) ?? [];
			});
		let labels = await readQueue();
		for (const deadline = Date.now() + 30_000; labels.length !== 4;) {
			assert(
				Date.now() < deadline,
				`Deck queue never filled at ${width}px: ${JSON.stringify(labels)}`,
			);
			await page.waitForTimeout(100);
			labels = await readQueue();
		}
		// The browser's Deck queue must differ from the low/high/middle sheet order.
		assert.deepEqual(
			labels,
			[
				"Rotate the fictional API key?",
				"Review fictional score 0.95.",
				"Review fictional score 0.6.",
				"Review fictional score 0.2.",
			],
			`critical Work precedes descending factory scores at ${width}px`,
		);
		await chooseSource(page, "Scores");
		await page
			.getByRole("region", { name: title(0, 1), exact: true })
			.waitFor();
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await page.close();
	}
	console.log(
		"Deck factory Score ordering after critical Work at 390px and 1280px passed.",
	);
} finally {
	await browser.close();
	close();
}
