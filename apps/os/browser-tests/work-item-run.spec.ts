import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * The Run section of a task page: a run in progress lists its steps with the
 * waiting follow-up, takes a new follow-up and asks before stopping; a
 * finished run shows its steps and no controls. Desktop light and phone dark.
 */
const LIVE = "/work/items/00000070-0000-4000-8000-000000000001";
const FINISHED = "/work/items/00000070-0000-4000-8000-000000000004";

const server = await startFixtureServer();
const { origin } = server;
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const { width, height, theme } of [
		{ width: 1280, height: 900, theme: "light" },
		{ width: 375, height: 812, theme: "dark" },
	] as const) {
		const page = await browser.newPage({
			viewport: { width, height },
			colorScheme: theme,
		});
		const overflow = () =>
			page.evaluate(() => document.documentElement.scrollWidth > innerWidth);

		await page.goto(`${origin}${LIVE}`);
		const run = page.getByRole("region", { name: "Run", exact: true });
		const steps = run.getByRole("list", { name: "Run steps" });
		await steps.waitFor();
		assert.match(await run.getByRole("status").innerText(), /^Running/);
		assert.equal(await steps.locator("[data-run-step]").count(), 8);
		const waiting = steps.locator("[data-run-message=follow_up]").first();
		assert.match(await waiting.innerText(), /Also keep the old export column/);
		assert.match(
			await waiting.innerText(),
			/Waiting for the current step to finish/,
		);
		// The list opens on its newest step.
		assert.equal(
			await steps.evaluate(
				(list) => list.scrollHeight - list.scrollTop - list.clientHeight < 2,
			),
			true,
			"the step list starts at the newest step",
		);
		assert.equal(
			await run.evaluate((section) => {
				const updates = [...document.querySelectorAll("h2")].find(
					(heading) => heading.textContent === "Updates",
				);
				return Boolean(
					updates &&
					section.compareDocumentPosition(updates) &
						Node.DOCUMENT_POSITION_FOLLOWING,
				);
			}),
			true,
			"Run sits above Updates",
		);
		assert.equal(await overflow(), false, `Run overflows at ${width}/${theme}`);
		if (process.env.TEDIX_SCREENSHOT_DIR) {
			await run.scrollIntoViewIfNeeded();
			await page.screenshot({
				path: `${process.env.TEDIX_SCREENSHOT_DIR}/run-view-${theme}.png`,
			});
		}

		const followUp = `Add a test for the last page (${theme})`;
		await run.getByLabel("Send a follow-up").fill(followUp);
		await run.getByRole("button", { name: "Send", exact: true }).click();
		await steps.getByText(`You: ${followUp}`).waitFor();
		assert.equal(await run.getByLabel("Send a follow-up").inputValue(), "");

		// Stopping asks first; declining leaves the run as it was.
		await run.getByRole("button", { name: "Stop run" }).click();
		const dialog = page.getByRole("alertdialog", { name: "Stop this run?" });
		await dialog.waitFor();
		await dialog.getByRole("button", { name: "Keep running" }).click();
		await dialog.waitFor({ state: "hidden" });
		assert.match(await run.getByRole("status").innerText(), /^Running/);

		await page.goto(`${origin}${FINISHED}`);
		await steps.waitFor();
		assert.match(
			await run.getByRole("status").innerText(),
			/^Finished 12m ago: succeeded$/,
		);
		assert.equal(await steps.locator("[data-run-step]").count(), 5);
		assert.equal(await run.locator("textarea, button").count(), 0);
		assert.equal(await overflow(), false, `Run overflows at ${width}/${theme}`);
		if (process.env.TEDIX_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEDIX_SCREENSHOT_DIR}/run-view-finished-${theme}.png`,
			});
		await page.close();
		console.log(
			`Task run ${width}x${height} ${theme}: steps, waiting follow-up, send, stop confirm and finished run passed`,
		);
	}
} finally {
	await browser?.close();
	await server.stop();
}
