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
		const historical = section.locator("details").filter({
			has: page.locator("summary", {
				hasText: "Historical lane observations (1)",
			}),
		});
		assert.equal(await historical.getAttribute("open"), null);
		assert.equal(
			await section.getByText("Unknown · stale", { exact: true }).isVisible(),
			false,
		);
		await historical.locator("summary").first().click();
		await section.getByText("Unknown · stale", { exact: true }).waitFor();
		for (const state of ["Slots in use", "Idle", "Unknown · stale"])
			assert.equal(
				await section.locator(`[data-lane-state="${state}"]`).count(),
				1,
			);
		const skip = section.getByText(
			"Last reported skip reason: Approval required · 2 observations",
			{
				exact: true,
			},
		);
		await skip.click();
		assert.match(await section.innerText(), /Waiting for approval/);
		assert.match(await section.innerText(), /Last admission: Not observed/);
		assert.ok(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
		await section.screenshot({ path: `${evidence}/lanes-${width}.png` });
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
			`Last reported skip reason: ${friendly} · 15 observations`,
			{ exact: true },
		);
		await summary.waitFor();
		const detail = summary.locator("..");
		assert.equal(await detail.getAttribute("open"), null);
		await summary.click();
		assert.ok((await detail.innerText()).includes(raw));
	}
	await reasonPage.close();
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
	await stalePage
		.getByText("Historical lane observations (1)", { exact: true })
		.click();
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
		await stalePage
			.getByText("Historical lane observations (1)", { exact: true })
			.count(),
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
