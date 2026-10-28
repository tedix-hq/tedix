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
const entry = (id: string, title: string, feedback = false) => ({
	id,
	organizationId: "example",
	title,
	slug: `${id}-skill`,
	description: `Description for ${title}.`,
	summary: `Summary for ${title}.`,
	tags: ["verification", "exports"],
	content: `# ${title}\n\nCheck the export.`,
	files: { "references/policy.md": "Policy text." },
	successCount: feedback ? 4 : 0,
	failureCount: feedback ? 1 : 0,
	revision: 3,
	visibility: "org",
	paceLayer: "record",
});
const run = (index: number) => ({
	id: `run-${index}`,
	organizationId: "example",
	skillId: "alpha",
	tediId: "worker",
	workflowInstanceId: `wf-${index}`,
	runtimeEnvironment: "development",
	lastReconciledAt: "2026-10-21T12:00:00Z",
	executionEpoch: 0,
	status: index % 6 === 5 ? "failed" : "completed",
	skillRevision: 3,
	startedAt: `2026-10-21T1${index}:00:00Z`,
	completedAt: `2026-10-21T1${index}:02:00Z`,
	hasResult: true,
	hasError: index % 6 === 5,
});
const reliabilityFor = (skillId: string) => ({
	scope: { skillId, tediId: null },
	runCount: skillId === "alpha" ? 7 : 0,
	completedCount: skillId === "alpha" ? 6 : 0,
	failedCount: skillId === "alpha" ? 1 : 0,
	canceledCount: 0,
	activeCount: 0,
	successRate: skillId === "alpha" ? 0.86 : null,
	completionRate: skillId === "alpha" ? 0.86 : null,
	expectedOutcomes: {
		evaluatedCount: 0,
		matchedCount: 0,
		unexpectedCount: 0,
		expectedCompletedCount: 0,
		expectedFailedCount: 0,
		expectedCanceledCount: 0,
		unexpectedRuns: [],
	},
	averageDurationMs: skillId === "alpha" ? 3400 : null,
	retryAttemptCount: 0,
	rollbackCount: 0,
	toolCallCount: 0,
	failedSteps: [],
	warnings:
		skillId === "alpha"
			? [
					"3 of 7 selected runs have no steps/** evidence; retry, rollback, tool-call, and failed-step counts are lower bounds.",
				]
			: [],
});
type Fixture = Window & {
	overviewFixture: {
		refreshReliability(): Promise<void>;
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
		{ width: 768, height: 1024 },
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
			let failReliability = true;
			let failRuns = true;
			let releaseReliability: (() => void) | undefined;
			let releaseRuns: (() => void) | undefined;
			let reliabilityHold: Promise<void> | null = new Promise(
				(resolve) => (releaseReliability = resolve),
			);
			let runsHold: Promise<void> | null = new Promise(
				(resolve) => (releaseRuns = resolve),
			);
			const methods: string[] = [];
			const procedures: string[] = [];
			const reliabilityReads: string[] = [];
			const runsReads: string[] = [];
			const detailReads: string[] = [];
			await page.route("**/api/**", async (route) => {
				const request = route.request();
				methods.push(request.method());
				const url = new URL(request.url());
				const input =
					request.method() === "GET"
						? JSON.parse(url.searchParams.get("data") ?? "{}").json
						: request.postDataJSON()?.json;
				const pathname = url.pathname;
				procedures.push(pathname.slice(pathname.lastIndexOf("/skills/")));
				if (pathname.endsWith("/skills/getWorkflowReliability")) {
					const skillId = String(input?.skillId);
					if (skillId === "alpha" && reliabilityHold) await reliabilityHold;
					reliabilityReads.push(skillId);
					if (skillId === "alpha" && failReliability)
						return route.fulfill({
							status: 503,
							json: {
								json: {
									defined: false,
									code: "SERVICE_UNAVAILABLE",
									message: "Reliability read failed",
								},
							},
						});
					return route.fulfill({ json: { json: reliabilityFor(skillId) } });
				}
				if (pathname.endsWith("/skills/runWorkflowHistory")) {
					const skillId = String(input?.skillId);
					if (skillId === "alpha" && runsHold) await runsHold;
					runsReads.push(skillId);
					if (skillId === "alpha" && failRuns)
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
					return route.fulfill({
						json: {
							json: {
								runs: skillId === "alpha" ? [0, 1, 2, 3, 4, 5, 6].map(run) : [],
							},
						},
					});
				}
				if (pathname.endsWith("/skills/get")) {
					const skillId = String(input?.id);
					detailReads.push(skillId);
					const known: Record<string, string> = {
						alpha: "Alpha verifier",
						beta: "Beta reviewer",
					};
					return route.fulfill({
						json: {
							json: {
								entry: known[skillId]
									? entry(skillId, known[skillId], skillId === "alpha")
									: null,
							},
						},
					});
				}
				throw new Error(`Unexpected API call ${pathname}`);
			});
			await page.goto(
				`${origin}/browser-tests/b13-skill-overview-read-states.html?theme=${theme}`,
			);
			await page.getByText("Reading…", { exact: true }).waitFor();
			assert.equal(await page.getByText("No runs yet").count(), 0);
			assert.equal(
				await page.getByText("This skill has not run yet.").count(),
				0,
			);
			assert.equal(await page.getByText("Unavailable").count(), 0);
			await page.getByText("Recent runs", { exact: true }).waitFor();
			// Cold failure: both reads land as errors — never as "no executions".
			releaseReliability?.();
			releaseRuns?.();
			reliabilityHold = null;
			runsHold = null;
			await page.getByText("Unavailable", { exact: true }).waitFor();
			await page.getByText("Runs unavailable", { exact: true }).waitFor();
			await page
				.getByText("Run evidence could not be loaded.", { exact: false })
				.waitFor();
			assert.equal(await page.getByText("No runs yet").count(), 0);
			assert.equal(
				await page.getByText("This skill has not run yet.").count(),
				0,
			);
			assert.equal(
				await page.getByRole("button", { name: "Retry", exact: true }).count(),
				2,
			);
			// Independent retry: reliability recovers while runs stay failed.
			failReliability = false;
			await page
				.getByRole("button", { name: "Retry", exact: true })
				.first()
				.click();
			await page.getByText("86%", { exact: true }).waitFor();
			// Partial evidence reads as a plain sentence; counting rules stay
			// behind the Technical details disclosure.
			await page.getByText(/Some runs have incomplete records/).waitFor();
			assert.equal(
				await page.getByText(/steps\/\*\* evidence/).isVisible(),
				false,
			);
			await page.getByRole("button", { name: "Technical details" }).click();
			await page.getByText(/steps\/\*\* evidence/).waitFor();
			await page.getByRole("button", { name: "Technical details" }).click();
			await page.getByText(/steps\/\*\* evidence/).waitFor({ state: "hidden" });
			await page.getByText("4 helpful · 1 unhelpful").waitFor();
			await page.getByText("Runs unavailable", { exact: true }).waitFor();
			// The other read recovers on its own retry.
			failRuns = false;
			await page
				.getByRole("button", { name: "Retry", exact: true })
				.first()
				.click();
			await page.locator('[data-slot="table"] tbody tr').first().waitFor();
			assert.equal(
				await page.locator('[data-slot="table"] tbody tr').count(),
				5,
			);
			await page
				.locator('a[href="/skills/alpha/runs"]')
				.filter({ hasText: "View all" })
				.waitFor();
			// Refresh failure keeps the previously loaded evidence on screen.
			failReliability = true;
			failRuns = true;
			await page.evaluate(() =>
				(window as Fixture).overviewFixture.refreshReliability(),
			);
			await page.evaluate(() =>
				(window as Fixture).overviewFixture.refreshRuns(),
			);
			await page.getByText(/figures shown may be out of date/).waitFor();
			await page.getByText("Could not refresh runs", { exact: true }).waitFor();
			assert.equal(await page.getByText("86%", { exact: true }).count(), 1);
			assert.equal(
				await page.locator('[data-slot="table"] tbody tr').count(),
				5,
			);
			// Read-only retries clear the refresh warnings.
			failReliability = false;
			failRuns = false;
			await page
				.getByRole("button", { name: "Retry", exact: true })
				.first()
				.click();
			await page
				.getByText(/figures shown may be out of date/)
				.waitFor({ state: "hidden" });
			await page
				.getByRole("button", { name: "Retry", exact: true })
				.first()
				.click();
			await page
				.getByText("Could not refresh runs", { exact: true })
				.waitFor({ state: "hidden" });
			// The Advanced source disclosure stays one tap away.
			await page.evaluate(() => document.fonts.ready);
			const summaryScreenshot = `${evidence}/${viewport.width}x${viewport.height}-${theme}-summary.png`;
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.screenshot({ path: summaryScreenshot, fullPage: false });
			await page.getByRole("button", { name: "Technical details" }).focus();
			await page.keyboard.press("Enter");
			await page.getByText(/steps\/\*\* evidence/).waitFor();
			await page
				.getByRole("button", { name: "Instructions and source" })
				.focus();
			await page.keyboard.press("Enter");
			await page.getByText("references", { exact: true }).waitFor();
			await page.getByText("SKILL.md", { exact: true }).first().waitFor();
			await page.evaluate(() => document.fonts.ready);
			const measurement = await page.evaluate(() => ({
				viewport: { width: innerWidth, height: innerHeight },
				theme: document.documentElement.dataset.mode,
				colorScheme: getComputedStyle(document.documentElement).colorScheme,
				scrollWidth: document.documentElement.scrollWidth,
				targets: [...document.querySelectorAll("button,a")].map((node) => {
					const r = node.getBoundingClientRect();
					return { text: node.textContent, width: r.width, height: r.height };
				}),
			}));
			assert.deepEqual(measurement.viewport, viewport);
			assert.equal(measurement.theme, theme);
			assert.equal(measurement.colorScheme, theme);
			assert(
				measurement.scrollWidth <= viewport.width,
				`Overflow ${JSON.stringify(measurement)}`,
			);
			const screenshot = `${evidence}/${viewport.width}x${viewport.height}-${theme}.png`;
			await page.evaluate(() => window.scrollTo(0, 0));
			const png = await page.screenshot({ path: screenshot, fullPage: false });
			assert.equal(png.readUInt32BE(16), viewport.width);
			assert.equal(png.readUInt32BE(20), viewport.height);
			// A different skillId reads fresh state, not the previous skill's.
			await page.evaluate(() =>
				(window as Fixture).overviewFixture.navigate("beta"),
			);
			await page.getByText("No runs yet", { exact: true }).waitFor();
			await page
				.getByText("This skill has not run yet.", { exact: true })
				.waitFor();
			await page.getByText("No feedback yet", { exact: true }).waitFor();
			assert.deepEqual(
				runsReads.filter((id) => id === "beta"),
				["beta"],
			);
			assert.deepEqual(
				reliabilityReads.filter((id) => id === "beta"),
				["beta"],
			);
			assert.equal(
				await page.locator('[data-slot="table"] tbody tr').count(),
				0,
			);
			// An unknown skillId keeps the not-found state actionable.
			await page.evaluate(() =>
				(window as Fixture).overviewFixture.navigate("gamma"),
			);
			await page.getByText("Skill not found").waitFor();
			assert.deepEqual(
				detailReads.filter((id) => id === "gamma"),
				["gamma"],
			);
			const unexpectedErrors = errors.filter(
				(error) => !error.includes("503 (Service Unavailable)"),
			);
			assert.equal(unexpectedErrors.length, 0, unexpectedErrors.join("\n"));
			assert.deepEqual([...new Set(procedures)].sort(), [
				"/skills/get",
				"/skills/getWorkflowReliability",
				"/skills/runWorkflowHistory",
			]);
			receipts.push({
				...measurement,
				engine,
				summaryScreenshot,
				screenshot,
				screenshotDimensions: viewport,
				reliabilityReads,
				runsReads,
				detailReads,
				methods: methods.length,
				errors,
			});
			await page.close();
		}
	console.log("Skill overview read states: six viewport/theme checks passed");
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
