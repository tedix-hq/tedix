/**
 * Send, reload, answer visible. A Home turn keeps running on the server
 * while the page is gone; after the reload the panel shows the question,
 * is thinking again, and fills in the answer. A turn that ended without an
 * answer says so and offers Retry.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const shots = process.env.QUICK_CHAT_RESUME_SHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const server = await startFixtureServer(
	"/browser-tests/quick-chat-resume.html",
);
let browser: Browser | undefined;

const url = (scenario: string, theme: string) =>
	`${server.origin}/browser-tests/quick-chat-resume.html?scenario=${scenario}&theme=${theme}&runMs=4000`;

async function openPanel(page: Page) {
	await page.locator(".tedix-launcher").click();
	await page.locator(".tedix-panel[data-open]").waitFor();
}

const thinking = (page: Page) =>
	page.locator(".tedix-message-assistant .tedix-thinking");

try {
	browser = await chromium.launch({ headless: true });
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				colorScheme: theme as "light" | "dark",
				reducedMotion: "reduce",
			});
			const label = `${width}px ${theme}`;
			const snap = (name: string) =>
				shots
					? page.screenshot({
							path: join(shots, `${name}-${width}-${theme}.png`),
						})
					: Promise.resolve();
			try {
				// Running: send, see it thinking, reload mid-turn.
				await page.goto(url("running", theme));
				await page.evaluate(() => localStorage.clear());
				await openPanel(page);
				await page.locator(".tedix-input").fill("Remind me to call Emile");
				await page.locator(".tedix-send").click();
				await thinking(page).waitFor();
				await page.reload();
				await openPanel(page);
				// The same thread, the question, and the turn thinking again.
				await page.getByText("Remind me to call Emile").waitFor();
				await thinking(page).waitFor();
				assert.equal(
					await page.locator(".tedix-send").getAttribute("data-state"),
					"stop",
					label,
				);
				await snap("resume-thinking");
				await page
					.getByText("Answered after reload: Remind me to call Emile")
					.waitFor({ timeout: 10_000 });
				assert.equal(await thinking(page).count(), 0, label);
				assert.equal(
					await page.locator(".tedix-send").getAttribute("data-state"),
					null,
				);
				assert.equal(await page.locator(".tedix-input").isDisabled(), false);
				await snap("resume-answered");
				// A later reload shows the settled thread, nothing follows.
				await page.reload();
				await openPanel(page);
				await page
					.getByText("Answered after reload: Remind me to call Emile")
					.waitFor();
				assert.equal(await thinking(page).count(), 0, label);

				// Failed: the turn ended without an answer; say so, offer Retry.
				await page.goto(url("failed", theme));
				await page.evaluate(() => {
					localStorage.clear();
					sessionStorage.clear();
				});
				await page.reload();
				await openPanel(page);
				await page.locator(".tedix-input").fill("Book a catch-up");
				await page.locator(".tedix-send").click();
				await thinking(page).waitFor();
				await page.reload();
				await openPanel(page);
				await page.getByText("Book a catch-up").waitFor();
				await page
					.getByText("I couldn't complete the request. Try again.")
					.waitFor();
				const retry = page.getByRole("button", { name: "Retry" });
				await retry.waitFor();
				await snap("resume-failed");
				await retry.click();
				await thinking(page).waitFor();
				await page
					.getByText("Answered after reload: Book a catch-up")
					.waitFor({ timeout: 10_000 });
				assert.equal(
					await page.getByRole("button", { name: "Retry" }).count(),
					0,
				);
				console.log(`PASS quick chat resume ${label}`);
			} finally {
				await page.close();
			}
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
