import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// The runtime app panel on the demo pack's Reddit workspace: the live app,
// its code, and a chat draft that previews in its own sandbox and is accepted
// as the next revision. Light and dark, phone and desktop.
const workspaceId = "00000030-0000-4000-8000-000000000001";
const gadgetId = "00000031-0000-4000-8000-00000000000e";
const appPath = `/workspace/${workspaceId}?workpiece=gadget%3A${gadgetId}&pane=workpiece`;
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-app-runtime-panel");
await mkdir(evidence, { recursive: true });

// Accepting the draft writes fixture state, so this spec owns its server.
const server = await startFixtureServer("/", { shared: false });
let browser: Browser | undefined;

async function routeTheme(page: Page, theme: "light" | "dark") {
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== server.origin) return route.abort("blockedbyclient");
		if (url.pathname.endsWith("/userSettings/getPreferences")) {
			const response = await route.fetch();
			const body = await response.json();
			body.json.preferences.theme = theme;
			return route.fulfill({ response, json: body });
		}
		return route.continue();
	});
}

async function noOverflow(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: no horizontal page overflow`,
	);
}

function appView(page: Page) {
	return page.getByRole("group", { name: "Active workpiece view" });
}

function guest(page: Page, title: string) {
	return page.frameLocator(`iframe[title="${title}"]`).frameLocator("iframe");
}

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
			await routeTheme(page, theme);
			await page.goto(`${server.origin}${appPath}`);

			// The live app opens directly, beside its Code and Drafts tabs.
			const tabs = appView(page);
			await tabs.waitFor();
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);
			await guest(page, "Opportunity cards")
				.getByRole("heading", { name: /opportunities for Maya/ })
				.waitFor();
			const draftsTab = tabs.getByRole("button", { name: /^Drafts/ });
			await draftsTab.waitFor();
			assert.equal(
				(await draftsTab.innerText()).replace(/\s+/g, " ").trim(),
				"Drafts 1",
				`${label}: the Drafts tab counts the open draft`,
			);
			await noOverflow(page, `${label} app`);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-app.png` });

			// Code: the revision's files, read-only.
			await tabs.getByRole("button", { name: "Code" }).click();
			const files = page.getByRole("complementary", { name: "Code files" });
			await files.getByRole("button", { name: "client.js" }).click();
			const viewer = page.locator("[data-canvas-app-code-file]");
			await viewer.getByText("Viewing").waitFor();
			assert.match(
				await viewer.locator("pre").innerText(),
				/Opportunity cards/,
				`${label}: client.js is shown`,
			);
			await noOverflow(page, `${label} code`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-code.png`,
			});

			// Drafts: what the draft changes, and its own preview.
			await draftsTab.click();
			const draft = page.getByRole("group", { name: "Draft 1" });
			await draft.waitFor();
			await draft.locator('[data-app-draft-file="client.js"]').waitFor();
			assert.equal(
				await draft.locator('[data-app-draft-file="server.js"]').count(),
				0,
				`${label}: unchanged files are left out`,
			);
			await draft.getByRole("button", { name: "Preview" }).click();
			await guest(page, "Opportunity cards · Draft 1")
				.getByRole("heading", { name: /reviewed · Maya/ })
				.waitFor();
			await noOverflow(page, `${label} drafts`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-drafts.png`,
				fullPage: true,
			});
			await context.close();
		}
	}

	// Accepting the draft makes it the live app and closes the Drafts tab.
	{
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		await routeTheme(page, "light");
		await page.goto(`${server.origin}${appPath}`);
		const tabs = appView(page);
		await tabs.getByRole("button", { name: /^Drafts/ }).click();
		const draft = page.getByRole("group", { name: "Draft 1" });
		await draft.getByRole("button", { name: "Accept" }).click();
		await tabs.getByRole("button", { name: /^Drafts/ }).waitFor({
			state: "detached",
		});
		await guest(page, "Opportunity cards")
			.getByRole("heading", { name: /reviewed · Maya/ })
			.waitFor();
		await page.screenshot({ path: `${evidence}/1280-light-accepted.png` });
		await context.close();
	}
	console.log(
		`Runtime app panel (App, Code, Drafts, accept) passed at 375px and 1280px in light and dark; screenshots in ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
