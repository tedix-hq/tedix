import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const output =
	process.env.WORK_RESILIENCE_SCREENSHOTS ?? "/tmp/work-resilience-screenshots";
await mkdir(output, { recursive: true });
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{
		cwd,
		stdout: "ignore",
		stderr: "inherit",
		detached: true,
	},
);
let browser: Browser | undefined;
try {
	await waitForFixtureServer(`${origin}/browser-tests/feed-deck-polish.html`, {
		server,
	});
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
	});
	const fixture = `${origin}/browser-tests/feed-deck-polish.html?shell&surface=question&motion=reduced`;
	await page.goto(`${fixture}&resilience=ready`);
	const answer = page.getByRole("textbox", {
		name: "Your answer",
		exact: true,
	});
	await answer.fill("Friday works for us.");
	await page.evaluate(() =>
		window.dispatchEvent(new Event("work-resilience:fail")),
	);
	await page
		.getByText("Some items couldn't load", {
			exact: true,
		})
		.waitFor();
	if (await page.locator('[role="alert"]').count())
		throw new Error("Partial failure rendered a full error banner");
	if (
		(await page.getByRole("button", { name: "Retry", exact: true }).count()) !==
		1
	)
		throw new Error("Stacked retry states");
	if ((await answer.inputValue()) !== "Friday works for us.")
		throw new Error("Refresh failure lost the answer");
	await page.screenshot({
		path: `${output}/work-resilience-degraded.png`,
		fullPage: true,
	});
	await page
		.locator('[data-slot="load-error"]')
		.getByRole("button", { name: "Details", exact: true })
		.click();
	await page
		.getByText("Support reference: 11111111-1111-4111-8111-111111111111", {
			exact: true,
		})
		.waitFor();
	await page.screenshot({
		path: `${output}/work-resilience-details.png`,
		fullPage: true,
	});
	let refreshes = 0;
	page.on("request", (request) => {
		if (request.url().includes("workInteractions")) refreshes++;
	});
	await page.evaluate(() =>
		document.dispatchEvent(new Event("visibilitychange")),
	);
	await page.waitForTimeout(150);
	if (refreshes) throw new Error("Visibility restarted exhausted retries");
	if ((await answer.inputValue()) !== "Friday works for us.")
		throw new Error("Focus refresh replaced the card");
	await page.evaluate(() =>
		window.dispatchEvent(new Event("work-resilience:recover")),
	);
	await page
		.getByText("Some items couldn't load", {
			exact: true,
		})
		.waitFor({ state: "hidden" });
	if ((await answer.inputValue()) !== "Friday works for us.")
		throw new Error("Recovery lost the answer");
	await page.screenshot({
		path: `${output}/work-resilience-recovered.png`,
		fullPage: true,
	});
	await page.goto(`${fixture}&resilience=empty`);
	await page
		.getByText("Tedix couldn't load this view", { exact: true })
		.waitFor();
	if ((await page.locator('[role="alert"]').count()) !== 1)
		throw new Error("Full failure needs exactly one banner");
	await page.screenshot({
		path: `${output}/work-resilience-empty.png`,
		fullPage: true,
	});
	console.log(
		"Work resilience: partial/full failure, answer retention, focus and recovery passed",
	);
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
