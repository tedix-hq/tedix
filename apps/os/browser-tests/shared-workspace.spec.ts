import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// A workspace shared with "Anyone with the link", signed out, at phone and
// desktop widths in light and dark:
// - `/s/<id>` lists the workspace's files and apps read-only, and says in
//   plain words what it leaves out;
// - a file opens in the reader, and on a phone Back returns to the list;
// - an app that runs for guests opens in the sandbox, and Back returns to
//   the workspace; the others say they need a sign-in.
const PUBLIC_ID = "PricePilotWorkspace001";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-shared-workspace");
await mkdir(evidence, { recursive: true });

const server = await startFixtureServer("/");
let browser: Browser | undefined;

async function fits(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: no horizontal page overflow`,
	);
}

try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}/${theme}`;
			const phone = width < 820;
			const context = await browser.newContext({
				viewport: { width, height: phone ? 812 : 800 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await page.route("**/*", (route) =>
				new URL(route.request().url()).origin === server.origin
					? route.continue()
					: route.abort("blockedbyclient"),
			);

			await page.goto(`${server.origin}/s/${PUBLIC_ID}`);
			const contents = page.locator("[data-shared-workspace]");
			await contents.waitFor();
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: the page follows the device theme`,
			);
			assert.match(
				(await page.locator("[data-shared-by]").textContent()) ?? "",
				/Shared by/,
				`${label}: the header names who shared it`,
			);
			assert.match(
				(await page.locator("[data-shared-left-out]").textContent()) ?? "",
				/1 file isn't shown because it holds data from connected accounts/,
				`${label}: the page says what it leaves out`,
			);
			const files = page.locator("[data-shared-file]");
			assert((await files.count()) > 0, `${label}: files are listed`);
			const runnable = page.getByRole("button", {
				name: "Open Opportunity cards",
			});
			await runnable.waitFor();
			const others = await page
				.locator("[data-shared-app]")
				.filter({ hasText: "Needs a Tedix sign-in to open" })
				.count();
			assert.equal(
				await page.locator("[data-shared-app] button").count(),
				1,
				`${label}: only the guest-ready app opens (${others} need sign-in)`,
			);
			await fits(page, `${label} list`);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-list.png` });

			// A file opens in the reader.
			const firstTitle = (await files.first().innerText()).split("\n")[0]!;
			await files.first().click();
			await page.locator("[data-shared-output]").waitFor();
			await page
				.locator("[data-shared-reader]")
				.getByRole("heading", { level: 2, name: firstTitle.trim() })
				.waitFor();
			assert.equal(
				await page
					.getByRole("navigation", { name: "In this workspace" })
					.isVisible(),
				!phone,
				`${label}: the list stays beside the reader on a wide screen only`,
			);
			await fits(page, `${label} reader`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-reader.png`,
			});
			if (phone) {
				await page.locator("[data-shared-back]").click();
				await runnable.waitFor();
			}

			// A guest-ready app opens in the sandbox, and Back returns here.
			await runnable.click();
			const name = page.getByRole("textbox", { name: "Your name" });
			await name.or(page.locator("[data-guest-app]")).first().waitFor();
			if (await name.count()) {
				await name.fill("Maya");
				await page
					.getByRole("button", { name: "Open app", exact: true })
					.click();
			}
			await page
				.locator("[data-guest-app]")
				.getByRole("heading", { name: "Opportunity cards" })
				.waitFor();
			await fits(page, `${label} app`);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-app.png` });
			await page.locator("[data-guest-back]").click();
			await contents.waitFor();
			await runnable.waitFor();
			await context.close();
		}
	}
	console.log(`shared workspace: ok (screenshots in ${evidence})`);
} finally {
	await browser?.close();
	await server.stop();
}
