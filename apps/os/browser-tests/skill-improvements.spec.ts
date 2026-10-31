import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence = process.env.SHELL_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const path = "/browser-tests/skill-versions-layout.html";
const server = await startFixtureServer(path);
let browser;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [390, 1280])
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 1000 },
				reducedMotion: "reduce",
			});
			try {
				const errors: string[] = [];
				page.on("pageerror", (error) => errors.push(error.message));
				await page.goto(
					`${server.origin}${path}?theme=${theme}&improvements=1`,
				);
				const section = page.getByRole("region", {
					name: "Improvements",
					exact: true,
				});
				await section
					.getByText("Adopted as revision 3", { exact: true })
					.waitFor();
				assert.equal(
					await section.getByText("Skip duplicate source requests").count(),
					1,
				);
				assert.equal(
					await section
						.getByRole("link", { name: "View passed test run" })
						.getAttribute("href"),
					"/work/runs/passed-test",
				);
				assert.equal(
					await section
						.getByText("Waiting for review (1)", { exact: true })
						.count(),
					1,
				);
				assert.equal(
					await section
						.getByRole("button", { name: "Reject draft", exact: true })
						.count(),
					1,
				);
				assert.equal(
					await section
						.getByRole("button", { name: "Switch on", exact: true })
						.isDisabled(),
					true,
				);
				assert.equal(
					await section
						.getByText("Abandoned wider search", { exact: true })
						.isVisible(),
					false,
				);
				await section
					.getByRole("button", {
						name: "Rejected or abandoned (1)",
						exact: true,
					})
					.click();
				await section
					.getByText("Abandoned wider search", { exact: true })
					.waitFor();
				assert.equal(
					await page.evaluate(
						() => document.documentElement.scrollWidth > innerWidth,
					),
					false,
				);
				assert.doesNotMatch(
					await section.innerText(),
					/certification|differentiation|pace layer/i,
				);
				if (evidence)
					await page.screenshot({
						path: `${evidence}/improvements-${width}-${theme}.png`,
						fullPage: true,
					});
				assert.deepEqual(errors, []);
				console.log(
					`${width}/${theme}: adoption, test link, waiting controls, collapsed history and width passed`,
				);
			} finally {
				await page.close();
			}
		}
} finally {
	await browser?.close();
	await server.stop();
}
