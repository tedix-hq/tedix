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
			page.setDefaultNavigationTimeout(120_000);
			await routeTheme(page, theme);
			await page.goto(`${server.origin}${appPath}`, {
				waitUntil: "domcontentloaded",
			});

			// The live app opens directly, beside its Edit and History tabs.
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
			// The open draft is counted on the Edit tab and announced in the app.
			const editTab = tabs.getByRole("button", { name: /^Edit/ });
			await editTab.waitFor();
			assert.equal(
				(await editTab.innerText()).replace(/\s+/g, " ").trim(),
				"Edit 1",
				`${label}: the Edit tab counts the open draft`,
			);
			const banner = page.locator("[data-canvas-drafts-banner]");
			assert.match(
				await banner.innerText(),
				/1 change is waiting for your review/,
				`${label}: the app view says a change is waiting`,
			);
			await noOverflow(page, `${label} app`);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-app.png` });

			// Edit: builders can edit the revision files into a draft.
			await editTab.click();
			const files = page.getByRole("complementary", { name: "Code files" });
			await files.getByRole("button", { name: "client.js" }).click();
			const viewer = page.locator("[data-canvas-app-code-file]");
			await viewer.getByRole("textbox", { name: "Edit client.js" }).waitFor();
			assert.match(
				await viewer
					.getByRole("textbox", { name: "Edit client.js" })
					.inputValue(),
				/Opportunity cards/,
				`${label}: client.js is shown`,
			);
			await noOverflow(page, `${label} code`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-code.png`,
			});

			// The draft sits above the code in Edit: what it changes, and its own
			// preview.
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

	// Accepting the draft makes it the live app and clears the Edit tab's count.
	{
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		page.setDefaultNavigationTimeout(120_000);
		await routeTheme(page, "light");
		await page.goto(`${server.origin}${appPath}`, {
			waitUntil: "domcontentloaded",
		});
		const tabs = appView(page);
		await tabs.getByRole("button", { name: /^Edit/ }).click();
		const draft = page.getByRole("group", { name: "Draft 1" });
		await draft.getByRole("button", { name: "Accept" }).click();
		await draft.waitFor({ state: "detached" });
		// The Edit tab drops its count once nothing waits there.
		await tabs.getByRole("button", { name: "Edit", exact: true }).waitFor();
		await guest(page, "Opportunity cards")
			.getByRole("heading", { name: /reviewed · Maya/ })
			.waitFor();
		await page.screenshot({ path: `${evidence}/1280-light-accepted.png` });
		await context.close();
	}
	// Code saves a proposal. Move mainline independently, then resolve the stale draft.
	{
		const context = await browser.newContext({
			viewport: { width: 1280, height: 900 },
		});
		const page = await context.newPage();
		page.setDefaultNavigationTimeout(120_000);
		await routeTheme(page, "light");
		const rpc = async (method: string, input: unknown) => {
			const response = await page.request.post(
				`${server.origin}/api/rpc/${method}`,
				{ data: { json: input } },
			);
			assert(response.ok(), `${method}: ${await response.text()}`);
			return (await response.json()).json;
		};
		await page.goto(`${server.origin}${appPath}`, {
			waitUntil: "domcontentloaded",
		});
		const tabs = appView(page);
		await tabs.getByRole("button", { name: /^Edit/ }).click();
		await page
			.getByRole("complementary", { name: "Code files" })
			.getByRole("button", { name: "client.js" })
			.click();
		const editor = page.getByRole("textbox", { name: "Edit client.js" });
		await editor.waitFor();
		const original = await editor.inputValue();
		await editor.fill(original + "\n// draft change\n");
		await page.getByRole("button", { name: "Save as draft" }).click();
		const draft = page.getByRole("group", { name: "Draft 1" });
		await draft.waitFor();
		const current = await rpc("osWorkspaces/gadgets/get", {
			workspaceId,
			gadgetId,
		});
		const code = await rpc("osWorkspaces/gadgets/getCode", {
			workspaceId,
			gadgetId,
		});
		assert.equal(
			code.code.files["client.js"],
			original,
			"Code save leaves mainline unchanged",
		);
		// An independent server-file change merges cleanly with the client's edit.
		await rpc("osWorkspaces/gadgets/revise", {
			workspaceId,
			gadgetId,
			manifest: current.currentRevision.manifest,
			files: {
				...code.code.files,
				"server.js": code.code.files["server.js"] + "\n// mainline change\n",
			},
			expectedRevision: current.currentRevision.revision,
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await appView(page).getByRole("button", { name: /^Edit/ }).click();
		await draft.getByRole("button", { name: "Update to latest" }).click();
		await draft
			.getByText("Changes combined cleanly.", { exact: false })
			.waitFor();
		await draft.getByRole("button", { name: "Save as draft" }).click();
		await draft
			.getByRole("button", { name: "Accept", exact: true })
			.waitFor({ state: "visible" });
		await draft.getByRole("button", { name: "Accept", exact: true }).click();
		await appView(page)
			.getByRole("button", { name: "Edit", exact: true })
			.waitFor();
		const combined = await rpc("osWorkspaces/gadgets/getCode", {
			workspaceId,
			gadgetId,
		});
		assert.match(combined.code.files["client.js"], /draft change/);
		assert.match(combined.code.files["server.js"], /mainline change/);
		// A second Code draft and a mainline edit to the same line show markers.
		await appView(page).getByRole("button", { name: /^Edit/ }).click();
		await page
			.getByRole("complementary", { name: "Code files" })
			.getByRole("button", { name: "client.js" })
			.click();
		await editor.fill(
			combined.code.files["client.js"].replace(
				"// draft change",
				"// draft conflict",
			),
		);
		await page.getByRole("button", { name: "Save as draft" }).click();
		await draft.waitFor();
		const latest = await rpc("osWorkspaces/gadgets/get", {
			workspaceId,
			gadgetId,
		});
		await rpc("osWorkspaces/gadgets/revise", {
			workspaceId,
			gadgetId,
			manifest: latest.currentRevision.manifest,
			files: {
				...combined.code.files,
				"client.js": combined.code.files["client.js"].replace(
					"// draft change",
					"// main conflict",
				),
			},
			expectedRevision: latest.currentRevision.revision,
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await appView(page).getByRole("button", { name: /^Edit/ }).click();
		await draft.getByRole("button", { name: "Update to latest" }).click();
		await draft.getByRole("button", { name: "client.js", exact: true }).click();
		const conflict = draft.getByRole("textbox", { name: "Edit client.js" });
		assert.match(await conflict.inputValue(), /<<<<<<< Draft/);
		await draft.getByRole("button", { name: "Save as draft" }).click();
		await draft
			.getByText("Resolve all conflict markers before saving.", { exact: true })
			.waitFor();
		await page.screenshot({
			path: `${evidence}/1280-light-conflicts.png`,
			fullPage: true,
		});
		await conflict.fill(
			combined.code.files["client.js"].replace(
				"// draft change",
				"// resolved conflict",
			),
		);
		await draft.getByRole("button", { name: "Save as draft" }).click();
		await draft.getByRole("button", { name: "Accept", exact: true }).click();
		await appView(page)
			.getByRole("button", { name: "Edit", exact: true })
			.waitFor();
		const resolved = await rpc("osWorkspaces/gadgets/getCode", {
			workspaceId,
			gadgetId,
		});
		assert.match(resolved.code.files["client.js"], /resolved conflict/);
		await context.close();
	}
	console.log(
		`Runtime app panel (App, Edit with drafts, accept) passed at 375px and 1280px in light and dark; screenshots in ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
