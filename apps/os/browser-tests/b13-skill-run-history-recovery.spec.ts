import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";

const artifacts = join(
	process.env.TMPDIR ?? "/tmp",
	"tedix-b13-skill-run-history-recovery",
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
		env: { ...process.env, VITE_LIVE_API: "0" },
	},
);
const STATUSES = [
	"All",
	"Queued",
	"Running",
	"Paused",
	"Failed",
	"Completed",
	"Canceled",
];
const summary = {
	organizationId: "fictional-org",
	skillId: "fictional-skill",
	tediId: "fictional-tedi",
	workflowInstanceId: "fictional-workflow",
	runtimeEnvironment: "development",
	lastReconciledAt: null,
	executionEpoch: 0,
	hasResult: true,
	hasError: false,
	skillRevision: 4,
};
const runningRun = {
	...summary,
	id: "fictional-running-run",
	status: "running",
	startedAt: "2026-10-21T12:00:00Z",
	completedAt: null,
};
const doneRun = {
	...summary,
	id: "fictional-completed-run",
	status: "completed",
	startedAt: "2026-10-21T11:00:00Z",
	completedAt: "2026-10-21T11:00:03Z",
};

type Read = { status: string | undefined; at: number };

async function inputOf(route: Route) {
	const request = route.request();
	const url = new URL(request.url());
	const body =
		request.method() === "GET"
			? JSON.parse(url.searchParams.get("data") ?? "{}")
			: request.postDataJSON();
	return (body?.json ?? {}) as { status?: string; skillId?: string };
}

async function pressSegment(page: Page, name: string) {
	await page
		.getByRole("group", { name: "Filter skill runs" })
		.getByRole("button", { name, exact: true })
		.click();
}

let browser: Browser | undefined;
const receipts: unknown[] = [];
try {
	let ready = false;
	for (let attempt = 0; attempt < 360; attempt++) {
		assert.equal(server.exitCode, null, "fixture server remains running");
		try {
			ready = (
				await fetch(
					`${origin}/browser-tests/b13-skill-run-history-recovery.html`,
				)
			).ok;
		} catch {}
		if (ready) break;
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
			const name = `${viewport.width}x${viewport.height}-${theme}`;
			const context = await browser.newContext({
				viewport,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			const pageErrors: string[] = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			const reads: Read[] = [];
			let fail = true;
			let hold: Promise<void> | undefined;
			await page.route("**/api/**", async (route) => {
				const path = new URL(route.request().url()).pathname;
				assert(
					path.endsWith("/skills/runWorkflowHistory"),
					`unexpected call ${path}`,
				);
				const input = await inputOf(route);
				assert.equal(input.skillId, "fictional-skill");
				reads.push({ status: input.status, at: Date.now() });
				if (hold) await hold;
				if (fail)
					return route.fulfill({
						status: 503,
						contentType: "application/json",
						body: JSON.stringify({
							json: {
								defined: false,
								code: "SERVICE_UNAVAILABLE",
								status: 503,
								message: "Fictional run history unavailable",
							},
						}),
					});
				const runs =
					input.status === undefined
						? [runningRun, doneRun]
						: [runningRun, doneRun].filter(
								(run) => run.status === input.status,
							);
				return route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ json: { runs } }),
				});
			});
			await page.goto(
				`${origin}/browser-tests/b13-skill-run-history-recovery.html?theme=${theme}`,
			);

			// A failed first read is an error, never an empty history.
			await page.getByText("Runs unavailable").waitFor();
			assert.equal(await page.getByText("No runs to show").count(), 0);

			// Retry the exact query with the keyboard.
			fail = false;
			const retry = page.getByRole("button", { name: "Try again" });
			await retry.focus();
			assert(await retry.evaluate((el) => el.matches(":focus-visible")));
			const before = reads.length;
			await page.keyboard.press("Enter");
			await page
				.locator('a[href="/work/runs/fictional-running-run"]')
				.waitFor();
			assert.equal(reads[before]?.status, undefined, "retry reads All again");
			assert.equal(await page.getByText("Runs unavailable").count(), 0);

			// All seven statuses are reachable, with 44px phone targets and
			// visible keyboard focus.
			const group = page.getByRole("group", { name: "Filter skill runs" });
			await group.getByRole("button", { name: "All", exact: true }).focus();
			const targets = [];
			for (const [index, label] of STATUSES.entries()) {
				if (index > 0) await page.keyboard.press("ArrowRight");
				const segment = group.getByRole("button", { name: label, exact: true });
				const state = await segment.evaluate((el) => {
					const box = el.getBoundingClientRect();
					const rail = el.parentElement!.getBoundingClientRect();
					const style = getComputedStyle(el);
					return {
						focused: document.activeElement === el,
						visible: el.matches(":focus-visible"),
						ring: style.boxShadow !== "none" || style.outlineStyle !== "none",
						width: box.width,
						height: box.height,
						inRail: box.left >= rail.left - 1 && box.right <= rail.right + 1,
					};
				});
				assert(state.focused && state.visible && state.ring, label);
				assert(state.inRail, `${label} scrolls into view`);
				if (viewport.width < 640)
					assert(state.width >= 44 && state.height >= 44, label);
				targets.push({ label, ...state });
			}

			// A status change shows loading, never the previous filter's rows.
			let release!: () => void;
			hold = new Promise((done) => {
				release = done;
			});
			await pressSegment(page, "Failed");
			await page.waitForFunction(
				() => document.querySelector('[data-slot="skeleton"]') !== null,
			);
			assert.equal(await page.locator('a[href^="/work/runs/"]').count(), 0);
			release();
			hold = undefined;
			await page.getByText("No runs match this status.").waitFor();
			assert.equal(reads.at(-1)?.status, "failed");

			// A status query without active runs does not poll.
			const settled = reads.length;
			await page.waitForTimeout(5_600);
			assert.equal(reads.length, settled, "inactive query does not poll");

			// The All query has a running run and polls every five seconds.
			await pressSegment(page, "All");
			await page
				.locator('a[href="/work/runs/fictional-running-run"]')
				.waitFor();
			const first = reads.length;
			await page.waitForTimeout(5_600);
			const polls = reads.slice(first);
			assert(polls.length >= 1, "active query polls");
			assert(polls.every((read) => read.status === undefined));

			// A failed refresh keeps the cached rows and says they may be stale.
			fail = true;
			await page
				.getByRole("button", { name: "Refresh fixture reads", exact: true })
				.click();
			await page.getByText("Runs could not refresh").waitFor();
			await page
				.getByText("they may be out of date", { exact: false })
				.waitFor();
			assert.equal(
				await page
					.locator('a[href="/work/runs/fictional-running-run"]')
					.count(),
				1,
			);
			assert.equal(
				await page
					.locator('a[href="/work/runs/fictional-completed-run"]')
					.count(),
				1,
			);
			const layout = await page.evaluate(() => ({
				overflow: document.documentElement.scrollWidth - innerWidth,
				colorScheme: getComputedStyle(document.documentElement).colorScheme,
			}));
			assert(layout.overflow <= 0, JSON.stringify(layout));
			assert.equal(layout.colorScheme, theme);
			await page.screenshot({
				path: join(artifacts, `${name}-stale.png`),
				fullPage: true,
			});
			fail = false;
			await page.getByRole("button", { name: "Try again" }).click();
			await page
				.getByText("Runs could not refresh")
				.waitFor({ state: "detached" });
			await page.screenshot({
				path: join(artifacts, `${name}-recovered.png`),
				fullPage: true,
			});
			assert.deepEqual(pageErrors, []);
			receipts.push({ name, layout, targets, reads: reads.length });
			await context.close();
		}
	}
	await writeFile(
		join(artifacts, "receipts.json"),
		JSON.stringify(receipts, null, 2),
	);
	console.log(
		`Passed ${receipts.length} skill run history viewport/theme cases; proof in ${artifacts}`,
	);
} finally {
	await browser?.close();
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
