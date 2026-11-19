import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence = new URL(
	"../node_modules/.cache/skill-reactivation/",
	import.meta.url,
).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/skill-reactivation.html",
);
const browser = await chromium.launch({ headless: true });
try {
	for (const [width, theme] of [
		[375, "dark"],
		[1280, "light"],
	] as const) {
		const page = await browser.newPage({
			viewport: { width, height: 900 },
			colorScheme: theme,
		});
		let role = "owner";
		let fail: false | "permission" | "untested" = false;
		const runs: Array<Record<string, unknown>> = [];
		let lifecycleState = "draft";
		const writes: unknown[] = [];
		await page.route("**/api/rpc/**", async (route) => {
			const endpoint = new URL(route.request().url()).pathname.split(
				"/api/rpc/",
			)[1];
			let result: unknown = {};
			if (endpoint === "userSettings/getContext")
				result = {
					authority: { role, permissions: ["tedis:read", "tedis:update"] },
					organization: { id: "fictional-org", appearance: null },
				};
			if (endpoint === "skills/get")
				result = {
					entry: {
						id: "fictional-skill",
						organizationId: "fictional-org",
						tediId: "fictional-tedi",
						title: "Daily operating loop",
						summary: "Review the team's work each morning.",
						revision: 7,
						lifecycleState,
						content: "# Daily loop",
						files: { "scripts/workflow.ts": "export default {}" },
					},
				};
			const failedRun = (id: string, status: string) => ({
				id,
				organizationId: "fictional-org",
				skillId: "fictional-skill",
				tediId: "fictional-tedi",
				workflowInstanceId: id,
				runtimeEnvironment: "production",
				lastReconciledAt: null,
				executionEpoch: 0,
				status,
				skillRevision: 7,
				startedAt: "2026-11-07T06:00:00.000Z",
				completedAt: "2026-11-07T06:00:14.000Z",
				hasResult: false,
				hasError: status === "failed",
			});
			if (endpoint === "skills/runWorkflowHistory")
				result = {
					runs: [
						failedRun("run-9", "failed"),
						failedRun("run-8", "failed"),
						failedRun("run-7", "failed"),
						failedRun("run-6", "completed"),
					],
				};
			if (endpoint === "skills/runWorkflowStatus")
				result = {
					...failedRun("run-9", "failed"),
					error: "Error: Mailbox token expired\n    at step (workflow.ts:4)",
				};
			if (endpoint === "skills/listWorkflowSchedules")
				result = {
					schedules: [
						{
							id: "fictional-schedule",
							organizationId: "fictional-org",
							skillId: "fictional-skill",
							tediId: "fictional-tedi",
							cron: "0 6 * * *",
							params: {},
							enabled: false,
							nextFireAt: "2026-11-08T06:00:00.000Z",
						},
					],
					total: 1,
					offset: 0,
					limit: 100,
					nextOffset: null,
				};
			if (endpoint === "tedis/list")
				result = { data: [{ id: "fictional-tedi", name: "Night lead" }] };
			if (endpoint === "skills/runWorkflow") {
				runs.push(route.request().postDataJSON().json);
				return route.fulfill({
					status: 400,
					contentType: "application/json",
					body: JSON.stringify({
						json: {
							defined: false,
							code: "BAD_REQUEST",
							message: "Internal certification eval failure",
						},
					}),
				});
			}
			if (endpoint === "skills/improve") {
				writes.push(route.request().postDataJSON().json);
				if (fail)
					return route.fulfill({
						status: fail === "untested" ? 400 : 403,
						contentType: "application/json",
						body: JSON.stringify({
							json: {
								defined: false,
								code: fail === "untested" ? "BAD_REQUEST" : "FORBIDDEN",
								message:
									fail === "untested"
										? "Promotion into differentiation requires a recorded passing certification eval for this skill revision"
										: "Only an owner or admin can turn this skill back on",
								data:
									fail === "untested"
										? { rule: "pace_layer_requires_eval" }
										: undefined,
							},
						}),
					});
				lifecycleState = "active";
			}
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({ json: result }),
			});
		});
		const url = `${server.origin}/browser-tests/skill-reactivation.html?theme=${theme}`;
		await page.goto(url);
		const button = page.getByRole("button", {
			name: "Turn back on",
			exact: true,
		});
		await button.waitFor();
		await page.evaluate(() => document.fonts.ready);
		// A draft says why it is a draft, when, and what to do, test first.
		const notice = page.getByLabel("Why this skill is a draft");
		await notice.getByText("Last error: Mailbox token expired").waitFor();
		const reason = await notice.innerText();
		assert.match(reason, /Draft after 3 failed runs in a row/);
		assert.match(reason, /Its last 3 runs failed, most recently on Nov 7/);
		assert.doesNotMatch(reason, /workflow\.ts/);
		assert.match(reason, /Its schedule is paused, so no scheduled runs start/);
		assert.match(
			reason,
			/What to do next[\s\S]*Open the failed run[\s\S]*Run a test[\s\S]*Turn it back on[\s\S]*Open the Settings tab/,
		);
		assert(
			await notice
				.getByRole("link", { name: "Open the failed run", exact: true })
				.isVisible(),
		);
		const testButton = page.getByRole("button", {
			name: "Test run",
			exact: true,
		});
		assert(
			await testButton.evaluate(
				(test, turnOn) =>
					Boolean(
						turnOn &&
						test.compareDocumentPosition(turnOn) &
							Node.DOCUMENT_POSITION_FOLLOWING,
					),
				await button.elementHandle(),
			),
			"the test button comes before Turn back on",
		);
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
			false,
		);
		await page.screenshot({
			path: `${evidence}/${width}-${theme}.png`,
			fullPage: true,
		});
		await button.click();
		await page.getByText("Active", { exact: true }).waitFor();
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0], {
			id: "fictional-skill",
			lifecycleState: "active",
			force: true,
			revisionReasoning:
				"Owner or admin turned the skill back on from its Tedix OS page.",
		});
		assert(await page.getByText("Active", { exact: true }).isVisible());
		lifecycleState = "draft";
		fail = "permission";
		await page.reload();
		await button.click();
		await page.getByRole("alert").waitFor();
		assert(await button.isEnabled(), "a refused request can be retried");
		assert.match(
			await page.getByRole("alert").innerText(),
			/Couldn't turn this skill back on: Only an owner or admin can turn this skill back on/,
			"a refusal names its real reason",
		);
		fail = "untested";
		await page.reload();
		await button.click();
		const recovery = page.getByRole("button", {
			name: "Run a test first",
			exact: true,
		});
		await recovery.waitFor();
		assert.match(
			await page.getByRole("alert").innerText(),
			/This version hasn't passed a test run yet/,
		);
		assert.doesNotMatch(
			await page.locator("body").innerText(),
			/promotion|differentiation|certification|eval/i,
		);
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
			false,
		);
		await page.screenshot({
			path: `${evidence}/${width}-${theme}-untested.png`,
			fullPage: true,
		});
		await recovery.click();
		const dialog = page.getByRole("dialog");
		await dialog
			.getByRole("heading", { name: "Test run of Daily operating loop" })
			.waitFor();
		assert.match(
			await dialog.innerText(),
			/Runs revision 7 once as a test/,
			"the test dialog says it is a test",
		);
		await dialog.getByRole("combobox", { name: "Run as" }).click();
		await page.getByRole("option", { name: "Night lead" }).click();
		await dialog.getByRole("button", { name: "Run test", exact: true }).click();
		await dialog
			.getByText(
				"Couldn't start the test; check the selected tedi and try again.",
			)
			.waitFor();
		assert.equal(runs.length, 1);
		assert.equal(runs[0].skillId, "fictional-skill");
		assert.equal(runs[0].tediId, "fictional-tedi");
		assert.equal(runs[0].certification, true);
		assert.equal(runs[0].expectedSkillRevision, 7);
		assert.doesNotMatch(
			await page.locator("body").innerText(),
			/promotion|differentiation|certification|eval/i,
		);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		fail = false;
		await button.click();
		await page.getByText("Active", { exact: true }).waitFor();
		assert.equal(await recovery.count(), 0);
		assert.equal(await notice.count(), 0, "an active skill needs no reason");
		assert.equal(await testButton.count(), 0);
		lifecycleState = "draft";
		role = "member";
		await page.reload();
		await page.getByRole("heading", { name: "Daily operating loop" }).waitFor();
		assert.equal(await button.count(), 0, "members have no activation control");
		await page.close();
		console.log(
			`${width}/${theme}: one-click activation, refreshed state, plain refusal, untested recovery, pinned test request and member visibility passed`,
		);
	}
} finally {
	await browser.close();
	await server.stop();
}
