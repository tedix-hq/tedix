import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { chromium, type Page } from "playwright";

/*
 * Workspace Work pane in the zero-account fixture lanes. In the classic
 * fixtures the seeded project links populate the list from both linked
 * projects; in the default sample-data pack each workspace's linked project
 * fills it. Either way the sprint filter appears and nothing renders the
 * unsupported-procedure error — at phone and desktop width, light and dark.
 */
const cwd = new URL("../", import.meta.url).pathname;
const shots =
	process.env.WORKSPACE_WORK_SCREENSHOTS ??
	new URL("../node_modules/.cache/workspace-work-screenshots/", import.meta.url)
		.pathname;
await mkdir(shots, { recursive: true });
const workspacePath =
	"/workspace/00000030-0000-4000-8000-000000000001?pane=work";

const lanes = [
	{
		name: "classic",
		env: { TEDIX_OS_FIXTURE_PACK: "classic" },
		// The unfiltered list merges both linked projects (OPS and GROWTH).
		async check(panel: ReturnType<Page["locator"]>) {
			for (const title of [
				"Rebuild the churn cohort query with paging",
				"Review the dunning-recovery email copy",
			])
				await panel.getByRole("link", { name: title }).waitFor();
		},
	},
	{
		name: "sample-data",
		env: {},
		async check(panel: ReturnType<Page["locator"]>) {
			await panel.getByRole("link").first().waitFor();
		},
	},
];

async function freePort() {
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = String(probe.port!);
	probe.stop();
	return port;
}

for (const lane of lanes) {
	const port = await freePort();
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
			cwd,
			env: { ...process.env, ...lane.env },
			stdout: "inherit",
			stderr: "inherit",
			detached: true,
		},
	);
	const browser = await chromium.launch({ headless: true }).catch((error) => {
		server.kill();
		throw error;
	});
	try {
		await waitForFixtureServer(`${origin}/work`, { server });
		for (const width of [1280, 390])
			for (const theme of ["light", "dark"] as const) {
				const page = await browser.newPage({
					viewport: { width, height: 900 },
					colorScheme: theme,
					reducedMotion: "reduce",
					locale: "en-GB",
					timezoneId: "UTC",
				});
				await page.addInitScript(
					(mode) => localStorage.setItem("tedix-os-theme", mode),
					theme,
				);
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(error.message));
				await page.goto(`${origin}${workspacePath}`);
				const panel = page.locator('[aria-label="Workspace Work"]');
				await panel.waitFor({ timeout: 30_000 });
				await lane.check(panel);
				assert(
					await page.locator('[aria-label="Work sprint"]').isVisible(),
					`${lane.name}: sprint filter renders with seeded sprints`,
				);
				assert.equal(
					await panel
						.getByText("Some workspace work could not be loaded")
						.count(),
					0,
					`${lane.name}: no fixture-coverage error`,
				);
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth + 1,
					),
					`${lane.name} ${width}/${theme}: no horizontal overflow`,
				);
				assert.deepEqual(errors, [], "page errors");
				await page.screenshot({
					path: `${shots}/workspace-work-${lane.name}-${width}-${theme}.png`,
					fullPage: true,
				});
				await page.close();
				console.log(`PASS workspace work pane ${lane.name} ${width}/${theme}`);
			}
	} finally {
		await browser.close();
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await server.exited;
	}
}
