import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { runTimelineFixture } from "../dev/run-timeline-fixture";
import { startFixtureServer } from "./fixture-server";

const runId = "00000021-0000-4000-8000-000000000002";
const path = `/work/runs/${runId}`;
const startedAt = "2026-10-27T12:00:00.000Z";
const completedAt = "2026-10-27T12:02:05.000Z";
const timeline = runTimelineFixture({
	id: runId,
	status: "failed",
	startedAt,
	completedAt,
	executionEpoch: 0,
});
const server = await startFixtureServer(path);
const evidenceDir = process.env.RUN_TIMELINE_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}-${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			page.setDefaultTimeout(15000);
			let partial = false;
			let unavailable = false;
			let artifactReads = 0;
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== server.origin) return route.abort("blockedbyclient");
				if (url.pathname.endsWith("/skills/getWorkflowRunTimeline")) {
					if (unavailable)
						return route.fulfill({
							status: 500,
							json: { json: { message: "Timeline read failed" } },
						});
					const value = partial
						? {
								...timeline,
								coverage: "partial",
								events: [
									{
										...timeline.events[0]!,
										startedAt: null,
										endedAt: null,
										durationMs: null,
									},
								],
								warnings: ["Historical receipts are incomplete."],
							}
						: timeline;
					return route.fulfill({ json: { json: value } });
				}
				if (url.pathname.endsWith("/skills/inspectWorkflowRun")) {
					const response = await route.fetch();
					const body = await response.json();
					Object.assign(body.json.run, { startedAt, completedAt });
					return route.fulfill({ response, json: body });
				}
				if (url.pathname.endsWith("/skills/getRunArtifact")) {
					artifactReads++;
					const input = route.request().postDataJSON().json;
					if (input.path === timeline.events[2]!.path) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify({
							sensitiveOutput: true,
							outputArtifactPath: "outputs/private.json",
							response: "must stay hidden",
						});
						return route.fulfill({ response, json: body });
					}
					assert.notEqual(
						input.path,
						"outputs/private.json",
						"sensitive output is never fetched",
					);
				}
				if (url.pathname.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			await page.goto(`${server.origin}${path}`);
			const chart = page.locator("[data-run-timeline]");
			await chart.waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(await page.locator("html").getAttribute("data-mode"), theme);
			assert.equal(
				await chart.locator("[data-timeline-event]").count(),
				251,
				`${label}: no 128-receipt cap`,
			);
			assert.equal(
				artifactReads,
				0,
				`${label}: no receipt body fanout on initial load`,
			);
			assert.equal(await chart.locator("[data-outcome=failure]").count(), 1);
			assert.equal(await chart.locator("[data-wait=true]").count(), 1);
			assert.equal(
				await page.getByRole("heading", { name: "Steps", exact: true }).count(),
				0,
				"legacy list collapsed",
			);
			const first = chart.locator("[data-timeline-event]").first();
			const geometry = await first.evaluate((element) => ({
				left: element.style.left,
				width: element.style.width,
			}));
			assert(geometry.left.includes("0%"));
			assert.equal(geometry.width, "1.6%");
			const waitRatio = await chart
				.locator("[data-wait=true]")
				.evaluate(
					(element) =>
						element.getBoundingClientRect().width /
						element.parentElement!.getBoundingClientRect().width,
				);
			assert(
				Math.abs(waitRatio - 0.32) < 0.002,
				`${label}: rendered wait width follows its duration`,
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${label}: no page overflow`,
			);
			await chart.evaluate((element) =>
				element.scrollIntoView({ block: "start" }),
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/timeline-${label}.png`,
					fullPage: true,
				});
			await first.focus();
			await page.keyboard.press("Enter");
			const drawer = page.getByRole("dialog");
			await drawer.getByText("Sample truncated", { exact: false }).waitFor();
			assert.equal(artifactReads, 1);
			assert(
				(await drawer.locator("[data-output-sample]").innerText()).length <
					4100,
			);
			assert.equal(await drawer.getByText("2s", { exact: true }).count(), 1);
			if (evidenceDir)
				await page.screenshot({ path: `${evidenceDir}/drawer-${label}.png` });
			await page.keyboard.press("Escape");
			await drawer.waitFor({ state: "hidden" });
			assert(
				await first.evaluate((element) => element === document.activeElement),
				`${label}: focus restored`,
			);
			const failure = chart.locator("[data-outcome=failure]");
			await failure.focus();
			await page.keyboard.press("Enter");
			await drawer.getByText(/Storefront temporarily unavailable/).waitFor();
			await drawer.getByRole("button", { name: "Close", exact: true }).click();
			const lateCall = chart.locator(
				`[data-timeline-event="${timeline.events[248]!.id}"]`,
			);
			await lateCall.focus();
			await page.keyboard.press("Enter");
			await drawer.locator("[data-output-sample]").waitFor();
			await page.keyboard.press("Escape");
			const sensitiveCall = chart.locator(
				`[data-timeline-event="${timeline.events[2]!.id}"]`,
			);
			await sensitiveCall.focus();
			await page.keyboard.press("Enter");
			await drawer
				.getByText("Sensitive output is hidden.", { exact: true })
				.waitFor();
			assert.equal(
				await drawer.getByText("must stay hidden", { exact: true }).count(),
				0,
			);
			assert.equal(artifactReads, 4, "only selected receipts are read");
			await page.keyboard.press("Escape");
			await page
				.getByRole("button", { name: "Step list and evidence", exact: true })
				.click();
			await page.getByRole("heading", { name: "Steps", exact: true }).waitFor();
			partial = true;
			await page.reload();
			await page.getByText(/Partial history/).waitFor();
			await page
				.getByRole("heading", { name: "Timing unknown (1)", exact: true })
				.waitFor();
			assert.equal(await page.locator("[data-timeline-event]").count(), 0);
			unavailable = true;
			await page.reload();
			await page
				.getByText("Timeline unavailable", { exact: true })
				.waitFor({ timeout: 30000 });
			unavailable = false;
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await page.getByText(/Partial history/).waitFor();
			await page.close();
			console.log(`run timeline ${label}: ok`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
