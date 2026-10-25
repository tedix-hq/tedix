import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

// The live delegation card at phone and desktop widths, light and dark:
// progress, timing and the activity list fit without horizontal overflow, a
// stalled run says so with Stop and retry reachable, and a finished run folds
// to one summary line. Set DELEGATION_LIVE_EVIDENCE_DIR to save screenshots.
const fixturePath = "/browser-tests/delegation-live.html";
const server = await startFixtureServer(fixturePath);
const evidenceDir = process.env.DELEGATION_LIVE_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

async function noOverflow(page: Page, width: number) {
	const report = await page.evaluate(() => ({
		page: document.documentElement.scrollWidth,
		clipped: Array.from(
			document.querySelectorAll<HTMLElement>("[data-fixture] *"),
		)
			.filter((node) => {
				const box = node.getBoundingClientRect();
				return box.width > 0 && box.right > window.innerWidth + 0.5;
			})
			.map((node) => node.className),
	}));
	assert(report.page <= width, `Page scrolls sideways: ${report.page}`);
	assert.deepEqual(report.clipped, [], "Nothing runs past the viewport");
}

let browser: Browser | undefined;
try {
	browser = await chromium.launch();
	for (const theme of ["light", "dark"] as const)
		for (const [width, height] of [
			[375, 812],
			[1280, 900],
		] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
				hasTouch: width < 820,
			});
			await page.goto(`${server.origin}${fixturePath}?theme=${theme}`);
			const working = page.locator('[data-fixture="working"]');
			await working.locator('[data-slot="delegation-work-card"]').waitFor();
			await page.evaluate(() => document.fonts.ready);

			// Working: plain current step, a real bar, elapsed and last activity.
			assert.equal(
				await working.locator("[data-phase]").getAttribute("data-phase"),
				"working",
			);
			await working
				.getByText("Writing the summary for this week's community threads")
				.waitFor();
			await working.getByText("48 of 100").waitFor();
			await working
				.getByText(/^Running 7m( \d\ds)? · last activity 12s ago$/)
				.waitFor();
			assert.equal(
				await working.getByRole("button", { name: "Stop" }).count(),
				0,
			);
			await working.locator('[data-slot="delegation-activity-toggle"]').click();
			const steps = working.locator('[data-slot="delegation-activity"] li');
			await steps.first().waitFor();
			assert.deepEqual(
				await steps
					.allInnerTexts()
					.then((rows) => rows.map((row) => row.replace(/\s+/g, " ").trim())),
				[
					"Started Done",
					"Community: search posts 9s",
					"Community: read thread 28s",
					"Notes: write summary Running",
				],
			);

			// Stalled: one warning line, Stop and Stop and retry within reach.
			const stalled = page.locator('[data-fixture="stalled"]');
			await stalled.getByText("May be stuck", { exact: true }).waitFor();
			await stalled
				.getByText("No activity for 7 min. It may be stuck.")
				.waitFor();
			for (const name of ["Stop", "Stop and retry"]) {
				const button = stalled.getByRole("button", { name, exact: true });
				await button.waitFor();
				const box = await button.boundingBox();
				assert(
					box && box.height >= (width < 820 ? 32 : 28),
					`${name} is reachable`,
				);
			}

			// Finished: one line, duration and cost.
			await page
				.locator('[data-fixture="finished"]')
				.getByText("Community Operator finished in 8m 03s · €0.04")
				.waitFor();

			await noOverflow(page, width);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/delegation-live-${width}-${theme}.png`,
					fullPage: true,
				});
			await page.close();
		}
	console.log("delegation live card: ok");
} finally {
	await browser?.close();
	await server.stop();
}
