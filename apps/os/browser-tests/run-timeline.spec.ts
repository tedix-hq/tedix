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
Object.assign(timeline.events[1]!, {
	kind: "step",
	path: "epochs/0/steps/search/2/attempts/1.json",
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
					body.json.warnings = [
						"70 R2 artifact body/bodies were omitted after the 128-read inspection limit was reached.",
					];
					return route.fulfill({ response, json: body });
				}
				if (url.pathname.endsWith("/skills/getRunArtifact")) {
					artifactReads++;
					const input = route.request().postDataJSON().json;
					if (input.path === timeline.events[1]!.path) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify({
							kind: "workflow_step_attempt",
							executionEpoch: 0,
							attempt: 1,
							step: { count: 2 },
							authorMetadata: {
								purpose: "Find buying questions",
								inputs: [
									{ name: "Settings", source: "Setup", sourceRevision: 35 },
								],
								usedNext: "Screen results",
							},
							request: {
								value: {
									query: "example buying question",
									limit: 10,
									text: `${"x".repeat(4500)} END-OF-INSTRUCTION`,
								},
								truncated: false,
							},
							response: {
								createdAt: 1793178000000,
								id: 1793178000000,
								data: {
									web: [
										{
											title: "A useful product question",
											url: "https://example.com/a/very/long/thread?source=search",
											description: "Saved search excerpt",
										},
									],
								},
							},
						});
						return route.fulfill({ response, json: body });
					}
					if (input.path === timeline.events[246]!.path) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify({
							response: {
								truncated: false,
								value: {
									ok: true,
									accepted: true,
									pending: true,
									assistant: null,
								},
							},
						});
						return route.fulfill({ response, json: body });
					}
					if (input.path === timeline.events[248]!.path) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify({
							response: {
								value: {
									ok: true,
									runId: "11111111-1111-4111-8111-111111111111:mcp:review",
									conversationId: "fictional-review",
									assistant: {
										content: '{"reason":"The question was already answered."}',
									},
								},
							},
						});
						return route.fulfill({ response, json: body });
					}
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
					if (input.path === timeline.events[4]!.path) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify({
							request: { redacted: true, value: { query: "hidden query" } },
							response: "hidden response",
							error: "hidden error",
						});
						return route.fulfill({ response, json: body });
					}
					if (input.path === timeline.events[6]!.path) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify({
							request: { value: { text: "concealed instruction" } },
							response: { redacted: true, value: "concealed response" },
						});
						return route.fulfill({ response, json: body });
					}
					if (
						input.path === timeline.events[5]!.path ||
						input.path === "outputs/foreign.json"
					) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.content = JSON.stringify(
							input.path === "outputs/foreign.json"
								? {
										stepCount: timeline.events[5]!.count,
										attempt: timeline.events[5]!.attempt,
										executionEpoch: 999,
										value: "another execution",
									}
								: { outputArtifactPath: "outputs/foreign.json" },
						);
						return route.fulfill({ response, json: body });
					}
					assert.notEqual(
						input.path,
						"outputs/private.json",
						"sensitive output is never fetched",
					);
				}
				if (url.pathname.endsWith("/cognitiveRuntime/readMessages")) {
					assert.deepEqual(route.request().postDataJSON().json, {
						tediId: "11111111-1111-4111-8111-111111111111",
						conversationId: "fictional-review",
						limit: 30,
					});
					return route.fulfill({
						json: {
							json: {
								messages: [
									{
										id: "saved-request",
										tediId: "11111111-1111-4111-8111-111111111111",
										conversationId: "fictional-review",
										role: "user",
										status: "completed",
										content: "Check whether the question is still open.",
										createdAt: startedAt,
									},
								],
								compaction: null,
								nextCursor: null,
							},
						},
					});
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
			await page
				.getByText(
					/70 saved records were not loaded because this page reached its loading limit/,
				)
				.waitFor();
			assert.equal(
				await page
					.getByText(
						"70 R2 artifact body/bodies were omitted after the 128-read inspection limit was reached.",
						{ exact: true },
					)
					.isVisible(),
				false,
				"raw recording message stays collapsed",
			);
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
			await drawer.getByText("What came back", { exact: true }).waitFor();
			await drawer.getByRole("button", { name: "Item 1", exact: true }).click();
			await drawer.getByText("paid", { exact: true }).waitFor();
			assert.equal(
				await drawer.getByRole("button", { name: /^Item \d+$/ }).count(),
				50,
				"large arrays remain bounded",
			);
			await drawer
				.getByRole("button", { name: "Technical details", exact: true })
				.click();
			await drawer.getByText("Sample truncated", { exact: false }).waitFor();
			assert.equal(artifactReads, 1);
			assert((await drawer.locator("pre").innerText()).length < 4100);
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
			await drawer
				.getByText("The question was already answered.", { exact: true })
				.waitFor();
			await drawer
				.getByRole("button", { name: "Read saved conversation", exact: true })
				.click();
			await drawer
				.getByText("Check whether the question is still open.", { exact: true })
				.waitFor();
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/conversation-${label}.png`,
				});
			await page.keyboard.press("Escape");
			await chart
				.getByRole("textbox", { name: "Find a step" })
				.fill("list_orders 247");
			await chart
				.getByRole("button", { name: /Storefront.list orders 247/ })
				.click();
			await drawer.getByText("Request accepted", { exact: true }).waitFor();
			await drawer.getByText(/This record is not the final reply/).waitFor();
			assert.equal(
				await drawer.getByText("Pending", { exact: true }).count(),
				0,
				"transport flags stay in technical details",
			);
			await page.keyboard.press("Escape");
			const hiddenOutputCall = chart.locator(
				`[data-timeline-event="${timeline.events[2]!.id}"]`,
			);
			await hiddenOutputCall.focus();
			await page.keyboard.press("Enter");
			await drawer
				.getByText("Sensitive output is hidden.", { exact: true })
				.waitFor();
			assert.equal(
				await drawer.getByText("must stay hidden", { exact: true }).count(),
				0,
			);
			assert.equal(artifactReads, 5, "only selected receipts are read");
			await page.keyboard.press("Escape");
			await chart
				.locator(`[data-timeline-event="${timeline.events[4]!.id}"]`)
				.focus();
			await page.keyboard.press("Enter");
			await drawer
				.getByText("Sensitive output is hidden.", { exact: true })
				.waitFor();
			assert.equal(
				await drawer
					.getByText(/hidden query|hidden response|hidden error/)
					.count(),
				0,
			);
			await page.keyboard.press("Escape");
			await chart
				.locator(`[data-timeline-event="${timeline.events[5]!.id}"]`)
				.focus();
			await page.keyboard.press("Enter");
			await drawer
				.getByText(
					"The saved output cannot be matched to this attempt and execution.",
				)
				.waitFor();
			assert.equal(await drawer.getByText("another execution").count(), 0);
			await page.keyboard.press("Escape");
			await chart
				.locator(`[data-timeline-event="${timeline.events[6]!.id}"]`)
				.focus();
			await page.keyboard.press("Enter");
			await drawer
				.getByText("Sensitive output is hidden.", { exact: true })
				.waitFor();
			assert.equal(
				await drawer
					.getByText(/concealed instruction|concealed response/)
					.count(),
				0,
			);
			await page.keyboard.press("Escape");
			await chart.getByRole("textbox", { name: "Find a step" }).fill("s");
			const matches = chart.locator('[aria-label="Matching steps"]');
			for (const button of [
				matches.getByRole("button").first(),
				matches.getByRole("button").last(),
			]) {
				await button.focus();
				await button.scrollIntoViewIfNeeded();
				assert(
					await button.evaluate((element) => {
						const box = element.getBoundingClientRect();
						const container = element.parentElement!.getBoundingClientRect();
						return (
							box.left >= container.left + 4 &&
							box.right <= container.right - 4 &&
							box.top >= container.top + 3 &&
							box.bottom <= container.bottom - 3
						);
					}),
					`${label}: search option border and focus ring fit inside scroll area`,
				);
			}
			if (evidenceDir)
				await page.screenshot({ path: `${evidenceDir}/search-${label}.png` });
			await chart.getByRole("textbox", { name: "Find a step" }).fill("");
			await chart
				.locator(`[data-timeline-event="${timeline.events[1]!.id}"]`)
				.focus();
			await page.keyboard.press("Enter");
			await drawer
				.getByText("Find buying questions", { exact: true })
				.waitFor();
			await drawer.getByText("Screen results", { exact: true }).waitFor();
			await drawer.getByRole("button", { name: "Item 1", exact: true }).click();
			await drawer.getByText("Setup", { exact: true }).waitFor();
			await drawer.getByText("35", { exact: true }).waitFor();
			await drawer
				.getByRole("button", { name: "Recorded inputs and instructions" })
				.click();
			await drawer.getByText(/example buying question/).waitFor();
			await drawer
				.getByRole("button", { name: "Show more saved input" })
				.click();
			await drawer.getByText(/END-OF-INSTRUCTION/).waitFor();
			await drawer
				.getByRole("button", { name: "Show more saved input" })
				.click();
			await drawer
				.locator('time[datetime="2026-10-28T09:00:00.000Z"]')
				.waitFor();
			await drawer.getByText("1793178000000", { exact: true }).waitFor();
			await drawer
				.getByRole("button", { name: "A useful product question", exact: true })
				.click();
			assert.equal(
				await drawer
					.getByRole("link", { name: /https:\/\/example.com/ })
					.getAttribute("href"),
				"https://example.com/a/very/long/thread?source=search",
			);
			await drawer.getByText("Saved search excerpt", { exact: true }).waitFor();
			await page.emulateMedia({ reducedMotion: "reduce" });
			await drawer
				.getByRole("button", { name: "Technical details", exact: true })
				.click();
			const technicalTrigger = drawer.getByRole("button", {
				name: "Technical details",
				exact: true,
			});
			assert.equal(
				await technicalTrigger.getAttribute("data-kumo-part"),
				"default-trigger",
			);
			assert.equal(await technicalTrigger.locator("svg").count(), 1);
			assert(
				await technicalTrigger
					.locator("svg")
					.evaluate(
						(element) =>
							parseFloat(getComputedStyle(element).transitionDuration) <=
							0.00001,
					),
				"disclosure caret respects reduced motion",
			);
			assert(
				await technicalTrigger.evaluate((element) => {
					const id = element.getAttribute("aria-controls");
					return Boolean(id && document.getElementById(id));
				}),
				"disclosure controls the actual mounted panel",
			);
			await technicalTrigger.press("Enter");
			assert.equal(
				await technicalTrigger.getAttribute("aria-expanded"),
				"false",
			);
			await technicalTrigger.press("Enter");
			assert.equal(
				await technicalTrigger.getAttribute("aria-expanded"),
				"true",
			);
			await drawer.locator("pre").waitFor();
			await drawer.evaluate(async (element) => {
				await Promise.all(
					element
						.getAnimations({ subtree: true })
						.filter((animation) =>
							Number.isFinite(animation.effect?.getComputedTiming().endTime),
						)
						.map((animation) => animation.finished.catch(() => {})),
				);
			});
			assert(
				await drawer.evaluate(
					(element) => element.scrollWidth <= element.clientWidth,
				),
				`${label}: expanded sheet has no horizontal overflow`,
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/formatted-details-${label}.png`,
				});
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
