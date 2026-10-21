import { openExamples } from "./deck-controls";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = createServer();
await new Promise<void>((resolve, reject) => {
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", resolve);
});
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve, reject) => {
	probe.close((error) => (error ? reject(error) : resolve()));
});
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		port,
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
);
let browser: Browser | undefined;
try {
	await waitForFixtureServer(`${origin}/browser-tests/deck.html`, { server });
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 1280, height: 800 },
		{ width: 390, height: 844 },
	]) {
		const page = await browser.newPage({ viewport });
		try {
			await page.goto(`${origin}/browser-tests/deck.html`);
			await openExamples(page);
			const card = page.getByRole("region", {
				name: "Send Morgan the revised delivery date?",
			});
			await card.waitFor();
			assert.equal(
				await page
					.locator('[data-workspace-app-entry="decision-deck"] .fd-decision')
					.count(),
				1,
				"one card at a time",
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"phone and desktop have no horizontal overflow",
			);
			await card.focus();
			await page.keyboard.press("ArrowRight");
			await page.getByRole("alertdialog").waitFor();
			await page.getByRole("button", { name: "Go back", exact: true }).click();
			await card.focus();
			await page.keyboard.press("?");
			await page
				.getByRole("heading", { name: "Keyboard shortcuts", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			if (viewport.width < 640) {
				// Phones keep Why this in the action row's "⋯" menu.
				await card.getByRole("button", { name: "More actions" }).click();
				await page.getByRole("menuitem", { name: "Why this" }).click();
			} else
				await page
					.getByRole("button", { name: "Why this", exact: true })
					.click();
			await page
				.getByText("Prefer a bounded next step with evidence", { exact: false })
				.waitFor();
			await page.keyboard.press("Escape");
			await card.evaluate((element) => {
				element.dispatchEvent(
					new TouchEvent("touchstart", {
						bubbles: true,
						touches: [
							new Touch({
								identifier: 1,
								target: element,
								clientX: 300,
								clientY: 200,
							}),
						],
					}),
				);
				element.dispatchEvent(
					new TouchEvent("touchend", {
						bubbles: true,
						changedTouches: [
							new Touch({
								identifier: 1,
								target: element,
								clientX: 90,
								clientY: 205,
							}),
						],
					}),
				);
			});
			await page
				.getByRole("button", { name: "wrong tone", exact: true })
				.click();
			await page
				.getByRole("region", {
					name: "File this request under Supplier review?",
				})
				.waitFor();
			await page
				.getByRole("region", {
					name: "File this request under Supplier review?",
				})
				.focus();
			await page.keyboard.press("d");
			await page
				.getByRole("region", {
					name: "Which outcome matters most for this project?",
				})
				.waitFor();
			for (let i = 0; i < 4; i++) {
				await page
					.locator('[data-workspace-app-entry="decision-deck"] section')
					.focus();
				await page.keyboard.press("j");
			}
			await page.getByText("All clear", { exact: false }).waitFor();
			assert.equal(
				await page
					.locator('[data-workspace-app-entry="decision-deck"] .fd-decision')
					.count(),
				0,
				"the deck ends instead of wrapping",
			);
			assert(
				await page
					.getByText(/\d+ practice choices in this preview\./)
					.isVisible(),
				"completion identifies the unsaved practice choices",
			);
			assert.equal(
				await page.getByText("Next cards at", { exact: false }).count(),
				0,
				"completion does not defer the shared queue behind a local batch",
			);
			console.log(
				`Decision deck browser passed: ${viewport.width}x${viewport.height}`,
			);
			for (const dark of [false, true]) {
				for (const mcp of [false, true]) {
					await page.goto(
						`${origin}/browser-tests/card-tldr.html?${mcp ? "mcp=1&" : ""}${dark ? "dark=1" : ""}`,
					);
					const plain = page.getByRole(mcp ? "article" : "region", {
						name: "Save a follow-up task for Jules?",
					});
					await plain.waitFor();
					await page.evaluate(async () => {
						await document.fonts.ready;
						await Promise.all(
							document
								.getAnimations()
								.filter(
									(animation) =>
										animation.effect?.getTiming().iterations !== Infinity,
								)
								.map((animation) => animation.finished.catch(() => {})),
						);
					});
					await page
						.getByRole("button", { name: "Save task", exact: false })
						.waitFor();
					assert(
						!(await page
							.getByText("Source invocation:", { exact: false })
							.isVisible()),
						"technical source stays behind Details",
					);
					const text = await plain.innerText();
					assert(
						(text.match(/\S+/gu) ?? []).length <= 60,
						`the full visible card is under 60 words: ${text}`,
					);
					assert(
						await page.evaluate(
							() => document.documentElement.scrollWidth <= innerWidth,
						),
						"plain card has no horizontal overflow",
					);
					if (process.env.CARD_TLDR_SCREENSHOT_DIR)
						await page.screenshot({
							path: `${process.env.CARD_TLDR_SCREENSHOT_DIR}/card-tldr-${mcp ? "mcp" : "after"}-${viewport.width}-${dark ? "dark" : "light"}.png`,
							fullPage: true,
						});
					if (mcp) {
						await plain.locator("summary").focus();
						await page.keyboard.press("Enter");
					} else
						await page
							.getByRole("button", { name: "Details", exact: true })
							.click();
					assert(
						await page
							.getByText("Source invocation:", { exact: false })
							.isVisible(),
						"the exact source remains available",
					);
					if (process.env.CARD_TLDR_SCREENSHOT_DIR && !mcp) {
						await page.goto(
							`${origin}/browser-tests/card-tldr.html?before=1${dark ? "&dark=1" : ""}`,
						);
						await page
							.getByText("Source invocation:", { exact: false })
							.waitFor();
						await page.evaluate(async () => {
							await Promise.all(
								document
									.getAnimations()
									.filter(
										(animation) =>
											animation.effect?.getTiming().iterations !== Infinity,
									)
									.map((animation) => animation.finished.catch(() => {})),
							);
						});
						await page.screenshot({
							path: `${process.env.CARD_TLDR_SCREENSHOT_DIR}/card-tldr-before-${viewport.width}-${dark ? "dark" : "light"}.png`,
							fullPage: true,
						});
					}
				}
			}
		} finally {
			await page.close();
		}
	}
	assert.equal(server.exitCode, null, "Own fixture server stayed alive");
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
