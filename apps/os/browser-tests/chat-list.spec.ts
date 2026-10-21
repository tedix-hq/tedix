import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import {
	chromium,
	webkit,
	type Browser,
	type Locator,
	type BrowserType,
	type Page,
} from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
);
const evidenceDir = process.env.CHAT_LIST_EVIDENCE_DIR;

type Case = {
	engine: string;
	type: BrowserType;
	width: number;
	height: number;
	theme: "light" | "dark";
};

// Chromium keeps its original desktop and phone cases; WebKit covers the two
// phone sizes. Every case gets a fresh isolated context.
const cases: Case[] = [];
for (const theme of ["light", "dark"] as const) {
	cases.push({
		engine: "chromium",
		type: chromium,
		width: 1280,
		height: 900,
		theme,
	});
	cases.push({
		engine: "chromium",
		type: chromium,
		width: 390,
		height: 900,
		theme,
	});
	cases.push({
		engine: "webkit",
		type: webkit,
		width: 375,
		height: 667,
		theme,
	});
	cases.push({
		engine: "webkit",
		type: webkit,
		width: 390,
		height: 844,
		theme,
	});
}

// Playwright's WebKit follows Safari's default of skipping plain buttons in
// sequential navigation, so Shift+Tab cannot reach the row button there. On
// WebKit, move focus to it directly after the keyboard-driven Escape; the
// forward Tab step from it to the actions button is still asserted.
async function focusPrevious(page: Page, target: Locator) {
	if (page.context().browser()?.browserType().name() === "webkit")
		await target.focus();
	else await page.keyboard.press("Shift+Tab");
}

async function runCase(browser: Browser, c: Case) {
	const { width, height, theme } = c;
	const phone = width <= 390;
	const label = `${c.engine}-${width}x${height}-${theme}`;
	const diagnostics: string[] = [];
	const context = await browser.newContext({
		viewport: { width, height },
		colorScheme: theme,
		hasTouch: phone,
	});
	try {
		const page: Page = await context.newPage();
		page.on("pageerror", (e) => diagnostics.push(`pageerror: ${e.message}`));
		page.on("console", (m) => {
			if (m.type() === "error") diagnostics.push(`console: ${m.text()}`);
		});
		page.on("requestfailed", (r) =>
			diagnostics.push(`requestfailed: ${r.method()} ${r.url()}`),
		);
		page.on("request", (r) => {
			// The app reads over POST RPC; flag only calls that change a chat.
			if (
				r.method() === "POST" &&
				/\/(send|rename|delete|remove|pin|unpin|archive|create|update)[A-Za-z]*$/i.test(
					new URL(r.url()).pathname,
				)
			)
				diagnostics.push(`mutation: ${r.method()} ${r.url()}`);
		});
		await page.addInitScript(
			(mode) => localStorage.setItem("tedix-os-theme", mode),
			theme,
		);
		await page.goto(`${origin}/chat`);
		if (phone)
			await page.getByRole("button", { name: "Back to conversations" }).click();
		const row = page.locator("[data-conversation-id]").first();
		await row.waitFor();
		const open = row.getByRole("button").first();
		const actions = row.getByRole("button", {
			name: /^Conversation actions for /,
		});
		const title = (await open.locator("span.truncate").textContent())!;
		assert.equal(
			await actions.getAttribute("aria-label"),
			`Conversation actions for ${title}`,
		);
		const rowBox = (await row.boundingBox())!;
		const openBox = (await open.boundingBox())!;
		assert.equal(
			openBox.width,
			rowBox.width,
			"conversation target spans the entire row",
		);
		assert.equal(openBox.x, rowBox.x);
		assert(rowBox.height >= 44);
		assert.equal(
			await row.evaluate((el) => getComputedStyle(el).borderRadius),
			"8px",
		);
		if (phone) {
			assert.equal(
				await actions.evaluate((el) => getComputedStyle(el).opacity),
				"1",
				"touch actions are always visible",
			);
			assert((await actions.boundingBox())!.width >= 44);
		}
		await open.hover();
		await page.waitForTimeout(250);
		assert.equal(
			await open.evaluate((el) => getComputedStyle(el).backgroundColor),
			"rgba(0, 0, 0, 0)",
			"main button has no separate hover fill",
		);
		assert.equal(
			await actions.evaluate((el) => getComputedStyle(el).backgroundColor),
			"rgba(0, 0, 0, 0)",
			"menu inherits no rectangular row fill",
		);
		await page.getByRole("tooltip").filter({ hasText: title }).waitFor();
		if (evidenceDir)
			await page.screenshot({
				path: `${evidenceDir}/chat-list-after-${label}.png`,
			});
		const initialUrl = page.url();
		await actions.click();
		await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
		assert.equal(
			page.url(),
			initialUrl,
			"opening the menu does not select a conversation",
		);
		await page.keyboard.press("Escape");
		await page.waitForFunction(
			(label) => document.activeElement?.getAttribute("aria-label") === label,
			await actions.getAttribute("aria-label"),
		);
		await focusPrevious(page, open);
		assert(
			await open.evaluate((el) => el === document.activeElement),
			"row precedes its menu in tab order",
		);
		assert(
			await open.evaluate((el) => el.matches(":focus-visible")),
			"keyboard navigation shows focus",
		);
		await page.keyboard.press("Tab");
		assert(
			await actions.evaluate((el) => el === document.activeElement),
			"Tab reaches overflow",
		);
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Rename", exact: true }).waitFor();
		await page.keyboard.press("Escape");
		await page.waitForFunction(
			(label) => document.activeElement?.getAttribute("aria-label") === label,
			await actions.getAttribute("aria-label"),
		);
		await focusPrevious(page, open);
		await page.keyboard.press("Enter");
		await page.waitForURL(/conversation=/);
		if (phone)
			await page.getByRole("button", { name: "Back to conversations" }).click();
		// The mobile back button starts a fresh selection; check selected styling on desktop.
		if (!phone) {
			await page.mouse.click(1, 1);
			await open.click();
			await page.mouse.move(1, 1);
			assert.equal(await row.getAttribute("data-active"), "true");
			assert.equal(
				await actions.evaluate((el) => getComputedStyle(el).opacity),
				"1",
				"selected actions stay visible",
			);
			assert.equal(
				await open.evaluate((el) => el.matches(":focus-visible")),
				false,
				"mouse selection has no keyboard focus ring",
			);
			assert.equal(
				await row.evaluate((el) => getComputedStyle(el).boxShadow),
				"none",
				"selection has no blue row border",
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/chat-list-after-selected-${label}.png`,
				});
		}
		// Repeat the menu and navigation cycle: the menu never selects, Escape
		// returns focus to the trigger, and the canonical row opens one conversation.
		for (let cycle = 0; cycle < 3; cycle++) {
			const before = page.url();
			await actions.click();
			await page
				.getByRole("menuitem", { name: "Rename", exact: true })
				.waitFor();
			assert.equal(
				page.url(),
				before,
				`${label} cycle ${cycle}: menu open does not navigate`,
			);
			await page.keyboard.press("Escape");
			await page.waitForFunction(
				(text) => document.activeElement?.getAttribute("aria-label") === text,
				await actions.getAttribute("aria-label"),
			);
			await open.click();
			await page.waitForURL(/conversation=/);
			if (phone) {
				await page
					.getByRole("button", { name: "Back to conversations" })
					.click();
				await row.waitFor();
			}
		}
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			"no horizontal page overflow",
		);
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - innerWidth,
		);
		const actual = await page.evaluate(() => ({
			width: innerWidth,
			height: innerHeight,
			scheme: document.documentElement.classList.contains("dark")
				? "dark"
				: getComputedStyle(document.body).colorScheme,
		}));
		assert.equal(actual.width, width, `${label} viewport width`);
		assert.equal(actual.height, height, `${label} viewport height`);
		const rowBox2 = (await row.boundingBox())!;
		const actionBox = (await actions.boundingBox())!;
		return {
			label,
			viewport: actual,
			row: { width: rowBox2.width, height: rowBox2.height },
			action: { width: actionBox.width, height: actionBox.height },
			overflow,
			diagnostics: diagnostics.slice(),
		};
	} finally {
		await context.close();
	}
}

const results: unknown[] = [];
let browsers = new Map<string, Browser>();
try {
	await waitForFixtureServer(`${origin}/chat`, { server });
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	for (const c of cases) {
		let browser = browsers.get(c.engine);
		if (!browser) {
			browser = await c.type.launch();
			browsers.set(c.engine, browser);
		}
		const label = `${c.engine} ${c.width}x${c.height} ${c.theme}`;
		let result;
		try {
			result = await runCase(browser, c);
		} catch (error) {
			throw new Error(`Chat list failed: ${label}`, { cause: error });
		}
		const bad = result.diagnostics.filter((d) => !d.startsWith("console:"));
		assert.deepEqual(bad, [], `${label} page/request diagnostics`);
		assert(result.overflow <= 0, `${label} no horizontal overflow`);
		results.push(result);
		console.log(`Chat list passed: ${label}`);
	}
	if (evidenceDir)
		await writeFile(
			`${evidenceDir}/chat-list-measurements.json`,
			JSON.stringify(results, null, 2),
		);
} finally {
	for (const browser of browsers.values()) await browser.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
