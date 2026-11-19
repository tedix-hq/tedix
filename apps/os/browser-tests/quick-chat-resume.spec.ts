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
	`${server.origin}/browser-tests/quick-chat-resume.html?scenario=${scenario}&theme=${theme}&controlled`;

async function openPanel(page: Page) {
	await page.locator(".tedix-launcher").click();
	await page.locator(".tedix-panel[data-open]").waitFor();
}

const thinking = (page: Page) =>
	page.locator(".tedix-message-assistant .tedix-thinking");

try {
	browser = await chromium.launch({ headless: true });
	for (const { width, theme, scenario, question } of [
		{
			width: 375,
			theme: "dark",
			scenario: "running",
			question: "Remind me to call Emile",
		},
		{
			width: 1280,
			theme: "light",
			scenario: "failed",
			question: "Book a catch-up",
		},
	] as const) {
		const page = await browser.newPage({
			viewport: { width, height: 844 },
			colorScheme: theme,
			reducedMotion: "reduce",
		});
		const label = `${width}px ${theme}`;
		const snap = (name: string) =>
			shots
				? page.screenshot({
						path: join(shots, `${name}-${width}-${theme}.png`),
					})
				: Promise.resolve();
		const completion = Promise.withResolvers<void>();
		await page.route("**/browser-tests/quick-chat-complete", async (route) => {
			await completion.promise;
			await route.fulfill({ status: 204 });
		});
		try {
			await page.goto(url(scenario, theme));
			await openPanel(page);
			await page.locator(".tedix-input").fill(question);
			await page.locator(".tedix-send").click();
			await thinking(page).waitFor();
			await page.reload();
			await openPanel(page);
			await page.getByText(question).waitFor();

			const answer = page.getByText(`Answered after reload: ${question}`);
			if (scenario === "running") {
				await thinking(page).waitFor();
				assert.equal(
					await page.locator(".tedix-send").getAttribute("data-state"),
					"stop",
					label,
				);
				await snap("resume-thinking");
				completion.resolve();
				await answer.waitFor({ timeout: 10_000 });
				assert.equal(await thinking(page).count(), 0, label);
				assert.equal(
					await page.locator(".tedix-send").getAttribute("data-state"),
					null,
				);
				assert.equal(await page.locator(".tedix-input").isDisabled(), false);
				await snap("resume-answered");
				// A later reload shows the settled thread without resuming it.
				await page.reload();
				await openPanel(page);
				await answer.waitFor();
				assert.equal(await thinking(page).count(), 0, label);
			} else {
				await page
					.getByText("I couldn't complete the request. Try again.")
					.waitFor();
				const retry = page.getByRole("button", { name: "Retry" });
				await retry.waitFor();
				await snap("resume-failed");
				await retry.click();
				await thinking(page).waitFor();
				completion.resolve();
				await answer.waitFor({ timeout: 10_000 });
				assert.equal(await retry.count(), 0);
			}
			console.log(`PASS quick chat resume ${scenario} ${label}`);
		} finally {
			completion.resolve();
			await page.close();
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
