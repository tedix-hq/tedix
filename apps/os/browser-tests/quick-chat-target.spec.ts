import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const TARGET_KEY = "tedix:target-choice:v1:demo-target:person-1";
const shots = process.env.QUICK_CHAT_TARGET_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const server = await startFixtureServer(
	"/browser-tests/quick-chat-target.html",
);
let browser: Browser | undefined;

async function openChat(page: Page, scenario: string, theme: string) {
	await page.goto(
		`${server.origin}/browser-tests/quick-chat-target.html?scenario=${scenario}&theme=${theme}`,
	);
	await page.locator(".tedix-launcher").click();
	await page.locator(".tedix-panel[data-open]").waitFor();
	await page.waitForFunction(
		() =>
			document
				.querySelector("[data-tedix-widget]")
				?.shadowRoot?.querySelector(".tedix-status")
				?.getAttribute("data-state") !== "connecting",
	);
}

const status = (page: Page) =>
	page.locator(".tedix-status").getAttribute("data-state");
const picker = (page: Page) =>
	page.getByRole("button", { name: /^Choose tedi:/ });
const pickerValue = (page: Page) =>
	page.locator(".tedix-tedi-menu").getAttribute("data-value");
async function choose(page: Page, name: string) {
	await picker(page).click();
	await page
		.getByRole("menu", { name: "Choose tedi" })
		.getByRole("menuitemradio", { name })
		.click();
}

try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				colorScheme: theme as "light" | "dark",
				reducedMotion: "reduce",
			});
			// Each scenario starts a fresh conversation; only the remembered
			// choice (localStorage) carries across reloads.
			await page.addInitScript(() => sessionStorage.clear());
			const label = `${width}px ${theme}`;
			const snap = (name: string) =>
				shots
					? page.screenshot({
							path: join(shots, `${name}-${width}-${theme}.png`),
						})
					: Promise.resolve();
			try {
				// Home, no tedi allowed: Home opens, no picker, never Offline.
				await openChat(page, "home-no-tedi", theme);
				assert.notEqual(await status(page), "error", label);
				assert.equal(
					await page.locator(".tedix-status").textContent(),
					"Can see this page",
				);
				assert.equal(await picker(page).isVisible(), false, label);
				// The header is compact: no generic subtitle under the title.
				assert.equal(await page.locator(".tedix-subtitle").count(), 0);
				// The page reaches the chat through one chip the person controls.
				const chip = page.locator(".tedix-page-chip");
				assert.equal(
					(await chip.textContent())?.trim(),
					"This page: Quick chat opening target",
				);
				assert.match(
					(await chip.getAttribute("title")) ?? "",
					/^Tedi can see this page/,
				);
				const chipBox = await chip.boundingBox();
				assert(chipBox && chipBox.x >= 0 && chipBox.x + chipBox.width <= width);
				await page
					.getByRole("button", { name: "Stop sharing this page" })
					.click();
				assert.equal(await chip.isVisible(), false, label);
				await snap("page-removed");
				await page.locator(".tedix-page-add").click();
				assert.equal(await chip.isVisible(), true, label);
				assert.equal(
					await page.locator(".tedix-session-recovery").isVisible(),
					false,
				);
				assert.equal(await page.getByText("Offline").count(), 0);
				await page.locator(".tedix-input").fill("Hello");
				await page.locator(".tedix-send").click();
				await page.getByText("Home answer").waitFor();
				await snap("home-no-tedi");

				// Home plus two allowed tedis: the picker lists all three.
				await openChat(page, "home-two", theme);
				assert.equal(await pickerValue(page), "home");
				const box = await picker(page).boundingBox();
				assert(box && box.x >= 0 && box.x + box.width <= width, label);
				if (width === 375) assert(box.height >= 44, JSON.stringify(box));
				await picker(page).click();
				const menu = page.getByRole("menu", { name: "Choose tedi" });
				assert.deepEqual(
					await menu.locator(".tedix-menu-label").allTextContents(),
					["Home", "Support", "Sales"],
				);
				const list = await menu.boundingBox();
				assert(list && list.x >= 0 && list.x + list.width <= width, label);
				await snap("home-two");
				await page.keyboard.press("Escape");
				// The choice is remembered for this person across reloads.
				await choose(page, "Sales");
				assert.equal(
					await page.evaluate((key) => localStorage.getItem(key), TARGET_KEY),
					"tedi-b",
				);
				await openChat(page, "home-two", theme);
				assert.equal(await pickerValue(page), "tedi-b", label);

				// A remembered tedi that is gone falls back to Home silently.
				await page.evaluate(
					(key) => localStorage.setItem(key, "tedi-gone"),
					TARGET_KEY,
				);
				await openChat(page, "home-two", theme);
				assert.equal(await pickerValue(page), "home", label);
				assert.equal(
					await page.locator(".tedix-session-recovery").isVisible(),
					false,
				);
				assert.notEqual(await status(page), "error");

				// No Home and no tedi: a plain empty state that says who to ask.
				await page.evaluate(() => localStorage.clear());
				await openChat(page, "no-home-no-tedi", theme);
				assert.equal(await status(page), "unavailable", label);
				await page
					.getByText("Ask an admin of Acme to give you access to a tedi.")
					.waitFor();
				assert.equal(await page.getByText("Offline").count(), 0);
				assert.equal(await page.locator(".tedix-input").isDisabled(), true);
				await snap("no-tedi");
				console.log(`PASS quick chat target ${label}`);
			} finally {
				await page.close();
			}
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
