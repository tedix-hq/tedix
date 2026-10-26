import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { OsGadgetExecution } from "@tedix/api-contract/schemas/os-workspaces";
import { startFixtureServer } from "./fixture-server";

const workspaceId = "00000030-0000-4000-8000-000000000001";
const gadgetId = "00000031-0000-4000-8000-00000000000e";
const callId = "11111111-1111-4111-8111-111111111111";
const receipt: OsGadgetExecution = {
	id: callId,
	organizationId: "fictional-org",
	workspaceId,
	gadgetId,
	revisionId: "22222222-2222-4222-8222-222222222222",
	revision: 1,
	status: "completed",
	grantedCapabilities: ["app.call"],
	policyDecision: { allowed: true, reasons: ["app.call"] },
	input: { method: "count", args: [] },
	output: { count: 1 },
	error: null,
	costs: null,
	evidenceRefs: [],
	createdByKind: "user",
	createdById: "fictional-member",
	createdAt: "2026-10-26T12:00:00.000Z",
	completedAt: "2026-10-26T12:00:01.000Z",
	lineage: {
		runId: null,
		workflowInstanceId: null,
		tediId: null,
		workItemId: null,
		traceBundleId: null,
		billingReservationId: null,
		approvalRequestId: null,
		runtimeEnvironment: "test",
		agentSessionId: null,
		executionEpoch: 0,
	},
};
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-app-call-logs");
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({
			viewport: { width, height: 900 },
			reducedMotion: "reduce",
		});
		page.setDefaultNavigationTimeout(120_000);
		page.setDefaultTimeout(120_000);
		let polls = 0;
		await page.route(
			"**/api/rpc/osWorkspaces/executions/list**",
			async (route) => {
				const url = new URL(route.request().url());
				const input =
					route.request().method() === "GET"
						? JSON.parse(url.searchParams.get("data") ?? "{}").json
						: route.request().postDataJSON().json;
				const trace = {
					...receipt,
					id: "33333333-3333-4333-8333-333333333333",
					grantedCapabilities: [],
					policyDecision: { allowed: true, reasons: ["runtime_trace"] },
					output: {
						callId,
						events: [
							{
								timestamp: Date.parse(receipt.createdAt),
								logs: [
									{ level: "info", message: "Count loaded" },
									{ level: "warn", message: "No saved rating" },
									{ level: "error", message: "<script>untrusted</script>" },
								],
								exceptions: [],
							},
						],
					},
				};
				return route.fulfill({
					json: {
						json: {
							items: input?.callId
								? ++polls > 1
									? [trace]
									: []
								: [trace, receipt],
							truncated: false,
						},
					},
				});
			},
		);
		await page.goto(
			`${server.origin}/workspace/${workspaceId}?workpiece=gadget%3A${gadgetId}&pane=workpiece`,
			{ waitUntil: "domcontentloaded" },
		);
		await page
			.getByRole("group", { name: "Active workpiece view" })
			.getByRole("button", { name: "Runs", exact: true })
			.click();
		const log = page.getByRole("log", {
			name: `Console logs for call ${callId}`,
		});
		await log.getByText("Count loaded", { exact: false }).waitFor();
		await page.getByRole("button", { name: "warn", exact: true }).click();
		assert.match(await log.innerText(), /No saved rating/);
		assert.doesNotMatch(await log.innerText(), /Count loaded/);
		await page.getByRole("button", { name: "All levels", exact: true }).click();
		assert.match(await log.innerText(), /<script>untrusted<\/script>/);
		await page.getByRole("button", { name: "Pause live logs" }).click();
		assert.equal(await log.getAttribute("aria-live"), "off");
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		);
		await log.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: join(evidence, `${width}-runs-console.png`),
			fullPage: true,
		});
		await page.close();
	}
	console.log(
		"Runs console: late traces, level filters, escaping and pause passed at 375px and 1280px",
	);
} finally {
	await browser.close();
	await server.stop();
}
