// Draft → dry run of the current version → test the draft → switch on →
// roll back, in the console, against an in-memory API on local fixtures.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";

const artifacts = join(
	process.env.TMPDIR ?? "/tmp",
	"tedix-b13-skill-draft-lifecycle",
);
await mkdir(artifacts, { recursive: true });
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = String(probe.port);
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		port,
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{
		cwd: new URL("../", import.meta.url).pathname,
		stdout: "inherit",
		stderr: "inherit",
		detached: true,
	},
);

const SKILL = "fictional-skill";
const OLD_SOURCE = "export default { run() { return 'v3'; } };";
const LIVE_SOURCE = "export default { run() { return 'v4'; } };";
const NEW_SOURCE = "export default { run() { return 'v5'; } };";

async function inputOf(route: Route): Promise<Record<string, unknown>> {
	const request = route.request();
	const url = new URL(request.url());
	const body =
		request.method() === "GET"
			? JSON.parse(url.searchParams.get("data") ?? "{}")
			: request.postDataJSON();
	return (body?.json ?? {}) as Record<string, unknown>;
}

/** One organization's state for a single page visit. */
function fixtureState() {
	const baseline = {
		id: SKILL,
		organizationId: "fictional-org",
		tediId: "fictional-worker",
		title: "Fictional research",
		content: "# Fictional research",
		files: { "scripts/workflow.ts": LIVE_SOURCE },
		successCount: 0,
		failureCount: 0,
		visibility: "org",
		paceLayer: "innovation",
		revision: 4,
		lifecycleState: "active",
		revisionReasoning: "Revision 4 went live",
	};
	const revisionRow = (runId: string, revision: number) => ({
		runId,
		revision,
		skillId: SKILL,
		tediId: "fictional-worker",
		status: "completed",
		firstObservedAt: "2026-10-20T10:00:00Z",
		lastObservedAt: "2026-10-20T10:00:00Z",
		observedRunCount: 1,
		completedCount: 1,
		failedCount: 0,
		canceledCount: 0,
		runtimeDriftObserved: false,
		runtimeDriftBlocked: false,
		workerVersionId: null,
		workerVersionTag: null,
		workerVersionTimestamp: null,
		executionCompatibilityHash: null,
		dispatchShimVersion: null,
		compatibilityDate: null,
		dynamicWorkflowsVersion: null,
		loaderConfigHash: null,
		tenantCpuMs: null,
		tenantSubRequests: null,
		runtimeVariants: [],
		workflowSourceSha256: null,
		skillDocSha256: null,
	});
	const run = (id: string, skillId: string, revision: number) => ({
		id,
		organizationId: "fictional-org",
		skillId,
		tediId: "fictional-worker",
		workflowInstanceId: `wf-${id}`,
		runtimeEnvironment: "production",
		lastReconciledAt: null,
		executionEpoch: 0,
		status: "completed",
		skillRevision: revision,
		startedAt: "2026-10-27T10:00:00Z",
		completedAt: "2026-10-27T10:01:00Z",
		hasResult: true,
		hasError: false,
		result: { certification: { passed: true } },
		certification: true,
	});
	const state = {
		baseline,
		// Revision 3 ran once; revision 4 (live) has never run.
		revisions: [revisionRow("run-3", 3)],
		runs: [] as ReturnType<typeof run>[],
		drafts: [] as Record<string, unknown>[],
		dispatches: [] as Record<string, unknown>[],
		activations: [] as Record<string, unknown>[],
	};
	return {
		state,
		async handle(route: Route) {
			const endpoint = new URL(route.request().url()).pathname.split(
				"/api/rpc/",
			)[1]!;
			const input = await inputOf(route);
			const json = (body: unknown) =>
				route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ json: body }),
				});
			switch (endpoint) {
				case "userSettings/getContext":
					return json({
						authority: { permissions: ["tedis:read", "tedis:update"] },
						organization: { id: "fictional-org", appearance: null },
					});
				case "skills/get":
					return json({
						entry:
							input.id === SKILL
								? state.baseline
								: (state.drafts.find((draft) => draft.id === input.id) ?? null),
					});
				case "skills/listWorkflowRevisions":
					return json({
						provenance: "observed_executed_runs",
						sampledRunCount: state.revisions.length,
						mayBeTruncated: false,
						revisions: state.revisions,
					});
				case "skills/listByOrg":
					return json({ entries: state.drafts, total: state.drafts.length });
				case "skills/runWorkflowHistory":
					return json({
						runs: state.runs.filter((item) => item.skillId === input.skillId),
					});
				case "skills/runWorkflow": {
					state.dispatches.push(input);
					const id = `run-${state.dispatches.length + 3}`;
					const skillId = String(input.skillId);
					const revision = skillId === SKILL ? state.baseline.revision : 1;
					state.runs.push(run(id, skillId, revision));
					if (skillId === SKILL)
						state.revisions = [
							revisionRow(id, state.baseline.revision),
							...state.revisions,
						];
					return json({
						runId: id,
						workflowInstanceId: `wf-${id}`,
						status: "queued",
						workItemId: null,
						deduplicated: false,
					});
				}
				case "skills/runWorkflowStatus":
					return json(state.runs.find((item) => item.id === input.runId));
				case "skills/listRunArtifacts":
					return json({ artifacts: [], total: 0 });
				case "skills/listWorkflowToolCalls":
					return json({
						toolCalls: [
							{
								path: "calls/run/1.json",
								name: "append",
								count: 1,
								executionEpoch: 0,
								kind: "tool_call",
								outcome: "success",
								provenance: "step_artifact",
								mimeType: "application/json",
								sizeBytes: 12,
								namespace: "sheets",
								method: "append_rows",
							},
						],
						truncated: false,
						nextOffset: null,
					});
				case "skills/proposeWorkflowImprovement": {
					const baselineRun = state.runs.find(
						(item) => item.id === input.baselineRunId,
					);
					if (
						!baselineRun ||
						baselineRun.skillRevision !== state.baseline.revision
					)
						return route.fulfill({
							status: 409,
							contentType: "application/json",
							body: JSON.stringify({
								json: {
									defined: false,
									code: "CONFLICT",
									status: 409,
									message:
										"Baseline advanced; execute the current revision before proposing an improvement",
								},
							}),
						});
					const draft = {
						...state.baseline,
						id: `draft-${state.drafts.length + 1}`,
						title: `fictional-research improvement ${state.drafts.length + 1}`,
						content: input.content,
						files: input.files,
						lifecycleState: "draft",
						sourceSkillId: SKILL,
						sourceRevision: state.baseline.revision,
						tags: ["workflow-improvement", `baseline-run:${baselineRun.id}`],
						revisionReasoning: `Workflow improvement proposed from run ${baselineRun.id}. ${input.reason}`,
					};
					state.drafts.push(draft);
					return json({
						proposal: draft,
						validation: { valid: true, errors: [], warnings: [] },
						governance: {
							state: "pending_activation",
							baselineRunId: baselineRun.id,
							baselineSkillId: SKILL,
							baselineRevision: state.baseline.revision,
							baselineWorkflowSha256: "a",
							candidateWorkflowSha256: "b",
							certificationPassed: false,
						},
					});
				}
				case "skills/activateWorkflowImprovement": {
					state.activations.push(input);
					const draft = state.drafts.find((item) => item.id === input.id)!;
					state.baseline = {
						...state.baseline,
						content: String(draft.content),
						files: draft.files as { "scripts/workflow.ts": string },
						revision: state.baseline.revision + 1,
						revisionReasoning: `Switched on after ${input.certificationRunId}`,
					};
					state.drafts = state.drafts.filter((item) => item.id !== input.id);
					return json({
						baseline: state.baseline,
						proposal: { ...draft, lifecycleState: "archived" },
						governance: {},
					});
				}
				case "skills/getWorkflowRevision":
					return json({
						provenance: "observed_executed_run",
						revision: state.revisions.find(
							(item) => item.runId === input.runId,
						),
						workflowSource: input.runId === "run-3" ? OLD_SOURCE : LIVE_SOURCE,
						skillDoc: "# Fictional research v3",
					});
				case "tedis/list":
					return json({ data: [], total: 0 });
				default:
					return route.fulfill({
						status: 404,
						contentType: "application/json",
						body: JSON.stringify({
							json: {
								defined: false,
								code: "NOT_FOUND",
								status: 404,
								message: `No fixture for ${endpoint}`,
							},
						}),
					});
			}
		},
	};
}

async function waitForText(page: Page, value: string) {
	await page.getByText(value, { exact: false }).first().waitFor();
}

async function noOverflow(page: Page, step: string) {
	const overflow = await page.evaluate(() => ({
		document: document.documentElement.scrollWidth - innerWidth,
		dialog: [...document.querySelectorAll('[role="dialog"]')].map(
			(dialog) => dialog.scrollWidth - dialog.clientWidth,
		),
	}));
	assert(overflow.document <= 0, `${step}: page overflow ${overflow.document}`);
	assert(
		overflow.dialog.every((value) => value <= 0),
		`${step}: dialog overflow ${JSON.stringify(overflow.dialog)}`,
	);
}

let browser: Browser | undefined;
let cases = 0;
try {
	let ready = false;
	for (let attempt = 0; attempt < 120; attempt++) {
		assert.equal(server.exitCode, null, "fixture server remains running");
		try {
			const response = await fetch(
				`${origin}/browser-tests/b13-skill-draft-lifecycle.html`,
			);
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {}
		await Bun.sleep(250);
	}
	assert(ready, "fixture server became ready");
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 1280, height: 900 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			const name = `${viewport.width}x${viewport.height}-${theme}`;
			const context = await browser.newContext({
				viewport,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			const fixture = fixtureState();
			await page.route("**/api/rpc/**", (route) => fixture.handle(route));
			await page.goto(
				`${origin}/browser-tests/b13-skill-draft-lifecycle.html?theme=${theme}`,
			);
			await waitForText(page, "Revision 3");
			await waitForText(page, "No drafts yet.");
			await noOverflow(page, "versions");

			// 1. Draft: the live revision never ran, so the console offers the dry
			// run that creates the baseline instead of the CONFLICT error.
			await page
				.getByRole("button", { name: "New draft", exact: true })
				.click();
			await waitForText(page, "Revision 4 has no finished run yet");
			const save = page.getByRole("button", {
				name: "Save draft",
				exact: true,
			});
			assert(await save.isDisabled(), "saving waits for a baseline run");
			await page
				.getByRole("button", {
					name: "Run the current version first (dry run)",
					exact: true,
				})
				.click();
			// The dispatched dry run becomes the baseline once the history refetches.
			await page
				.getByRole("button", {
					name: "Run the current version first (dry run)",
				})
				.waitFor({ state: "detached" });
			assert.equal(fixture.state.dispatches.length, 1);
			assert.equal(fixture.state.dispatches[0]!.skillId, SKILL);
			assert.equal(fixture.state.dispatches[0]!.certification, true);
			await page.getByLabel("Draft automation source").fill(NEW_SOURCE);
			await page
				.getByLabel("Draft change reason")
				.fill("Score with the v2 rubric");
			await noOverflow(page, "draft dialog");
			await save.click();
			await waitForText(page, "Draft saved");
			assert.equal(fixture.state.drafts.length, 1);
			await page
				.getByRole("button", { name: "Close", exact: true })
				.last()
				.click();
			await waitForText(page, "Based on revision 4");
			await waitForText(page, "Not tested yet");

			// 2. Test: a certification run of the draft, read back in plain English.
			await page
				.getByRole("button", { name: "Test this draft (dry run)", exact: true })
				.click();
			await waitForText(page, "Test passed");
			await waitForText(page, "1 call, none failed");
			const dispatched = fixture.state.dispatches.at(-1)!;
			assert.equal(dispatched.skillId, "draft-1");
			assert.equal(dispatched.certification, true);
			await noOverflow(page, "tested draft");

			// 3. Switch on.
			await page
				.getByRole("button", { name: "Switch on", exact: true })
				.click();
			await waitForText(page, "revision 5 is live");
			assert.equal(fixture.state.activations.length, 1);
			assert.equal(fixture.state.activations[0]!.certificationRunId, "run-5");
			assert.equal(fixture.state.baseline.revision, 5);
			await waitForText(page, "Revision 5");

			// 4. Roll back: the earlier revision's pinned files become a new draft.
			await page
				.getByRole("button", { name: "Roll back to revision 3", exact: true })
				.first()
				.click();
			await waitForText(page, "restores revision 3");
			assert.equal(
				await page.getByLabel("Draft automation source").inputValue(),
				OLD_SOURCE,
			);
			assert.match(
				await page.getByLabel("Draft change reason").inputValue(),
				/Roll back to revision 3/,
			);
			await noOverflow(page, "rollback dialog");
			await page.screenshot({
				path: join(artifacts, `${name}.png`),
				fullPage: true,
			});
			assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
			cases++;
			await context.close();
		}
	}
	console.log(`Passed ${cases} skill draft lifecycle viewport/theme cases`);
} finally {
	await browser?.close();
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
