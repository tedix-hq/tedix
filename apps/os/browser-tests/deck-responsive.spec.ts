import { startFixtureServer } from "./fixture-server";
import { openExamples, settleAnimations } from "./deck-controls";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const server = await startFixtureServer("/browser-tests/deck.html");
const { origin } = server;
let browser;
try {
	const launched = await chromium.launch({ headless: true });
	browser = launched;
	const shots = process.env.TEDIX_SCREENSHOT_DIR;
	// Light and dark run side by side, and each load measures the closed rail
	// before opening it, so the spec pays half the page loads it used to.
	await Promise.all(
		(["light", "dark"] as const).map(async (colorScheme) => {
			const page = await launched.newPage();
			for (const [width, height] of [
				[390, 844],
				[768, 1024],
				[1024, 768],
				[1280, 800],
				[1440, 900],
				[1920, 1080],
			] as const)
				// A real shell spends 272px on the sidebar from tablet width up.
				for (const sidebar of width >= 1024 ? [false, true] : [false]) {
					await page.setViewportSize({ width, height });
					await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
					await page.goto(`${origin}/browser-tests/deck.html`);
					await openExamples(page);
					await page.keyboard.press("Escape");
					await page.locator("[data-decision-actions]").waitFor();
					await page.evaluate(() => document.fonts.ready);
					await page.evaluate(
						([mode, pad]) => {
							document.documentElement.classList.toggle(
								"dark",
								mode === "dark",
							);
							if (pad)
								document.head.insertAdjacentHTML(
									"beforeend",
									"<style>[data-slot=page]{padding-left:272px!important}</style>",
								);
						},
						[colorScheme, sidebar] as const,
					);
					await settleAnimations(page);
					const closedCard = await page.locator(".fd-card").boundingBox();
					assert(closedCard);
					for (const rail of [false, true]) {
						if (rail) {
							await page.keyboard.press("i");
							await page
								.getByRole("dialog", { name: "Decision context", exact: true })
								.waitFor();
							await settleAnimations(page);
						}
						const label = `${width}x${height} ${colorScheme} sidebar=${sidebar} rail=${rail}`;
						const result = await page.evaluate(() => {
							const card = document.querySelector<HTMLElement>(".fd-card")!;
							const fragments: string[] = [];
							for (const node of card.querySelectorAll<HTMLElement>(
								'[data-slot="card-title"], [data-slot="card-content"] p, [data-slot="card-content"] li',
							)) {
								const text = node.textContent?.trim() ?? "";
								if (!text || !node.getClientRects().length) continue;
								const style = getComputedStyle(node);
								const lineHeight =
									parseFloat(style.lineHeight) ||
									parseFloat(style.fontSize) * 1.4;
								const lines = Math.round(
									node.getBoundingClientRect().height / lineHeight,
								);
								// Fewer than ~14 characters per line means the text is squeezed.
								if (text.length > 28 && lines > Math.ceil(text.length / 14))
									fragments.push(`${text.slice(0, 40)} (${lines} lines)`);
							}
							const overflowing = [
								...document.querySelectorAll<HTMLElement>(
									".feed-deck, .fd-card, [data-slot=page]",
								),
							]
								.filter((el) => el.scrollWidth > el.clientWidth + 1)
								.map((el) => el.className.toString().slice(0, 40));
							return {
								fragments,
								overflowing,
								docOverflow: document.documentElement.scrollWidth - innerWidth,
								cardWidth: card.getBoundingClientRect().width,
								cardBottom: card.getBoundingClientRect().bottom,
								actions: [
									...document.querySelectorAll(
										"[data-decision-actions] button",
									),
								].map((el) => el.getBoundingClientRect().bottom),
								height: innerHeight,
								cardLeft: card.getBoundingClientRect().left,
							};
						});
						assert.deepEqual(result.fragments, [], `${label}: fragmented text`);
						assert.deepEqual(result.overflowing, [], `${label}: overflow`);
						assert(result.docOverflow <= 0, `${label}: horizontal page scroll`);
						assert(
							result.cardWidth >= Math.min(320, width - 32),
							`${label}: card squeezed to ${result.cardWidth}`,
						);
						assert(
							result.actions.every((bottom) => bottom <= result.height),
							`${label}: actions below the fold`,
						);
						assert(
							result.cardBottom <= result.height - 8,
							`${label}: card runs past the viewport`,
						);
						if (rail) {
							const context = await page
								.getByRole("dialog", { name: "Decision context", exact: true })
								.boundingBox();
							assert(
								context &&
									context.x >= 0 &&
									context.y >= 0 &&
									context.x + context.width <= width + 1 &&
									context.y + context.height <= height + 1,
								`${label}: context sheet escaped the viewport`,
							);
							assert(
								Math.abs(result.cardWidth - closedCard.width) <= 1 &&
									Math.abs(result.cardLeft - closedCard.x) <= 1,
								`${label}: opening context shifted or squeezed the card: ${JSON.stringify({ closed: closedCard, open: { x: result.cardLeft, width: result.cardWidth } })}`,
							);
						}
						if (shots)
							await page.screenshot({
								path: `${shots}/deck-responsive-${width}-${sidebar ? "sidebar-" : ""}${rail ? "rail" : "closed"}-${colorScheme}.png`,
							});
						console.log(`PASS ${label}`);
					}
				}
		}),
	);
} finally {
	await browser?.close();
	await server.stop();
}
