import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * A project page at phone and desktop width, light and dark: the summary
 * reads in plain words, contributors are grouped with a count, each row
 * names its Work item once and its source as "Local · <harness>", raw session
 * keys never show, and nothing widens the page.
 */
const PROJECT = "/work/projects/00000076-0000-4000-8000-000000000001";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/project-contributors/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
const backgrounds = new Map<string, string>();
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			await page.goto(`${server.origin}${PROJECT}`);
			const section = page.getByRole("region", { name: "Contributors" });
			const rows = section.locator("li[data-contributor-state]");
			await rows.first().waitFor();

			const summary = await page
				.getByLabel("Project summary")
				.first()
				.innerText();
			assert.match(summary, /Progress/, `${label}: progress label`);
			assert.match(summary, /\d+ of \d+ Work items done/, `${label}: counts`);
			assert.ok(!summary.includes("Outcome progress"), `${label}: plain label`);

			const text = await section.innerText();
			assert.match(text, /Active · \d+/, `${label}: active group`);
			assert.match(text, /Local · (Codex|Claude)/, `${label}: source label`);
			for (const noise of ["Local session", "local-session-", "attempt"])
				assert.ok(!text.includes(noise), `${label}: no "${noise}"`);

			// A Work item title appears once per row.
			for (const row of await rows.all()) {
				const link = row.locator("a[href^='/work/items/']");
				if (!(await link.count())) continue;
				const title = (await link.innerText()).trim();
				const rowText = await row.innerText();
				assert.equal(
					rowText.split(title).length - 1,
					1,
					`${label}: "${title}" shown once`,
				);
			}

			assert.ok(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${label}: no horizontal page scroll`,
			);
			backgrounds.set(
				label,
				await page.evaluate(
					() => getComputedStyle(document.body).backgroundColor,
				),
			);
			await section.screenshot({
				path: `${evidence}/contributors-${width}-${theme}.png`,
			});
			await page.screenshot({
				path: `${evidence}/project-${width}-${theme}.png`,
				fullPage: true,
			});
			await page.close();
			console.log(`project contributors ${label}: ok`);
		}
	for (const width of [375, 1280])
		assert.notEqual(
			backgrounds.get(`${width}/light`),
			backgrounds.get(`${width}/dark`),
			`${width}: dark theme applies`,
		);
	console.log(`PASS: project contributors; screenshots in ${evidence}`);
} finally {
	await browser.close();
	await server.stop();
}
