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
	const width = 390;
	const theme = "dark";
	const page = await browser.newPage({
		viewport: { width, height: 1000 },
		reducedMotion: "reduce",
	});
	try {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(`${server.origin}${path}?theme=${theme}&improvements=1`);
		const section = page.getByRole("region", {
			name: "Drafts",
			exact: true,
		});
		// Only the draft still waiting is a row on the card.
		await section.getByText("Clearer source review").first().waitFor();
		assert.equal(await section.locator('[aria-label^="Draft "]').count(), 1);
		assert.equal(
			await section
				.getByText("Adopted as revision 3", { exact: true })
				.isVisible(),
			false,
		);
		// The version it became carries the passed test instead.
		assert.equal(
			await page
				.locator('[data-version-row="3"]')
				.getByRole("link", { name: "Test passed" })
				.getAttribute("href"),
			"/work/runs/passed-test",
		);
		assert.equal(
			await section
				.getByRole("button", { name: "Reject draft", exact: true })
				.count(),
			1,
		);
		assert.equal(
			await section
				.getByRole("button", { name: "Adopt", exact: true })
				.isDisabled(),
			true,
		);
		assert.equal(
			await section
				.getByText("Abandoned wider search", { exact: false })
				.isVisible(),
			false,
		);
		await section
			.getByRole("button", { name: "Earlier drafts (2)", exact: true })
			.click();
		await section
			.getByText("Abandoned wider search · not adopted", { exact: true })
			.waitFor();
		await section.getByText("Adopted as revision 3", { exact: true }).waitFor();
		assert.equal(
			await section.getByText("Skip duplicate source requests").count(),
			1,
		);
		assert.equal(
			await page
				.locator('[data-version-row="3"] [data-version-message]')
				.innerText(),
			"Skip duplicate source requests",
		);
		assert.doesNotMatch(
			await page.locator("body").innerText(),
			/[0-9a-f]{8}-[0-9a-f]{4}-|proposed from run/,
		);
		assert.equal(
			await section
				.getByRole("link", { name: "View passed test run" })
				.getAttribute("href"),
			"/work/runs/passed-test",
		);
		assert.equal(
			await section.getByRole("button", { name: "Test", exact: true }).count(),
			1,
		);
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
			`${width}/${theme}: waiting draft controls, version test link, collapsed earlier drafts and width passed`,
		);
	} finally {
		await page.close();
	}
} finally {
	await browser?.close();
	await server.stop();
}
