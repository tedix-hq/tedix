import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// A share-link guest opens the sample company's Opportunity cards app on
// /guest without an account: the link in the fragment is exchanged once, the
// app renders in its sandbox, a verdict reaches the server, and the tab
// resumes on reload. Light and dark, phone and desktop.
const token = "guest-link-token-0123456789abcdefghij";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-guest-app");
await mkdir(evidence, { recursive: true });

const server = await startFixtureServer("/");
let browser: Browser | undefined;

try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}/${theme}`;
			const context = await browser.newContext({
				viewport: { width, height: width < 820 ? 812 : 800 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await page.route("**/*", (route) =>
				new URL(route.request().url()).origin === server.origin
					? route.continue()
					: route.abort("blockedbyclient"),
			);
			await page.goto(`${server.origin}/guest#token=${token}`);
			const nameInput = page.getByRole("textbox", { name: "Your name" });
			await nameInput.fill("Maya");
			assert(
				await nameInput.evaluate(
					(input) => input.getBoundingClientRect().height >= 44,
				),
				`${label}: guest name has a phone touch target`,
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				`${label}: name form does not overflow`,
			);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-name.png` });
			await page.getByRole("button", { name: "Open app", exact: true }).click();
			const main = page.locator("[data-guest-app]");
			await main.waitFor();
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: the guest page follows the device theme`,
			);
			assert.equal(
				new URL(page.url()).hash,
				"",
				`${label}: the link secret leaves the address bar`,
			);
			await main.getByRole("heading", { name: "Opportunity cards" }).waitFor();
			await main.getByText("Can use", { exact: true }).waitFor();
			const bar = await main.locator("header").boundingBox();
			assert(
				bar && bar.height <= 40,
				`${label}: the guest bar stays one line (${bar?.height}px)`,
			);
			assert.equal(
				await main.getByText(/Tedix/).count(),
				0,
				`${label}: no Tedix branding in the guest bar`,
			);
			const guest = page
				.frameLocator('iframe[title="Opportunity cards"]')
				.frameLocator("iframe");
			await guest
				.getByRole("heading", { name: /opportunities for Maya/ })
				.waitFor();
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				`${label}: no horizontal page overflow`,
			);
			// Like a shared artifact: the thin bar is the only chrome and the app
			// frame fills everything below it, edge to edge.
			const layout = await page.evaluate(() => {
				const box = (selector: string) =>
					document.querySelector(selector)!.getBoundingClientRect();
				const bar = box("[data-guest-bar]");
				const frame = box('iframe[title="Opportunity cards"]');
				return {
					bar: { left: bar.left, width: bar.width, bottom: bar.bottom },
					frame: {
						left: frame.left,
						top: frame.top,
						width: frame.width,
						bottom: frame.bottom,
					},
					border: getComputedStyle(document.querySelector("[data-guest-bar]")!)
						.borderBottomWidth,
					viewport: { width: innerWidth, height: innerHeight },
				};
			});
			assert.deepEqual(
				{ left: layout.frame.left, width: layout.frame.width },
				{ left: 0, width: layout.viewport.width },
				`${label}: the app frame is as wide as the viewport (${JSON.stringify(layout)})`,
			);
			assert(
				Math.abs(layout.frame.top - layout.bar.bottom) <= 1 &&
					Math.abs(layout.frame.bottom - layout.viewport.height) <= 1,
				`${label}: the app frame fills from the bar to the bottom (${JSON.stringify(layout)})`,
			);
			assert(
				layout.bar.left === 0 &&
					layout.bar.width === layout.viewport.width &&
					layout.bar.bottom <= 45 &&
					layout.border !== "0px",
				`${label}: one thin full-width bar with a hairline (${JSON.stringify(layout)})`,
			);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-app.png` });

			// A verdict goes to the server through the guest call route and is
			// shown again on the card after a resume.
			await guest.getByRole("button", { name: "Useful", exact: true }).click();
			await guest.getByText(/2 of 8/).waitFor();
			await page.reload();
			await page
				.frameLocator('iframe[title="Opportunity cards"]')
				.frameLocator("iframe")
				.getByRole("heading", { name: /opportunities for Maya/ })
				.waitFor();
			await page
				.frameLocator('iframe[title="Opportunity cards"]')
				.frameLocator("iframe")
				.getByText("Verdict: yes")
				.waitFor();
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-resumed.png`,
			});
			await context.close();
		}
	}

	// A German-speaking guest of an organization with no published language
	// gets the bar in German from the copy catalog.
	{
		const context = await browser.newContext({
			viewport: { width: 375, height: 812 },
			locale: "de-DE",
		});
		const page = await context.newPage();
		await page.goto(`${server.origin}/guest#token=${token}`);
		await page.getByRole("textbox", { name: "Ihr Name" }).fill("Maya");
		await page.getByRole("button", { name: "App öffnen", exact: true }).click();
		const main = page.locator("[data-guest-app]");
		await main.getByText("Kann nutzen", { exact: true }).waitFor();
		assert.equal(await page.locator("html").getAttribute("lang"), "de-DE");
		await page.screenshot({ path: `${evidence}/375-de.png` });
		await context.close();
	}

	// Without a link or a resumable session the page says so and shows nothing.
	{
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await context.newPage();
		await page.goto(`${server.origin}/guest`);
		await page.getByText("This link no longer opens anything").waitFor();
		assert.equal(await page.locator("iframe").count(), 0, "no app frame");
		await context.close();
	}
	console.log(
		`Guest app page passed at 375px and 1280px in light and dark; screenshots in ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
