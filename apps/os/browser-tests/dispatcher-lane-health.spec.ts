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
				["Duty", "State", "Work", "Last observed", "Next step"],
			);
		}
		const history = section
			.getByRole("button", { name: "History and details", exact: true })
			.first();
		await history.focus();
		await page.keyboard.press("Enter");
		assert.equal(await history.getAttribute("aria-expanded"), "true");
		await page.keyboard.press("Space");
		assert.equal(await history.getAttribute("aria-expanded"), "false");
		assert.equal(
			await history.evaluate((button) => button === document.activeElement),
			true,
		);
		for (const summary of await section
			.getByRole("button", { name: "History and details", exact: true })
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
		for (const summary of await section
			.getByRole("button", { name: "History and details", exact: true })
			.all()) {
			const bounds = await summary.boundingBox();
			assert.ok(
				bounds && bounds.height >= (width < 640 ? 44 : 32),
				"Lane disclosures use the shared desktop and phone touch targets",
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
						executor: "custom-review",
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
		const detail = reasonPage
			.locator("[data-lane-details]")
			.filter({ has: summary });
		assert.equal(
			await detail.getByRole("button").getAttribute("aria-expanded"),
			"false",
		);
		await detail
			.getByRole("button", { name: "History and details", exact: true })
			.click();
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
				lastExecutor: "custom-review",
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
								executor: "custom-review",
								lane: "supervisor-lead",
								running: true,
								observedAt: at,
								reportedAt: at,
								lastAdmissionAt: null,
								slotsInUse: 0,
								slotsTotal: 1,
								topReason: { reason: "custom-review pass finished", count: 1 },
								duty: includeDuty ? duty : undefined,
								ageSeconds: 0,
								staleAfterSeconds: 90,
								stale: false,
							},
							{
								reporterId: "fixture-mac",
								executor: "custom-build",
								duty: includeDuty
									? {
											...duty,
											id: "custom-build",
											kind: "service",
											lastExecutor: "custom-build",
											restartsLastHour: 3,
											lastExitCode: 7,
											lastProblem: "Runner exited with code 7",
										}
									: undefined,
								lane: "custom-build",
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
		for (const summary of await machine
			.getByRole("button", { name: "History and details", exact: true })
			.all())
			await summary.click();
		const lead = machine.locator('[data-lane-state="Last pass reported"]');
		assert.match(await lead.innerText(), /Scheduled check · custom-review/);
		assert.match(await lead.innerText(), /Current pass: Not reported/);
		assert.match(
			await lead.innerText(),
			/Last pass result: custom-review pass finished/,
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
				.nth(4)
				.getByText("Runner exited with code 7", { exact: true })
				.isVisible(),
			true,
		);
		const leadProblem = machine
			.locator('[data-lane-state="Waiting for next check"]')
			.getByRole("cell")
			.nth(4);
		assert.match(await leadProblem.innerText(), /Check due|Next check/);
		assert.equal(
			await leadProblem
				.getByText("Last pass result: custom-review pass finished", {
					exact: true,
				})
				.isVisible(),
			false,
		);
		await machine.screenshot({
			path: `${evidence}/table-preview-compact-${width}.png`,
		});
		for (const summary of await machine
			.getByRole("button", { name: "History and details", exact: true })
			.all())
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
							executor: "custom-review",
							lane: "custom-review",
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
	for (const { width, theme } of [375, 1048, 1280].flatMap((width) =>
		(["light", "dark"] as const).map((theme) => ({ width, theme })),
	)) {
		for (const executors of [
			["tenant.builder", "review-pool", "night-check"],
			["custom-service"],
		]) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(value) => localStorage.setItem("tedix-os-theme", value),
				theme,
			);
			let stale = false;
			const current = "11111111-1111-4111-8111-111111111111";
			const second = "22222222-2222-4222-8222-222222222222";
			const completed = "33333333-3333-4333-8333-333333333333";
			const workTitle =
				"Build the guide with a detailed tenant-configured task title that stays readable without making every lane row expand";
			const waitingTitle =
				"Review the waiting Work with a detailed configured executor title that must end in an ellipsis inside the Next step column";
			await page.route("**/dispatcherHealth/list**", (route) => {
				const at = new Date().toISOString();
				const silentSince = new Date(Date.now() - 5 * 60_000).toISOString();
				const future = new Date(Date.now() + 60_000).toISOString();
				return route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						json: {
							reportedAt: at,
							data: executors.map((executor, index) => ({
								reporterId: `configured-${executors.length}`,
								executor,
								lane: `service-${index}`,
								running: index < 2,
								observedAt: at,
								reportedAt: at,
								lastAdmissionAt: at,
								slotsInUse: index ? 0 : 2,
								slotsTotal: 8,
								topReason: null,
								stale,
								ageSeconds: stale ? 600 : 0,
								staleAfterSeconds: 300,
								duty: {
									id: `configured-${index}`,
									kind: "service",
									state: "running",
									observedAt: at,
									lastRunAt: at,
									lastExitAt: null,
									lastExitCode: null,
									lastExecutor: executor,
									restartsLastHour: 0,
									retryAt: null,
									lastProblem: null,
									activity: {
										current: index
											? []
											: [
													{
														id: current,
														title: workTitle,
														phase: "working",
														nativeActivity: {
															state: "provider_waiting",
															observedAt: silentSince,
														},
													},
													{
														id: second,
														title: "Review changes",
														phase: "working",
													},
												],
										currentCount: index ? 0 : 5,
										waiting: index
											? []
											: [
													{
														id: second,
														title: waitingTitle,
														reason: "retry",
														retryAt: future,
													},
												],
										nextCheckAt: future,
										lastCompleted: {
											id: completed,
											title: "Publish the guide",
											completedAt: at,
										},
									},
								},
							})),
						},
					}),
				});
			});
			await page.goto(`${server.origin}/work/capacity`);
			const section = page.getByRole("region", { name: "Local lanes" });
			await section.getByText("Working", { exact: true }).waitFor();
			assert.equal(
				await section.locator("tbody > tr").count(),
				executors.length,
			);
			const row = section.locator("tbody > tr").first();
			assert.match(await row.innerText(), /3 more tasks reported/);
			assert.match(await row.innerText(), /Retry scheduled/);
			assert.match(await row.innerText(), /Last completed/);
			assert.match(
				await row.innerText(),
				/No provider progress.*dispatcher heartbeat is separate/,
			);
			assert.equal(
				await row
					.getByRole("link", { name: workTitle, exact: true })
					.getAttribute("href"),
				`/work/items/${current}`,
			);
			assert.equal(
				await row
					.getByRole("link", { name: "Publish the guide", exact: true })
					.getAttribute("href"),
				`/work/items/${completed}`,
			);
			assert.equal(await page.locator("html").getAttribute("data-mode"), theme);
			for (const [title, id, column] of [
				[workTitle, current, 2],
				[waitingTitle, second, 4],
			] as const) {
				const cell = row.getByRole("cell").nth(column);
				const task = cell.getByRole("link", { name: title, exact: true });
				assert.equal(await task.getAttribute("title"), title);
				assert.equal(await task.getAttribute("href"), `/work/items/${id}`);
				const text = await task
					.locator('[data-slot="text"]')
					.evaluate((text) => ({
						width: text.clientWidth,
						scroll: text.scrollWidth,
						height: text.getBoundingClientRect().height,
						lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
						overflow: getComputedStyle(text).textOverflow,
					}));
				assert.ok(
					text.width > 0 && text.scroll > text.width,
					`${width}/${theme}: ${title} truncates within its column`,
				);
				assert.equal(text.overflow, "ellipsis");
				assert.ok(
					text.height <= text.lineHeight + 1,
					"A long title stays on one line",
				);
				await task.focus();
				await page.keyboard.press("Tab");
				await page.keyboard.press("Shift+Tab");
				const bounds = await task.evaluate((link) => {
					const rect = link.getBoundingClientRect();
					const cell = link.closest("td")!.getBoundingClientRect();
					return {
						focused: document.activeElement === link,
						visible: link.matches(":focus-visible"),
						left: rect.left,
						right: rect.right,
						cellLeft: cell.left,
						cellRight: cell.right,
						shadow: getComputedStyle(link).boxShadow,
					};
				});
				assert.ok(
					bounds.focused && bounds.visible,
					"Work links retain keyboard focus",
				);
				assert.notEqual(bounds.shadow, "none");
				assert.ok(
					bounds.left - 2 >= bounds.cellLeft &&
						bounds.right + 2 <= bounds.cellRight,
					`${width}/${theme}: Work link and focus ring stay inside their cell`,
				);
				assert.ok(
					bounds.left - 2 >= 0 && bounds.right + 2 <= width,
					"Work link and focus ring stay inside the viewport",
				);
			}
			if (executors.length > 1)
				assert.equal(
					await section.getByText("Ready", { exact: true }).count(),
					Math.min(1, executors.length - 1),
				);
			if (executors.length > 2)
				assert.equal(
					await section.getByText("Stopped", { exact: true }).count(),
					1,
				);
			assert.ok(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			);
			await section.screenshot({
				path: `${evidence}/activity-${executors.length}-${width}-${theme}.png`,
			});
			stale = true;
			await page.reload();
			await section
				.getByText("Historical machines (1)", { exact: true })
				.click();
			await section
				.getByText("Unknown · stale", { exact: true })
				.first()
				.waitFor();
			assert.equal(
				await section
					.getByRole("link", { name: workTitle, exact: true })
					.count(),
				0,
			);
			assert.equal(
				await section
					.getByRole("link", { name: "Publish the guide", exact: true })
					.count(),
				0,
			);
			await page.close();
		}
	}
	console.log(
		"PASS: local lane states, stale reports, empty/error states, phone and desktop",
	);
} finally {
	await browser.close();
	await server.stop();
}
