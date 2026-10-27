import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Translate in the host's header row, signed in and as a share-link guest:
// the demo pack's English Opportunity cards app, opened by a German-speaking
// viewer, switches to German and back. Headless browsers have no on-device
// translator or language detector, so every frame gets a fake one.
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
	if (path.startsWith("/guest")) {
		await page
			.getByRole("textbox", {
				name: locale.startsWith("de") ? "Ihr Name" : "Your name",
			})
			.fill("Maya");
		await page
			.getByRole("button", {
				name: locale.startsWith("de") ? "App öffnen" : "Open app",
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
	for (const width of [375, 1280]) {
		{
			const { context, page } = await open("de-DE", width, appPath);
			await roundTrip(page, `${width}-signed-in`);
			await context.close();
		}
		{
			const { context, page } = await open(
				"de-DE",
				width,
				`/guest#token=${token}`,
			);
			await roundTrip(page, `${width}-guest`);
			const bar = await page.locator("[data-guest-app] header").boundingBox();
			// One row: at most a 44px touch target tall.
			assert(
				bar && bar.height <= 44,
				`${width}: the guest bar stays one line (${bar?.height}px)`,
			);
			await context.close();
		}
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
	console.log(
		`App Translate passed signed in and as a guest at 375px and 1280px; screenshots in ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
