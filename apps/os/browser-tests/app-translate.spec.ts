import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Translate the demo app in the workspace and through a guest share link.
// The guest also records a verdict that survives a reload.
const workspaceId = "00000030-0000-4000-8000-000000000001";
const gadgetId = "00000031-0000-4000-8000-00000000000e";
const appPath = `/workspace/${workspaceId}?workpiece=gadget%3A${gadgetId}&pane=workpiece`;
const token = "guest-link-token-0123456789abcdefghij";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-app-translate");
await mkdir(evidence, { recursive: true });

const server = await startFixtureServer("/");
let browser: Browser | undefined;

async function open(locale: string, width: number, path: string) {
	const context = await browser!.newContext({
		viewport: { width, height: width < 820 ? 812 : 800 },
		colorScheme: width < 820 ? "dark" : "light",
		locale,
		reducedMotion: "reduce",
	});
	await context.addInitScript(() => {
		Object.assign(self, {
			// Like Chrome, a frame the click did not land in may not open one.
			Translator: {
				create: async () => {
					if (window !== window.top)
						throw new DOMException("No click here", "NotAllowedError");
					return { translate: async (text: string) => `[de] ${text}` };
				},
			},
			LanguageDetector: {
				create: async () => ({
					detect: async () => [{ detectedLanguage: "en", confidence: 0.9 }],
				}),
			},
		});
	});
	const page = await context.newPage();
	page.setDefaultNavigationTimeout(120_000);
	await page.route("**/*", (route) =>
		new URL(route.request().url()).origin === server.origin
			? route.continue()
			: route.abort("blockedbyclient"),
	);
	await page.goto(`${server.origin}${path}`, { waitUntil: "domcontentloaded" });
	if (path.startsWith("/guest#")) {
		const german = locale.startsWith("de");
		const name = page.getByRole("textbox", {
			name: german ? "Ihr Name" : "Your name",
		});
		await name.fill("Maya");
		if (german) {
			assert(
				await name.evaluate(
					(input) => input.getBoundingClientRect().height >= 44,
				),
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				"The phone name form fits the screen",
			);
		}
		await page
			.getByRole("button", {
				name: german ? "App öffnen" : "Open app",
				exact: true,
			})
			.click();
	}
	return { context, page };
}

const app = (page: Page) =>
	page.frameLocator('iframe[title="Opportunity cards"]').frameLocator("iframe");

async function roundTrip(page: Page, label: string) {
	const heading = app(page).getByRole("heading", {
		name: /opportunities for Maya/,
	});
	await heading.waitFor();
	const translate = page.getByRole("button", { name: "Deutsch" });
	await translate.click();
	await app(page)
		.getByRole("heading", { name: /^\[de\] \d+ opportunities for Maya/ })
		.waitFor();
	await app(page).getByRole("button", { name: "[de] Useful" }).waitFor();
	const original = page.getByRole("button", { name: "English" });
	assert.equal(await original.getAttribute("aria-pressed"), "true", label);
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: no horizontal page overflow`,
	);
	await page.screenshot({ path: `${evidence}/${label}.png` });
	await original.click();
	await app(page)
		.getByRole("heading", { name: /^\d+ opportunities for Maya/ })
		.waitFor();
	await page.getByRole("button", { name: "Deutsch" }).waitFor();
}

try {
	browser = await chromium.launch({ headless: true });
	{
		const width = 1280;
		const { context, page } = await open("de-DE", width, appPath);
		await roundTrip(page, `${width}-signed-in`);
		await context.close();
	}
	{
		const width = 375;
		const { context, page } = await open(
			"de-DE",
			width,
			`/guest#token=${token}`,
		);
		const main = page.locator("[data-guest-app]");
		await main.getByText("Kann nutzen", { exact: true }).waitFor();
		assert.equal(await page.locator("html").getAttribute("lang"), "de-DE");
		assert.equal(await page.locator("html").getAttribute("data-mode"), "dark");
		assert.equal(
			new URL(page.url()).hash,
			"",
			"The link secret leaves the URL",
		);
		await main.getByRole("heading", { name: "Opportunity cards" }).waitFor();

		await roundTrip(page, `${width}-guest`);
		const layout = await main.evaluate((node) => {
			const bar = node.querySelector("[data-guest-bar]")!;
			const frame = node
				.querySelector('iframe[title="Opportunity cards"]')!
				.getBoundingClientRect();
			return {
				frameLeft: frame.left,
				frameWidth: frame.width,
				frameBottom: frame.bottom,
				gap: frame.top - bar.getBoundingClientRect().bottom,
				headerHeight: bar.querySelector("header")!.getBoundingClientRect()
					.height,
				width: innerWidth,
				height: innerHeight,
			};
		});
		assert(
			layout.frameLeft === 0 &&
				layout.frameWidth === layout.width &&
				Math.abs(layout.frameBottom - layout.height) <= 1 &&
				Math.abs(layout.gap) <= 1 &&
				layout.headerHeight <= 44,
			`The app fills the screen under its one-row guest bar: ${JSON.stringify(layout)}`,
		);

		const saved = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname === "/api/os-shared/app/call" &&
				(response.request().postData() ?? "").includes('"recordVerdict"'),
		);
		await app(page)
			.getByRole("button", { name: "Useful", exact: true })
			.click();
		await app(page)
			.getByText(/2 of 8/)
			.waitFor();
		assert.equal((await saved).status(), 200, "The verdict reaches the server");
		await page.reload();
		await app(page).getByText("Verdict: yes").waitFor();

		await page.setViewportSize({ width: 1280, height: 800 });
		await main.getByText(/^Geteilt von /).waitFor();
		await context.close();
	}

	// A viewer who already reads the app's language sees no Translate.
	{
		const { context, page } = await open("en-US", 375, `/guest#token=${token}`);
		await app(page)
			.getByRole("heading", { name: /opportunities for Maya/ })
			.waitFor();
		await page.waitForTimeout(500);
		assert.equal(await page.locator("[data-app-translate]").count(), 0);
		await context.close();
	}
	{
		const { context, page } = await open("en-US", 375, "/guest");
		await page.getByText("This link no longer opens anything").waitFor();
		assert.equal(await page.locator("iframe").count(), 0);
		await context.close();
	}
	console.log(
		`App translation, guest redemption and verdict resume passed; screenshots in ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
