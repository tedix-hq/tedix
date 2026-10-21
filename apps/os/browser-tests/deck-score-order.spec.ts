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
		await page.waitForFunction(async () => {
			const tools = (
				window as unknown as { deckTools: Map<string, WebMcpSpecTool> }
			).deckTools;
			const snapshot = (await tools
				.get("get_decision_deck_card")
				?.execute({})) as { queue?: unknown[] } | undefined;
			return snapshot?.queue?.length === 4;
		});
		// The browser's Deck queue must differ from the low/high/middle sheet order.
		const snapshot = (await page.evaluate(async () => {
			const tools = (
				window as unknown as { deckTools: Map<string, WebMcpSpecTool> }
			).deckTools;
			return tools.get("get_decision_deck_card")!.execute({});
		})) as { queue: { label: string }[] };
		assert.deepEqual(
			snapshot.queue.map((card: { label: string }) => card.label),
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
