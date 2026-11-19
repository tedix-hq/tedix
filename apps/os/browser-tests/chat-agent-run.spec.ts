import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * A run a tedi started for an agent shows as a card in the chat, read from
 * the stored events of the tedi's turn: it is there on first load and after a
 * reload, lists the newest eight steps with the rest one click away, links to
 * the task, has no follow-up box, and asks before stopping. Desktop light and
 * phone dark. Set TEDIX_SCREENSHOT_DIR to save screenshots.
 */
const CHAT = "/chat?conversation=00000060-0000-4000-8000-00000000000a";
const TASK = "/work/items/00000070-0000-4000-8000-000000000001";

const server = await startFixtureServer();
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
		await page.goto(`${server.origin}${CHAT}`);
		const card = page.locator('[data-slot="agent-run-card"]');
		const entries = card.getByRole("list", { name: "Run steps" }).locator("li");
		for (const pass of ["first load", "reload"]) {
			if (pass === "reload") await page.reload();
			await entries.first().waitFor();
			assert.equal(await card.count(), 1, `one card on ${pass}`);
		}
		await card.getByText("Fix paging in the churn cohort report").waitFor();
		assert.match(
			await card.locator('[data-slot="agent-run-executor"]').innerText(),
			/Codex/,
		);
		assert.match(
			await card.locator('[data-slot="agent-run-status"]').innerText(),
			/^Running/,
		);
		assert.equal(await entries.count(), 8);
		assert.equal(await card.locator("textarea").count(), 0);
		assert.equal(
			await card.getByRole("link", { name: "Open task" }).getAttribute("href"),
			TASK,
		);
		const overflow = () =>
			page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		assert.equal(await overflow(), false, `card overflows at ${width}`);
		if (process.env.TEDIX_SCREENSHOT_DIR) {
			await card
				.getByRole("link", { name: "Open task" })
				.scrollIntoViewIfNeeded();
			await page.screenshot({
				path: `${process.env.TEDIX_SCREENSHOT_DIR}/chat-run-card-${theme}.png`,
			});
		}

		await card.getByRole("button", { name: "Show all 9 steps" }).click();
		assert.equal(await entries.count(), 9);
		assert.equal(await overflow(), false, `open card overflows at ${width}`);

		// Stopping asks first; declining leaves the run as it was.
		await card.getByRole("button", { name: "Stop run" }).click();
		const dialog = page.getByRole("alertdialog", { name: "Stop this run?" });
		await dialog.waitFor();
		await dialog.getByRole("button", { name: "Keep running" }).click();
		await dialog.waitFor({ state: "hidden" });
		await card.getByRole("button", { name: "Stop run" }).waitFor();
		if (theme === "dark") {
			// A question the agent asks shows on the card; the person answers
			// there in their own words. Checked once, last, because the messages
			// stay in the sample data. The sample agent asks back when a
			// follow-up sent from the task page mentions a question.
			await page.goto(`${server.origin}${TASK}`);
			const taskRun = page.getByRole("region", { name: "Run", exact: true });
			await taskRun
				.getByLabel("Send a follow-up")
				.fill(`Ask me a question (${theme})`);
			await taskRun.getByRole("button", { name: "Send", exact: true }).click();
			await taskRun.getByRole("group", { name: "The agent asks" }).waitFor();
			await page.goto(`${server.origin}${CHAT}`);
			const asks = card.getByRole("group", { name: "The agent asks" });
			await asks.getByText("Should the last page be empty").waitFor();
			assert.equal(await overflow(), false, `question overflows at ${width}`);
			await asks.getByLabel("Your answer").fill("Leave it out, please");
			await asks.getByRole("button", { name: "Answer" }).click();
			await asks.waitFor({ state: "detached" });
			await card.getByText("You: Leave it out, please").waitFor();
		}
		await page.close();
		console.log(`Chat run card ${width}x${height} ${theme} passed`);
	}
} finally {
	await browser?.close();
	await server.stop();
}
