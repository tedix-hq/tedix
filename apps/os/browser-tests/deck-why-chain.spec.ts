import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import {
	GITHUB_CARD_ID,
	GITHUB_DECISION_CONTEXT,
} from "../dev/decision-graph-fixture";

const server = await startFixtureServer("/browser-tests/deck-why-chain.html");
const { origin } = server;
const screenshotDirectory = process.env.DECK_WHY_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: width === 390 ? 844 : 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: width === 390,
				hasTouch: width === 390,
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			let reads = 0;
			page.on("request", (request) => {
				if (request.url().includes("/decisionGraph/getContext")) reads++;
			});
			try {
				await page.goto(
					`${origin}/browser-tests/deck-why-chain.html?theme=${theme}`,
				);
				await page
					.getByRole("region", { name: "Review the GitHub access audit?" })
					.waitFor();
				assert.equal(
					reads,
					0,
					"A closed Why this panel makes no graph request",
				);
				await page
					.getByRole("button", { name: "Why am I seeing this", exact: true })
					.click();
				const summary = page.getByRole("button", {
					name: GITHUB_DECISION_CONTEXT.explanation,
					exact: true,
				});
				await summary.waitFor();
				assert.equal(await summary.getAttribute("aria-expanded"), "false");
				await summary.focus();
				await page.keyboard.press("Enter");
				const chain = page.getByRole("list", { name: "Decision chain" });
				await chain.waitFor();
				assert.equal(await chain.getByRole("link").count(), 5);
				assert.equal(
					await chain
						.getByRole("link", {
							name: "Your earlier decision: Rotate leftover credentials",
						})
						.getAttribute("href"),
					"/work/items/d5000000-0000-4000-8000-000000000002",
				);
				const output = chain.getByRole("link", {
					name: "Evidence: Access audit complete",
				});
				assert.equal(
					await output.getAttribute("href"),
					"/outputs/d5000000-0000-4000-8000-000000000003",
				);
				assert.equal(
					await chain
						.getByRole("link", { name: "Involves: GitHub" })
						.getAttribute("href"),
					`/work/interactions/${GITHUB_CARD_ID}`,
				);
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
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					"No horizontal overflow",
				);
				for (const link of await chain.getByRole("link").all()) {
					const box = await link.boundingBox();
					assert(
						box && box.height >= 44,
						"Chain links meet the phone touch target",
					);
				}
				if (screenshotDirectory)
					await page.screenshot({
						path: `${screenshotDirectory}/deck-why-${width}-${theme}.png`,
						fullPage: true,
					});
				await summary.click();
				assert.equal(await summary.getAttribute("aria-expanded"), "false");
				assert.equal(reads, 1, "One generated query serves the disclosure");
				assert.deepEqual(errors, []);
				console.log(
					`Deck Why chain passed: ${width}px ${theme}, 5 linked steps, 1 API read, no overflow`,
				);
			} finally {
				await page.close();
			}
		}
} finally {
	await browser?.close();
	await server.stop();
}
