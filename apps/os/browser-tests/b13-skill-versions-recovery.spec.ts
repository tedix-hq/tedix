import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const artifacts = join(
	process.env.TMPDIR ?? "/tmp",
	"tedix-b13-skill-versions-recovery",
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
const hash = "0123456789abcdef".repeat(4);
const worker = `worker-${"identifier".repeat(16)}`;
const manifest = `skills/${"long-manifest-segment".repeat(12)}/manifest.json`;
const detail = {
	entry: {
		revision: 7,
		revisionReasoning: "Verified executed revision reasoning",
	},
};
const history = {
	provenance: "observed_executed_runs",
	sampledRunCount: 100,
	mayBeTruncated: true,
	revisions: [
		{
			runId: "fictional-run",
			revision: 7,
			observedRunCount: 12,
			completedCount: 8,
			failedCount: 3,
			canceledCount: 1,
			lastObservedAt: null,
			workflowSourceSha256: hash,
			skillDocSha256: hash,
			workerVersionId: worker,
			executionCompatibilityHash: hash,
			runtimeDriftObserved: true,
			runtimeDriftBlocked: true,
			runtimeVariants: [
				{
					runId: "fictional-run",
					executionEpoch: 2,
					manifestPath: manifest,
					observation: "blocked",
					workerVersionId: worker,
				},
			],
		},
	],
};

async function waitForText(page: Page, value: string) {
	await page.getByText(value, { exact: false }).first().waitFor();
}

async function useKeyboard(page: Page, name: string) {
	const button = page.getByRole("button", { name, exact: true });
	await button.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	const focus = await button.evaluate((element) => ({
		active: document.activeElement === element,
		visible: element.matches(":focus-visible"),
	}));
	const box = await button.boundingBox();
	assert(focus.active && focus.visible, `${name} has visible keyboard focus`);
	assert(box, `${name} has a layout box`);
	if (page.viewportSize()!.width < 640) {
		assert(box.width >= 44 && box.height >= 44, `${name} has a 44px target`);
	}
	await page.keyboard.press("Enter");
}

let browser: Browser | undefined;
let cases = 0;
try {
	let ready = false;
	for (let attempt = 0; attempt < 120; attempt++) {
		assert.equal(server.exitCode, null, "fixture server remains running");
		try {
			const response = await fetch(
				`${origin}/browser-tests/b13-skill-versions-recovery.html`,
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
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			let failDetail = true;
			let failVersions = true;
			const reads = { get: 0, listWorkflowRevisions: 0 };
			await page.route("**/api/rpc/skills/**", async (route) => {
				const endpoint = new URL(route.request().url()).pathname
					.split("/")
					.at(-1);
				assert(
					endpoint === "get" || endpoint === "listWorkflowRevisions",
					`unexpected endpoint ${endpoint}`,
				);
				reads[endpoint]++;
				const failed = endpoint === "get" ? failDetail : failVersions;
				await route.fulfill({
					status: failed ? 503 : 200,
					contentType: "application/json",
					body: JSON.stringify(
						failed
							? {
									json: {
										defined: false,
										code: "SERVICE_UNAVAILABLE",
										status: 503,
										message: `${endpoint} fixture unavailable`,
									},
								}
							: { json: endpoint === "get" ? detail : history },
					),
				});
			});
			await page.goto(
				`${origin}/browser-tests/b13-skill-versions-recovery.html?theme=${theme}`,
			);
			await waitForText(page, "Current version verification unavailable");
			await waitForText(page, "Versions unavailable");

			const detailReads = reads.get;
			failVersions = false;
			await useKeyboard(page, "Retry versions");
			await waitForText(page, "Revision 7");
			assert.equal(reads.get, detailReads, "versions retry is independent");
			assert.equal(await page.getByText("Current", { exact: true }).count(), 0);

			const versionReads = reads.listWorkflowRevisions;
			failDetail = false;
			await useKeyboard(page, "Retry skill details");
			await waitForText(page, "Verified executed revision reasoning");
			assert.equal(
				reads.listWorkflowRevisions,
				versionReads,
				"detail retry is independent",
			);

			failDetail = true;
			failVersions = true;
			await page
				.getByRole("button", { name: "Refresh fixture reads", exact: true })
				.click();
			await waitForText(page, "Versions could not refresh");
			await waitForText(page, "Showing previously loaded execution evidence");
			await waitForText(page, "Current version verification unavailable");
			await waitForText(page, "Revision 7");
			assert.equal(await page.getByText("Current", { exact: true }).count(), 0);

			failDetail = false;
			failVersions = false;
			await page
				.getByRole("button", { name: "Retry skill details", exact: true })
				.click();
			await page
				.getByRole("button", { name: "Retry versions", exact: true })
				.click();
			await waitForText(page, "Verified executed revision reasoning");
			await useKeyboard(page, "Technical evidence");
			await waitForText(page, manifest);
			await waitForText(page, "drift blocked");
			const layout = await page.evaluate(() => {
				const diagnostics = [
					...document.querySelectorAll("main td span"),
				].filter((element) =>
					/Workflow SHA-256:|SKILL.md SHA-256:|Worker:|manifest.json/.test(
						element.textContent ?? "",
					),
				);
				return {
					documentOverflow: document.documentElement.scrollWidth - innerWidth,
					mainOverflow:
						document.querySelector("main")!.scrollWidth -
						document.querySelector("main")!.clientWidth,
					diagnostics: diagnostics.map((element) => ({
						overflow: element.scrollWidth - element.clientWidth,
						wrap: getComputedStyle(element).overflowWrap,
					})),
				};
			});
			assert(layout.documentOverflow <= 0, JSON.stringify(layout));
			assert(layout.mainOverflow <= 0, JSON.stringify(layout));
			assert(layout.diagnostics.length >= 4, "technical fields are mounted");
			assert(
				layout.diagnostics.every(
					(field) => field.overflow <= 0 && field.wrap === "anywhere",
				),
				JSON.stringify(layout.diagnostics),
			);
			assert((await page.locator("main").innerText()).includes(hash));
			assert((await page.locator("main").innerText()).includes(worker));
			assert.equal(pageErrors.length, 0, JSON.stringify(pageErrors));
			await page.screenshot({
				path: join(
					artifacts,
					`${viewport.width}x${viewport.height}-${theme}.png`,
				),
				fullPage: true,
			});
			cases++;
			await context.close();
		}
	}
	console.log(`Passed ${cases} skill-version recovery viewport/theme cases`);
} finally {
	await browser?.close();
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
