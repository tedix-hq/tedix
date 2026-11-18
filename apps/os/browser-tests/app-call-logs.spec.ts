import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type {
	OsGadgetExecution,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";
import { startFixtureServer } from "./fixture-server";
import { showWorkpieceView } from "./workpiece-views";

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
const orderSheet: OsWorkspaceResource = {
	id: "44444444-4444-4444-8444-444444444444",
	organizationId: "fictional-org",
	workspaceId,
	slot: "order_sheet",
	providerId: "google-sheets",
	connectionScope: "tenant",
	personalOwnerUserId: null,
	connectionInstanceId: null,
	providerAccess: null,
	requiredScopes: [],
	resourceType: "spreadsheet",
	providerResourceId: "fictional-sheet",
	name: "Orders 2026",
	metadata: {},
	status: "active",
	createdByKind: "user",
	createdById: "fictional-member",
	createdAt: "2026-10-26T12:00:00.000Z",
	updatedAt: "2026-10-26T12:00:00.000Z",
	removedAt: null,
};
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-app-call-logs");
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const [width, colorScheme] of [
		[375, "light"],
		[375, "dark"],
		[1280, "light"],
		[1280, "dark"],
	] as const) {
		const page = await browser.newPage({
			viewport: { width, height: 900 },
			reducedMotion: "reduce",
			colorScheme,
		});
		page.setDefaultNavigationTimeout(120_000);
		page.setDefaultTimeout(120_000);
		let polls = 0;
		let neverRun = false;
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
								: neverRun
									? []
									: [trace, receipt],
							truncated: false,
						},
					},
				});
			},
		);
		// The app declares one resource, and the workspace has a sheet attached
		// for it. Rename and remove answer like the API: they check the
		// revision the page read and return the changed resource.
		let sheet = { ...orderSheet };
		const resourceWrites: Array<Record<string, unknown>> = [];
		await page.route(
			/\/api\/rpc\/osWorkspaces\/gadgets\/get(\?|$)/,
			async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.currentRevision.manifest.resourceGrants = [
					{ slot: "order_sheet", operations: ["read", "write"] },
				];
				return route.fulfill({ response, json: body });
			},
		);
		await page.route(
			/\/api\/rpc\/osWorkspaces\/resources\/list(\?|$)/,
			async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.items = [...body.json.items, sheet];
				return route.fulfill({ response, json: body });
			},
		);
		for (const action of ["rename", "remove"] as const)
			await page.route(
				`**/api/rpc/osWorkspaces/resources/${action}**`,
				async (route) => {
					const input = route.request().postDataJSON().json;
					resourceWrites.push({ action, ...input });
					assert.equal(input.resourceId, sheet.id);
					assert.equal(input.expectedUpdatedAt, sheet.updatedAt);
					sheet =
						action === "rename"
							? {
									...sheet,
									name: input.name,
									updatedAt: "2026-10-26T12:05:00.000Z",
								}
							: {
									...sheet,
									status: "removed",
									removedAt: "2026-10-26T12:10:00.000Z",
									updatedAt: "2026-10-26T12:10:00.000Z",
								};
					return route.fulfill({ json: { json: { resource: sheet } } });
				},
			);
		await page.goto(
			`${server.origin}/workspace/${workspaceId}?workpiece=gadget%3A${gadgetId}&pane=workpiece`,
			{ waitUntil: "domcontentloaded" },
		);
		await showWorkpieceView(page, "History");
		const runs = page.getByRole("list", { name: "Runs" });
		const row = runs.getByRole("button", { name: /clicked Count/ });
		await row.waitFor();
		// The list reads like a deploy log: one run, in plain words, trace rows hidden.
		assert.equal(await runs.getByRole("listitem").count(), 1);
		assert.match(await row.innerText(), /Done/);
		assert.match(await row.innerText(), /count: 1/);
		await page.getByRole("button", { name: "Run manually" }).waitFor();
		const historyText = (await runs.innerText()).toLowerCase();
		for (const jargon of ["receipt", "admission", "pinned", "app.call"])
			assert(!historyText.includes(jargon), `History shows "${jargon}"`);
		await row.click();
		const log = page.getByRole("log", { name: "Logs for this run" });
		await log.getByText("Count loaded", { exact: false }).waitFor();
		const chooseLevel = async (name: string) => {
			await page.getByRole("combobox", { name: "Log level" }).click();
			await page.getByRole("option", { name }).click();
		};
		await chooseLevel("Warnings");
		assert.match(await log.innerText(), /No saved rating/);
		assert.doesNotMatch(await log.innerText(), /Count loaded/);
		await chooseLevel("All levels");
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
			path: join(evidence, `${width}-${colorScheme}-history.png`),
			fullPage: true,
		});

		// An app nobody has run yet explains where runs come from, and the
		// manual run stays one small action away.
		neverRun = true;
		await page.reload({ waitUntil: "domcontentloaded" });
		await showWorkpieceView(page, "History");
		await page.getByText("No runs yet").waitFor();
		await page
			.getByText(
				"Runs appear here when someone uses the app, a schedule runs, or you run it manually.",
			)
			.waitFor();
		await page.getByRole("button", { name: "Run manually" }).click();
		const form = page.getByRole("form", { name: "Run manually" });
		const runAs = form.getByRole("combobox", { name: "Run as" });
		await runAs.waitFor();
		// The tedi is picked by name, never by its id.
		assert.doesNotMatch(
			await runAs.innerText(),
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
		);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		);
		await page.screenshot({
			path: join(evidence, `${width}-${colorScheme}-history-empty.png`),
			fullPage: true,
		});

		// Connections: a person renames the sheet the app uses, then takes it
		// out of the workspace after confirming.
		await showWorkpieceView(page, "Connections");
		const connection = page.locator('[data-app-connection="order_sheet"]');
		await connection.getByText("Orders 2026", { exact: true }).waitFor();
		await connection
			.getByRole("button", { name: "Rename Orders 2026" })
			.click();
		const newName = connection.getByRole("textbox", {
			name: "New name for Orders 2026",
		});
		const save = connection.getByRole("button", { name: "Save" });
		assert(await save.isDisabled(), "Save is off until the name changes");
		await newName.fill("Orders 2027");
		await save.click();
		await connection.getByText("Orders 2027", { exact: true }).waitFor();
		await connection
			.getByRole("button", { name: "Remove Orders 2027" })
			.click();
		await connection
			.getByText("The connected account stays connected.", { exact: false })
			.waitFor();
		assert.equal(resourceWrites.length, 1, "Asking to remove changes nothing");
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
		);
		await page.screenshot({
			path: join(evidence, `${width}-${colorScheme}-connections.png`),
			fullPage: true,
		});
		await connection
			.getByRole("button", { name: "Remove", exact: true })
			.click();
		await connection.getByText("Nothing attached").waitFor();
		assert.equal(
			await connection.getByRole("button", { name: /Rename|Remove/ }).count(),
			0,
		);
		assert.deepEqual(
			resourceWrites.map((write) => [write.action, write.name]),
			[
				["rename", "Orders 2027"],
				["remove", undefined],
			],
		);
		await page.close();
	}
	console.log(
		"History (run list, run details, late logs, level filters, escaping, pause) and Connections (rename, remove) passed at 375px and 1280px, light and dark",
	);
} finally {
	await browser.close();
	await server.stop();
}
