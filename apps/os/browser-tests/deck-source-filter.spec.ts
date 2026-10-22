import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { createDeckSourceFixture, chooseSource } from "./deck-source-fixture";

const { origin, fixture, workspaceName, title, close } =
	await createDeckSourceFixture();
const shots = process.env.TEDIX_SCREENSHOT_DIR;
const browser = await chromium.launch({ headless: true });
try {
	async function fits(page: Page, what: string) {
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`${what} fits without horizontal scroll`,
		);
	}
	const deckCard = (page: Page, index: number) =>
		page.getByRole("region", { name: title(index) });

	for (const width of [390, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await fixture(page);

		await page.goto(`${origin}/work?view=deck`);
		await page
			.getByRole("region", { name: /Review the fictional|Pick the fictional/ })
			.first()
			.waitFor();
		await chooseSource(page, "Social");
		await deckCard(page, 1).waitFor();
		assert.equal(
			new URL(page.url()).searchParams.get("source"),
			"factory:Social",
		);
		await page.reload();
		await deckCard(page, 1).waitFor();
		await fits(page, `Deck at ${width}px`);
		if (shots) {
			await mkdir(shots, { recursive: true });
			await page.screenshot({
				path: `${shots}/deck-source-social-${width}.png`,
				fullPage: true,
			});
		}
		await chooseSource(page, "Work");
		await deckCard(page, -1).waitFor();
		await page.goBack();
		await deckCard(page, 1).waitFor();
		assert.equal(
			new URL(page.url()).searchParams.get("source"),
			"factory:Social",
		);
		await page.goForward();
		await deckCard(page, -1).waitFor();
		await chooseSource(page, `In ${workspaceName}`);
		await page
			.getByRole("region", { name: /Review the fictional (inbox|social)/ })
			.waitFor();

		await page.goto(`${origin}/work?view=feed`);
		const inbox = page.getByRole("link", {
			name: /Review the fictional inbox opportunity/,
		});
		const social = page.getByRole("link", {
			name: /Review the fictional social opportunity/,
		});
		await social.waitFor();
		await inbox.waitFor();
		await chooseSource(page, "Inbox");
		await social.waitFor({ state: "detached" });
		assert(await inbox.isVisible(), "Inbox stays when filtering to Inbox");
		assert.equal(
			new URL(page.url()).searchParams.get("source"),
			"factory:Inbox",
		);
		await page.reload();
		await inbox.waitFor();
		assert.equal(await social.count(), 0);
		await fits(page, `Feed at ${width}px`);
		if (shots)
			await page.screenshot({
				path: `${shots}/feed-source-inbox-${width}.png`,
				fullPage: true,
			});
		await chooseSource(page, "Work");
		await inbox.waitFor({ state: "detached" });
		await page.goBack();
		await inbox.waitFor();
		assert.equal(
			new URL(page.url()).searchParams.get("source"),
			"factory:Inbox",
		);
		assert.equal(await social.count(), 0);
		await chooseSource(page, "All sources");
		await social.waitFor();
		assert.equal(new URL(page.url()).searchParams.has("source"), false);
		await page.close();
	}
	console.log("Deck and Feed source filter at 390px and 1280px passed.");
} finally {
	await browser.close();
	await close();
}
