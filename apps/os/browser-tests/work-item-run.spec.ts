import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * The Run section of a task page: a run in progress lists its steps with the
 * waiting follow-up, refreshes by asking only for the steps after the last
 * one shown without moving a reader who scrolled up, takes a new follow-up
 * that still reads "You" after a reload, and asks before stopping; a finished
 * run shows its steps and no controls. Desktop light and phone dark.
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

		const stepReads: { afterSeq?: number }[] = [];
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (!url.pathname.endsWith("/workItems/listAttemptSteps")) return;
			const data =
				request.method() === "GET"
					? JSON.parse(url.searchParams.get("data") ?? "{}")
					: request.postDataJSON();
			stepReads.push(data?.json ?? data);
		});

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

		// A refresh asks only for steps after the last one shown, and leaves a
		// reader who scrolled up, and the rows already drawn, where they were.
		assert.equal(stepReads[0]?.afterSeq, undefined);
		await steps.evaluate((list) => {
			list.scrollTop = 0;
			list.firstElementChild!.setAttribute("data-kept", "");
		});
		const before = stepReads.length;
		await page.waitForRequest(
			(request) => request.url().includes("/workItems/listAttemptSteps"),
			{ timeout: 10_000 },
		);
		await page.waitForRequest(
			(request) => request.url().includes("/workItems/listAttemptSteps"),
			{ timeout: 10_000 },
		);
		assert.ok(stepReads.length > before);
		assert.deepEqual(
			stepReads.slice(1).map((read) => read.afterSeq),
			stepReads.slice(1).map(() => 7),
			"every refresh reads only after the last step shown",
		);
		assert.deepEqual(
			await steps.evaluate((list) => [
				list.scrollTop,
				list.firstElementChild!.hasAttribute("data-kept"),
			]),
			[0, true],
			"a refresh with nothing new leaves the list where the reader was",
		);

		const followUp = `Add a test for the last page (${theme})`;
		await run.getByLabel("Send a follow-up").fill(followUp);
		await run.getByRole("button", { name: "Send", exact: true }).click();
		await steps.getByText(`You: ${followUp}`).waitFor();
		assert.equal(await run.getByLabel("Send a follow-up").inputValue(), "");
		await page.reload();
		await steps.getByText(`You: ${followUp}`).waitFor();

		// "Send now" marks the follow-up as one that stops the current step.
		const urgent = `Use the other branch (${theme})`;
		await run.getByLabel("Send a follow-up").fill(urgent);
		await run.getByRole("button", { name: "Send now" }).click();
		await steps
			.locator("li", { hasText: `You: ${urgent}` })
			.getByText("Stopping the current step to apply this")
			.waitFor();

		// A question the agent asks shows with its offered answers; picking
		// one sends it as the answer and the question closes.
		await run
			.getByLabel("Send a follow-up")
			.fill(`Ask me a question (${theme})`);
		await run.getByRole("button", { name: "Send", exact: true }).click();
		const asks = run.getByRole("group", { name: "The agent asks" });
		await asks.getByText("Should the last page be empty").waitFor();
		assert.equal(await overflow(), false, `question overflows at ${width}`);
		await asks.getByRole("button", { name: "Leave it out" }).click();
		await asks.waitFor({ state: "detached" });
		// The first viewport's answer is still in the sample data.
		await steps.getByText("You: Leave it out").last().waitFor();

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
