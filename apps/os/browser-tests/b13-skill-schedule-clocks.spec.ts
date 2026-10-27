import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const evidence =
	process.env.B13_SCHEDULE_EVIDENCE_DIR ??
	join(
		process.env.TEDIX_LANE_LOG ? dirname(process.env.TEDIX_LANE_LOG) : "/tmp",
		"b13-skill-schedule-clocks",
	);
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--strictPort",
	],
	{
		cwd,
		stdout: Bun.file(`${evidence}/server.stdout.log`),
		stderr: Bun.file(`${evidence}/server.stderr.log`),
		env: { ...process.env, VITE_LIVE_API: "0" },
	},
);
const now = "2026-10-21T12:00:00Z";
const base = {
	organizationId: "example",
	skillId: "alpha",
	tediId: "worker",
	cron: "0 13 * * *",
	params: {},
	enabled: true,
	nextFireAt: "2026-10-21T13:00:00Z",
};
const schedules = [
	{
		...base,
		id: "future",
		lastFireAt: "2026-10-21T10:00:00Z",
		lastRunId: "run-example",
		lastError: `Read failed: ${"unbroken".repeat(45)}`,
		lastBudgetBlockedAt: "2026-10-21T11:00:00Z",
		lastBudgetBlockedReason: "Daily limit",
		lastBudgetAdmissionClass: "background",
	},
	{
		...base,
		id: "paused-future",
		enabled: false,
		cron: `${"0,".repeat(120)}0 13 * * *`,
	},
	{
		...base,
		id: "paused-past",
		enabled: false,
		nextFireAt: "2026-10-21T11:00:00Z",
	},
	{ ...base, id: "past", nextFireAt: "2026-10-21T11:00:00Z" },
	{ ...base, id: "current", nextFireAt: now },
	{ ...base, id: "invalid", nextFireAt: "invalid" },
];
type Fixture = Window & {
	scheduleFixture: { refresh(): Promise<void>; navigate(): Promise<void> };
};
const receipts: unknown[] = [];
let browser: Browser | undefined;
let ready = false;
try {
	for (let i = 0; i < 120; i++) {
		if (server.exitCode !== null)
			throw new Error(`Server exited before readiness: ${server.exitCode}`);
		try {
			ready = (
				await fetch(`${origin}/browser-tests/b13-skill-schedule-clocks.html`)
			).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Fixture server readiness timeout");
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport,
				colorScheme: theme,
				hasTouch: viewport.width < 500,
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			await page.clock.setFixedTime(new Date(now));
			let failure = true;
			let reads = 0;
			let betaReads = 0;
			const methods: string[] = [];
			await page.route("**/api/**", async (route) => {
				const request = route.request();
				methods.push(request.method());
				const url = new URL(request.url());
				if (!url.pathname.endsWith("/skills/listWorkflowSchedules"))
					throw new Error(`Unexpected API call ${url.pathname}`);
				const input =
					request.method() === "GET"
						? JSON.parse(url.searchParams.get("data") ?? "{}").json
						: request.postDataJSON()?.json;
				reads++;
				if (input?.skillId === "beta") {
					betaReads++;
					return route.fulfill({
						json: {
							json: {
								schedules: [],
								total: 0,
								offset: 0,
								limit: 200,
								nextOffset: null,
							},
						},
					});
				}
				if (failure)
					return route.fulfill({
						status: 503,
						json: {
							json: {
								defined: false,
								code: "SERVICE_UNAVAILABLE",
								message: `Discovery failed: ${"long-error".repeat(50)}`,
							},
						},
					});
				return route.fulfill({
					json: {
						json: {
							schedules,
							total: schedules.length,
							offset: 0,
							limit: 200,
							nextOffset: null,
						},
					},
				});
			});
			await page.goto(
				`${origin}/browser-tests/b13-skill-schedule-clocks.html?theme=${theme}`,
			);
			const retry = page.getByRole("button", {
				name: "Retry",
				exact: true,
			});
			await retry.waitFor();
			await page.keyboard.press("Tab");
			await retry.focus();
			const focus = await retry.evaluate((node) => {
				const s = getComputedStyle(node);
				const r = node.getBoundingClientRect();
				return {
					focused: node === document.activeElement,
					visible: node.matches(":focus-visible"),
					outline: s.outlineStyle,
					shadow: s.boxShadow,
					width: r.width,
					height: r.height,
				};
			});
			assert(
				focus.focused &&
					focus.visible &&
					(focus.outline !== "none" || focus.shadow !== "none"),
			);
			assert(focus.width >= 44 && focus.height >= 44);
			failure = false;
			await page.keyboard.press("Enter");
			await page.getByText(/Next run in 1h/).waitFor();
			assert.equal(
				await page.getByText("Paused · not scheduled", { exact: true }).count(),
				2,
			);
			assert.equal(
				await page.getByText("Next run unavailable", { exact: true }).count(),
				3,
			);
			await page
				.getByText("Cron timezone: UTC · Timestamps: America/New_York", {
					exact: true,
				})
				.waitFor();
			failure = true;
			await page.evaluate(() => (window as Fixture).scheduleFixture.refresh());
			await page
				.getByText("Could not refresh schedules", { exact: true })
				.waitFor();
			await page.getByText(/Showing previously loaded schedules/).waitFor();
			await page.getByRole("link", { name: "Open latest run" }).waitFor();
			await page.evaluate(() => document.fonts.ready);
			const measurement = await page.evaluate(() => ({
				viewport: { width: innerWidth, height: innerHeight },
				theme: document.documentElement.dataset.mode,
				colorScheme: getComputedStyle(document.documentElement).colorScheme,
				background: getComputedStyle(document.body).backgroundColor,
				foreground: getComputedStyle(document.body).color,
				scrollWidth: document.documentElement.scrollWidth,
				targets: [...document.querySelectorAll("button,a")].map((node) => {
					const r = node.getBoundingClientRect();
					return { text: node.textContent, width: r.width, height: r.height };
				}),
			}));
			assert.deepEqual(measurement.viewport, viewport);
			assert.equal(measurement.theme, theme);
			assert.equal(measurement.colorScheme, theme);
			assert(
				measurement.scrollWidth <= viewport.width,
				`Overflow ${JSON.stringify(measurement)}`,
			);
			assert(
				measurement.targets.every(
					(target) => target.width >= 44 && target.height >= 44,
				),
			);
			const screenshot = `${evidence}/${viewport.width}x${viewport.height}-${theme}.png`;
			const png = await page.screenshot({ path: screenshot, fullPage: false });
			assert.equal(png.readUInt32BE(16), viewport.width);
			assert.equal(png.readUInt32BE(20), viewport.height);
			const fullScreenshot = `${evidence}/${viewport.width}x${viewport.height}-${theme}-full.png`;
			const fullPng = await page.screenshot({
				path: fullScreenshot,
				fullPage: true,
			});
			assert.equal(fullPng.readUInt32BE(16), viewport.width);
			assert.equal(
				fullPng.readUInt32BE(20),
				await page.evaluate(() => document.documentElement.scrollHeight),
			);
			failure = false;
			await retry.click();
			await page
				.getByText("Could not refresh schedules", { exact: true })
				.waitFor({ state: "hidden" });
			await page.evaluate(() => (window as Fixture).scheduleFixture.navigate());
			await page
				.getByText("This skill declares no schedules.", { exact: true })
				.waitFor();
			assert.equal(betaReads, 1);
			assert.equal(await page.getByText(/Next run in 1h/).count(), 0);
			const unexpectedErrors = errors.filter(
				(error) => !error.includes("503 (Service Unavailable)"),
			);
			assert.equal(unexpectedErrors.length, 0, unexpectedErrors.join("\n"));
			receipts.push({
				...measurement,
				focus,
				screenshot,
				screenshotDimensions: viewport,
				fullScreenshot,
				fullScreenshotDimensions: {
					width: fullPng.readUInt32BE(16),
					height: fullPng.readUInt32BE(20),
				},
				reads,
				betaReads,
				methods,
				errors,
			});
			await page.close();
		}
	console.log("Skill schedule clocks: six viewport/theme checks passed");
} catch (error) {
	for (const context of browser?.contexts() ?? []) {
		for (const page of context.pages()) {
			await writeFile(
				`${evidence}/failure.txt`,
				`${String(error)}\n${await page.locator("body").innerText()}`,
			);
			await page.screenshot({ path: `${evidence}/failure.png` });
		}
	}
	throw error;
} finally {
	await browser?.close();
	server.kill();
	const exitCode = await server.exited;
	await writeFile(
		`${evidence}/receipt.json`,
		JSON.stringify(
			{ origin, ready, serverExitCode: exitCode, receipts },
			null,
			2,
		),
	);
}
