import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const evidence =
	process.env.SCHEDULE_CONTROLS_EVIDENCE_DIR ??
	join(
		process.env.TEDIX_LANE_LOG ? dirname(process.env.TEDIX_LANE_LOG) : "/tmp",
		"skill-schedule-controls",
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
	id: "schedule-1",
	organizationId: "example",
	skillId: "alpha",
	tediId: "worker",
	cron: "0 9 * * *",
	params: {},
	enabled: true,
	nextFireAt: "2026-10-22T09:00:00Z",
	lastFireAt: null,
	lastRunId: null,
	lastError: null,
	lastBudgetBlockedAt: null,
	lastBudgetBlockedReason: null,
	lastBudgetAdmissionClass: null,
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
				await fetch(`${origin}/browser-tests/skill-schedule-controls.html`)
			).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Fixture server readiness timeout");
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
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
			const schedule = { ...base };
			const writes: Record<string, unknown>[] = [];
			await page.route("**/api/**", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				if (url.pathname.endsWith("/skills/updateSchedule")) {
					const input = request.postDataJSON()?.json as {
						id: string;
						cron?: string;
						enabled?: boolean;
					};
					writes.push(input);
					if (input.cron !== undefined) schedule.cron = input.cron;
					if (input.enabled !== undefined) schedule.enabled = input.enabled;
					if (schedule.enabled) schedule.nextFireAt = "2026-10-22T21:30:00Z";
					return route.fulfill({
						json: {
							json: {
								skillId: "alpha",
								slug: "alpha-skill",
								action: "updated",
								changed: true,
								cron: schedule.cron,
								scheduleEnabled: schedule.enabled,
								nextFireAt: schedule.enabled ? schedule.nextFireAt : null,
							},
						},
					});
				}
				if (!url.pathname.endsWith("/skills/listWorkflowSchedules"))
					throw new Error(`Unexpected API call ${url.pathname}`);
				return route.fulfill({
					json: {
						json: {
							schedules: [schedule],
							total: 1,
							offset: 0,
							limit: 200,
							nextOffset: null,
						},
					},
				});
			});
			await page.goto(
				`${origin}/browser-tests/skill-schedule-controls.html?theme=${theme}`,
			);
			await page.getByText(/Next run /).waitFor();
			// Turn the schedule off; the change is written and confirmed in words.
			await page.getByRole("button", { name: "Turn off", exact: true }).click();
			await page
				.getByText("Off — it will not run again until you turn it back on.", {
					exact: true,
				})
				.waitFor();
			assert.deepEqual(writes.at(-1), { id: "alpha", enabled: false });
			await page.getByText("Paused · not scheduled", { exact: true }).waitFor();
			// Turn it back on.
			await page.getByRole("button", { name: "Turn on", exact: true }).click();
			await page.getByText(/On — runs daily at 9 AM \(UTC\)/).waitFor();
			assert.deepEqual(writes.at(-1), { id: "alpha", enabled: true });
			// Change the time through the dialog.
			await page
				.getByRole("button", { name: "Change time", exact: true })
				.click();
			await page.getByText("Change schedule", { exact: true }).waitFor();
			await page.getByLabel("Time (UTC)").fill("21:30");
			await page
				.getByText("Runs daily at 9:30 PM (UTC)", { exact: true })
				.waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.getByText(/On — runs daily at 9:30 PM \(UTC\)/).waitFor();
			assert.deepEqual(writes.at(-1), { id: "alpha", cron: "30 21 * * *" });
			const measurement = await page.evaluate(() => ({
				viewport: { width: innerWidth, height: innerHeight },
				theme: document.documentElement.dataset.mode,
				scrollWidth: document.documentElement.scrollWidth,
				targets: [...document.querySelectorAll("button")].map((node) => {
					const r = node.getBoundingClientRect();
					return { text: node.textContent, width: r.width, height: r.height };
				}),
			}));
			assert.deepEqual(measurement.viewport, viewport);
			assert.equal(measurement.theme, theme);
			assert(
				measurement.scrollWidth <= viewport.width,
				`Overflow ${JSON.stringify(measurement)}`,
			);
			const visibleTargets = measurement.targets.filter(
				(target) => target.width > 0 && target.height > 0,
			);
			assert(
				visibleTargets.every(
					(target) => target.width >= 44 && target.height >= 44,
				),
				`Small target ${JSON.stringify(measurement.targets)}`,
			);
			const screenshot = `${evidence}/${viewport.width}x${viewport.height}-${theme}.png`;
			await page.screenshot({ path: screenshot, fullPage: false });
			assert.equal(errors.length, 0, errors.join("\n"));
			receipts.push({ viewport, theme, writes, screenshot });
			await page.close();
		}
	console.log("Skill schedule controls: four viewport/theme checks passed");
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
