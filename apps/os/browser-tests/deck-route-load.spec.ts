import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * The supported Work > Decisions link, /work?view=deck, must render the
 * decisions body for an admin, not "Tedix couldn't load this view". The Deck
 * shows that notice when any of these reads fails, so each must succeed.
 */
const DECK_READS = new Set([
	"/api/rpc/workInteractions/listInbox",
	"/api/rpc/workApprovals/listInbox",
	"/api/rpc/tediApprovals/list",
	"/api/rpc/learningFeedback/model",
	"/api/rpc/learningFeedback/listInteractions",
]);
const server = await startFixtureServer("/work?view=deck");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 800 } });
		try {
			await page.route("**/api/rpc/userSettings/getContext", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.authority.role = "admin";
				await route.fulfill({ response, json: body });
			});
			const reads = new Set<string>();
			const failedReads: string[] = [];
			page.on("response", (response) => {
				const path = new URL(response.url()).pathname;
				if (!DECK_READS.has(path)) return;
				reads.add(path);
				if (response.status() >= 400)
					failedReads.push(`${response.status()} ${path}`);
			});
			await page.goto(`${server.origin}/work?view=deck`);
			await page.locator(".fd-deck-current .fd-card").waitFor();
			await page.waitForLoadState("networkidle");
			assert.deepEqual(failedReads, [], `Deck reads failed at ${width}px`);
			assert.deepEqual(
				[...reads].sort(),
				[...DECK_READS].sort(),
				`Deck reads at ${width}px`,
			);
			assert.equal(
				await page.getByText("Tedix couldn't load this view.").count(),
				0,
				`load failure notice at ${width}px`,
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`horizontal overflow at ${width}px`,
			);
		} finally {
			await page.unrouteAll({ behavior: "wait" });
			await page.close();
		}
	}
	console.log("Admin Deck route loads its decisions at 375px and 1280px.");
} finally {
	await browser.close();
	await server.stop();
}
