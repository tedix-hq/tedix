import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/dispatcher-health/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.goto(`${server.origin}/work/capacity`);
		const section = page.getByRole("region", { name: "Local lanes" });
		await section.getByText("Slots in use", { exact: true }).waitFor();
		assert.equal(
			await section
				.getByText("Historical machines (1)", { exact: true })
				.count(),
			0,
		);
		assert.equal(await section.getByRole("table").count(), 1);
		assert.equal(await section.locator("tbody > tr").count(), 3);
		await section.getByText("Unknown · stale", { exact: true }).waitFor();
		for (const machine of await section.getByRole("region").all()) {
			assert.equal(await machine.getByRole("table").count(), 1);
			assert.deepEqual(
				await machine.getByRole("columnheader").allTextContents(),
				["Duty", "State", "Last observed", "Problem"],
			);
		}
		for (const summary of await section
			.locator("[data-lane-state] summary")
			.all())
			await summary.click();
		for (const state of ["Slots in use", "Idle", "Unknown · stale"])
			assert.equal(
				await section.locator(`[data-lane-state="${state}"]`).count(),
				1,
			);
		const skip = section.getByText(
			"Most reported problem (30 min): Approval required · 2 observations",
			{
				exact: true,
			},
		);
		await skip.waitFor();
		assert.match(await section.innerText(), /Waiting for approval/);
		assert.match(
			await section.innerText(),
			/Last task picked up: Not observed/,
		);
		for (const summary of await section.locator("summary").all()) {
			const bounds = await summary.boundingBox();
			assert.ok(
				bounds && bounds.height >= 44,
				"Lane disclosures need a 44px touch target",
			);
		}

		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await section.screenshot({
			path: `${evidence}/table-preview-lanes-${width}.png`,
		});
		await page.close();
	}
	const reasons = [
		[
			"Possible human-reserved action; no accountable user owner can authorize a delegation comment. Set an accountable user owner, then have that owner add the version-specific Delegation comment.",
			"Owner authorization required",
		],
		[
			"Work Item completion requires its owner or steward",
			"Owner permission required",
		],
		[
			"Error: Admission not ready: Missing approval risk:high",
			"Approval required",
		],
		[
			"The organization's tool policy could not be verified; no action was executed.",
			"Access could not be verified",
		],
		[
			"This Work revision has a retained receipt or retry deadline: retry later",
			"Earlier run or retry recorded",
		],
		["Unclassified producer diagnostic", "See the reported details"],
	] as const;
	const reasonPage = await browser.newPage();
	await reasonPage.route("**/dispatcherHealth/list**", (route) => {
		const at = new Date().toISOString();
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					reportedAt: at,
					data: reasons.map(([reason], index) => ({
						reporterId: `fixture-${index}`,
						executor: "codex",
						lane: `lane-${index}`,
						running: true,
						observedAt: at,
						reportedAt: at,
						lastAdmissionAt: null,
						slotsInUse: 0,
						slotsTotal: 1,
						topReason: { reason, count: 15 },
						ageSeconds: 0,
						staleAfterSeconds: 90,
						stale: false,
					})),
				},
			}),
		});
	});
	await reasonPage.goto(`${server.origin}/work/capacity`);
	for (const [raw, friendly] of reasons) {
		const summary = reasonPage.getByText(
			`Most reported problem (30 min): ${friendly} · 15 observations`,
			{ exact: true },
		);
		const detail = reasonPage.locator("details").filter({ has: summary });
		assert.equal(await detail.getAttribute("open"), null);
		await detail.locator("summary").click();
		await summary.waitFor();
		assert.ok((await detail.innerText()).includes(raw));
	}
	await reasonPage.close();
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		let includeDuty = false;
		await page.route("**/dispatcherHealth/list**", (route) => {
			const at = new Date().toISOString();
			const duty = {
				id: "fixture",
				kind: "task",
				state: "waiting",
				observedAt: at,
				lastRunAt: at,
				lastExitAt: at,
				lastExitCode: 0,
				lastExecutor: "codex",
				restartsLastHour: 0,
				retryAt: at,
				lastProblem: null,
			};
			return route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					json: {
						reportedAt: at,
						data: [
							{
								reporterId: "fixture-mac",
								executor: "codex",
								lane: "supervisor-lead",
								running: true,
								observedAt: at,
								reportedAt: at,
								lastAdmissionAt: null,
								slotsInUse: 0,
								slotsTotal: 1,
								topReason: { reason: "codex pass finished", count: 1 },
								duty: includeDuty ? duty : undefined,
								ageSeconds: 0,
								staleAfterSeconds: 90,
								stale: false,
							},
							{
								reporterId: "fixture-mac",
								executor: "opencode",
								duty: includeDuty
									? {
											...duty,
											id: "opencode",
											kind: "service",
											lastExecutor: "opencode",
											restartsLastHour: 3,
											lastExitCode: 7,
											lastProblem: "Runner exited with code 7",
										}
									: undefined,
								lane: "opencode",
								running: true,
								observedAt: at,
								reportedAt: at,
								lastAdmissionAt: null,
								slotsInUse: 0,
								slotsTotal: 1,
								topReason: null,
								ageSeconds: 0,
								staleAfterSeconds: 90,
								stale: false,
							},
						],
					},
				}),
			});
		});
		await page.goto(`${server.origin}/work/capacity`);
		const machine = page.getByRole("region", {
			name: "Machine fixture-mac",
			exact: true,
		});
		await machine.getByText("Last pass reported", { exact: true }).waitFor();
		assert.equal(await machine.count(), 1);
		assert.equal(await machine.getByRole("table").count(), 1);
		assert.equal(await machine.locator("tbody > tr").count(), 2);
		for (const summary of await machine.locator("summary").all())
			await summary.click();
		const lead = machine.locator('[data-lane-state="Last pass reported"]');
		assert.match(await lead.innerText(), /Lead · codex/);
		assert.match(await lead.innerText(), /Current pass: Not reported/);
		assert.match(
			await lead.innerText(),
			/Last pass result: codex pass finished/,
		);
		assert.doesNotMatch(
			await lead.innerText(),
			/slots in use|Idle|observations/,
		);
		assert.equal(await machine.getByText("Idle", { exact: true }).count(), 1);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await machine.screenshot({
			path: `${evidence}/table-preview-machine-${width}.png`,
		});
		includeDuty = true;
		await page.reload();
		await machine
			.getByText("Waiting for next check", { exact: true })
			.waitFor();
		await machine.getByText("Restart scheduled", { exact: true }).waitFor();
		const runner = machine.locator('[data-lane-state="Restart scheduled"]');
		assert.equal(
			await runner
				.getByRole("cell")
				.nth(3)
				.getByText("Runner exited with code 7", { exact: true })
				.isVisible(),
			true,
		);
		const leadProblem = machine
			.locator('[data-lane-state="Waiting for next check"]')
			.getByRole("cell")
			.nth(3);
		assert.equal(
			await leadProblem.getByText("Not reported", { exact: true }).isVisible(),
			true,
		);
		assert.equal(
			await leadProblem
				.getByText("Last pass result: codex pass finished", { exact: true })
				.isVisible(),
			false,
		);
		await machine.screenshot({
			path: `${evidence}/table-preview-compact-${width}.png`,
		});
		for (const summary of await machine.locator("summary").all())
			await summary.click();
		assert.match(
			await machine.innerText(),
			/Recorded restarts \(last hour\): 3/,
		);
		assert.match(
			await machine.innerText(),
			/Last problem: Runner exited with code 7/,
		);
		assert.match(await machine.innerText(), /code 0/);
		assert.doesNotMatch(
			await machine.innerText(),
			/Restart history: Not reported|Current pass: Not reported/,
		);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await machine.screenshot({
			path: `${evidence}/table-preview-duties-${width}.png`,
		});
		await page.close();
	}
	const stalePage = await browser.newPage();
	let fresh = false;
	let observationTime = "";
	await stalePage.route("**/dispatcherHealth/list**", (route) => {
		const at = new Date().toISOString();
		observationTime = new Date(
			Date.now() - (fresh ? 0 : 600_000),
		).toISOString();
		return route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					reportedAt: at,
					data: [
						{
							reporterId: "fixture-restored",
							executor: "codex",
							lane: "codex",
							running: true,
							observedAt: observationTime,
							reportedAt: at,
							lastAdmissionAt: null,
							slotsInUse: 0,
							slotsTotal: 1,
							topReason: null,
							ageSeconds: fresh ? 0 : 600,
							staleAfterSeconds: 90,
							stale: false,
						},
					],
				},
			}),
		});
	});
	await stalePage.goto(`${server.origin}/work/capacity`);
	const unknown = stalePage.getByText(
		"No recent lane reports. Current lane status is unknown.",
		{ exact: true },
	);
	await unknown.waitFor();
	assert.equal(
		await stalePage.getByText("Unknown · stale", { exact: true }).isVisible(),
		false,
	);
	await stalePage.getByText("Historical machines (1)", { exact: true }).click();
	await stalePage.getByText("Unknown · stale", { exact: true }).waitFor();
	assert.equal(
		await stalePage.locator("[data-lane-state] time").getAttribute("datetime"),
		observationTime,
	);
	fresh = true;
	await stalePage.reload();
	await stalePage.getByText("Idle", { exact: true }).waitFor();
	assert.equal(await unknown.count(), 0);
	assert.equal(
		await stalePage.getByText("Historical report", { exact: true }).count(),
		0,
	);
	assert.equal(
		await stalePage.locator("[data-lane-state] time").getAttribute("datetime"),
		observationTime,
	);
	await stalePage.close();
	for (const mode of ["empty", "error"] as const) {
		const page = await browser.newPage();
		await page.route("**/dispatcherHealth/list**", (route) =>
			route.fulfill({
				status: mode === "error" ? 503 : 200,
				contentType: "application/json",
				body: JSON.stringify({
					json:
						mode === "error"
							? { message: "Unavailable" }
							: { reportedAt: new Date().toISOString(), data: [] },
				}),
			}),
		);
		await page.goto(`${server.origin}/work/capacity`);
		await page
			.getByText(
				mode === "empty"
					? "No lane observations"
					: "Lane observations unavailable",
				{ exact: true },
			)
			.waitFor();
		assert.equal(await page.locator("[data-lane-state]").count(), 0);
		await page.close();
	}
	console.log(
		"PASS: local lane states, stale reports, empty/error states, phone and desktop",
	);
} finally {
	await browser.close();
	await server.stop();
}
