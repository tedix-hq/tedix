import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * A run a tedi started for an agent shows as a card in the chat, read from
 * the stored events of the tedi's turn: it is there on first load and after a
 * reload, lists the newest eight steps with the rest one click away, links to
 * the task, asks before stopping, and keeps historical questions readable
 * without answer controls. Set TEDIX_SCREENSHOT_DIR to save a phone screenshot.
 */
const CHAT = "/chat?conversation=00000060-0000-4000-8000-00000000000a";
const TASK = "/work/items/00000070-0000-4000-8000-000000000001";

const server = await startFixtureServer(undefined, { shared: false });
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 375, height: 812 },
		colorScheme: "dark",
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
	assert.equal(await overflow(), false, `card overflows at 375px`);
	if (process.env.TEDIX_SCREENSHOT_DIR) {
		await card
			.getByRole("link", { name: "Open task" })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: `${process.env.TEDIX_SCREENSHOT_DIR}/chat-run-card-dark.png`,
		});
	}

	// The launch step heads the card, so all eight remaining steps show.
	await card.getByText("The agent started working on this task.").waitFor();
	assert.equal(
		await card.getByRole("button", { name: /^Show all/ }).count(),
		0,
	);

	// Stopping asks first; declining leaves the run as it was.
	await card.getByRole("button", { name: "Stop run" }).click();
	const dialog = page.getByRole("alertdialog", { name: "Stop this run?" });
	await dialog.waitFor();
	await dialog.getByRole("button", { name: "Keep running" }).click();
	await dialog.waitFor({ state: "hidden" });
	await card.getByRole("button", { name: "Stop run" }).waitFor();

	// Historical questions remain in the log; decisions use Work Interactions.
	await page.goto(`${server.origin}${TASK}`);
	const taskRun = page.getByRole("region", { name: "Run", exact: true });
	await taskRun.getByLabel("Send a follow-up").fill("Ask me a question");
	await taskRun.getByRole("button", { name: "Send", exact: true }).click();
	await taskRun
		.getByText("Should the last page be empty", { exact: false })
		.waitFor();
	await page.goto(`${server.origin}${CHAT}`);
	await card
		.getByText("Should the last page be empty", { exact: false })
		.waitFor();
	assert.equal(
		await card.getByRole("group", { name: "The agent asks" }).count(),
		0,
	);
	assert.equal(await card.getByLabel("Your answer").count(), 0);
	assert.equal(await entries.count(), 8);
	await card.getByRole("button", { name: "Show all 10 steps" }).click();
	assert.equal(await entries.count(), 10);
	assert.equal(await overflow(), false, `open card overflows at 375px`);
	console.log("Chat run card on a phone passed");
} finally {
	await browser?.close();
	await server.stop();
}
