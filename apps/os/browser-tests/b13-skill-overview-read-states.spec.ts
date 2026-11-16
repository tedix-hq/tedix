import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, webkit, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const evidence =
	process.env.B13_OVERVIEW_EVIDENCE_DIR ??
	join(
		process.env.TEDIX_LANE_LOG ? dirname(process.env.TEDIX_LANE_LOG) : "/tmp",
		"b13-skill-overview-read-states",
	);
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = process.env.B13_TEST_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.B13_TEST_ORIGIN
	? undefined
	: Bun.spawn(
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
const hoursAgo = (hours: number) =>
	new Date(Date.now() - hours * 3_600_000).toISOString();
const entry = (id: string, title: string) => ({
	id,
	organizationId: "example",
	tediId: null,
	title,
	slug: `${id}-skill`,
	description: `Checks the weekly export for ${title}.`,
	summary: "Batched parallel judge with storage-error retry.",
	tags: ["verification"],
	content: `# ${title}\n\nCheck the export.`,
	files: {
		"scripts/workflow.ts":
			"export default async (env) => { await step.do('read', () => env.MCP.os.get_os_output({ id: 'x' })); await step.do('write', () => env.MCP.os.set_os_sheet_range({})); }",
	},
	successCount: id === "alpha" ? 4 : 0,
	failureCount: id === "alpha" ? 1 : 0,
	revision: 3,
	visibility: "org",
	paceLayer: "record",
	lifecycleState: "active",
});
const run = (index: number) => {
	const failed = index % 3 === 2;
	return {
		id: `run-${index}`,
		organizationId: "example",
		skillId: "alpha",
		tediId: "worker",
		workflowInstanceId: `wf-${index}`,
		runtimeEnvironment: "development",
		lastReconciledAt: null,
		executionEpoch: 0,
		status: failed ? "failed" : "completed",
		skillRevision: 3,
		trigger: "scheduled",
		startedAt: hoursAgo(index * 20 + 1),
		completedAt: new Date(
			Date.parse(hoursAgo(index * 20 + 1)) + 90_000,
		).toISOString(),
		hasResult: !failed,
		hasError: failed,
		errorPreview: failed ? "Error: The export for week 42 has no rows" : null,
		resultSummary: failed ? null : `Checked ${40 + index} rows, all valid.`,
	};
};
const runs = [0, 1, 2, 3, 4, 5, 6].map(run);
const runStatus = (id: string) => ({
	...runs.find((candidate) => candidate.id === id)!,
	params: { period: "last_7_days" },
	result: { summary: "Checked rows" },
});
type Fixture = Window & {
	overviewFixture: {
		refreshRuns(): Promise<void>;
		navigate(skillId: string): Promise<void>;
	};
};
const receipts: unknown[] = [];
let browser: Browser | undefined;
let ready = false;
try {
	for (let i = 0; i < 120; i++) {
		if (server && server.exitCode !== null)
			throw new Error(`Server exited before readiness: ${server.exitCode}`);
		try {
			ready = (
				await fetch(
					`${origin}/browser-tests/b13-skill-overview-read-states.html`,
				)
			).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Fixture server readiness timeout");
	const engine = process.env.B13_BROWSER ?? "chromium";
	browser = await (engine === "webkit" ? webkit : chromium).launch({
		headless: true,
		...(engine === "chrome" ? { channel: "chrome" } : {}),
	});
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
			let failRuns = true;
			const procedures: string[] = [];
			await page.route("**/api/**", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				const input =
					request.method() === "GET"
						? JSON.parse(url.searchParams.get("data") ?? "{}").json
						: request.postDataJSON()?.json;
				const pathname = url.pathname;
				procedures.push(pathname.slice(pathname.lastIndexOf("/") + 1));
				if (pathname.endsWith("/skills/runWorkflowHistory")) {
					if (failRuns)
						return route.fulfill({
							status: 503,
							json: {
								json: {
									defined: false,
									code: "SERVICE_UNAVAILABLE",
									message: "Runs read failed",
								},
							},
						});
					const skillId = String(input?.skillId);
					const after = input?.startedAfter
						? Date.parse(input.startedAfter)
						: 0;
					return route.fulfill({
						json: {
							json: {
								runs:
									skillId === "alpha"
										? runs
												.filter((r) => Date.parse(r.startedAt) >= after)
												.slice(0, input?.limit ?? 50)
										: [],
							},
						},
					});
				}
				if (pathname.endsWith("/skills/runWorkflowStatus"))
					return route.fulfill({
						json: { json: runStatus(String(input?.runId)) },
					});
				if (pathname.endsWith("/appGating/installedEligibility"))
					return route.fulfill({ json: { json: [] } });
				if (pathname.endsWith("/skills/get")) {
					const known: Record<string, string> = { alpha: "Alpha verifier" };
					const skillId = String(input?.id);
					return route.fulfill({
						json: {
							json: {
								entry: known[skillId] ? entry(skillId, known[skillId]) : null,
							},
						},
					});
				}
				throw new Error(`Unexpected API call ${pathname}`);
			});
			await page.goto(
				`${origin}/browser-tests/b13-skill-overview-read-states.html?theme=${theme}`,
			);
			await page.getByText("How it is doing", { exact: true }).waitFor();
			// A failed read says so; it never claims there were no runs.
			await page.getByText("Runs unavailable", { exact: true }).waitFor();
			assert.equal(await page.getByText("No runs yet").count(), 0);
			failRuns = false;
			await page.evaluate(() =>
				(window as Fixture).overviewFixture.refreshRuns(),
			);
			const retries = page.getByRole("button", { name: "Retry", exact: true });
			for (let n = await retries.count(); n > 0; n--)
				await retries.first().click();
			// Metrics strip with the default 7 day range.
			const strip = page.getByLabel("Run counts");
			await strip.getByText("Success rate").waitFor();
			await strip.getByText("Typical time").waitFor();
			await strip.getByText("Failures").waitFor();
			await page.getByLabel("Finished runs over time").waitFor();
			const sevenDays = await strip.innerText();
			await page.getByRole("button", { name: "24h", exact: true }).click();
			await strip.getByText("100%", { exact: true }).waitFor();
			assert.notEqual(await strip.innerText(), sevenDays);
			await page.getByRole("button", { name: "30d", exact: true }).click();
			await page.getByLabel("Finished runs over time").waitFor();
			assert.equal(await strip.innerText(), sevenDays);
			// Recent runs: result line, inline error reason, link to all runs.
			const recent = page.getByLabel("Recent runs", { exact: true });
			await recent.getByText("Checked 40 rows, all valid.").waitFor();
			await recent
				.getByText("The export for week 42 has no rows")
				.first()
				.waitFor();
			assert.equal(await recent.locator("li").count(), 5);
			await page
				.locator('a[href="/skills/alpha/runs"]')
				.filter({ hasText: "View all runs" })
				.waitFor();
			await recent
				.getByRole("button", { name: "Inputs and outputs" })
				.first()
				.click();
			await page.getByText("Period:", { exact: false }).waitFor();
			await page.getByText("last_7_days").waitFor();
			// What it uses and produces.
			await page.getByText("What it uses and produces").waitFor();
			await page.getByText("Reads documents").waitFor();
			await page.getByText("Writes sheets").waitFor();
			await page
				.getByText("4 found it helpful · 1 found it unhelpful")
				.waitFor();
			// Workflow anatomy lives on the Source tab only.
			assert.equal(await page.getByText("Workflow anatomy").count(), 0);
			assert.equal(await page.getByText("Observed reliability").count(), 0);
			await page.evaluate(() => document.fonts.ready);
			const measurement = await page.evaluate(() => ({
				viewport: { width: innerWidth, height: innerHeight },
				theme: document.documentElement.dataset.mode,
				scrollWidth: document.documentElement.scrollWidth,
			}));
			assert.equal(measurement.theme, theme);
			assert(
				measurement.scrollWidth <= viewport.width,
				`Overflow ${JSON.stringify(measurement)}`,
			);
			const screenshot = `${evidence}/${viewport.width}x${viewport.height}-${theme}.png`;
			await page.screenshot({ path: screenshot, fullPage: true });
			// A skill with no runs says so, and a missing one stays actionable.
			await page.evaluate(() =>
				(window as Fixture).overviewFixture.navigate("gamma"),
			);
			await page.getByText("Skill not found").waitFor();
			const unexpectedErrors = errors.filter(
				(error) => !error.includes("503 (Service Unavailable)"),
			);
			assert.equal(unexpectedErrors.length, 0, unexpectedErrors.join("\n"));
			receipts.push({ ...measurement, engine, screenshot, errors });
			await page.close();
		}
	console.log("Skill overview: 375/1280 light and dark checks passed");
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
	server?.kill();
	const exitCode = await server?.exited;
	await writeFile(
		`${evidence}/receipt.json`,
		JSON.stringify(
			{ origin, ready, serverExitCode: exitCode, receipts },
			null,
			2,
		),
	);
}
