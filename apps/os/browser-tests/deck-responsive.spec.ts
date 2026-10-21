import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { openExamples } from "./deck-controls";
import { chromium } from "playwright";
import assert from "node:assert/strict";

const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = process.env.TEDIX_BROWSER_TEST_PORT || String(probe.port!);
probe.stop();
const cwd = new URL("../", import.meta.url).pathname;
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
let browser;
try {
	await waitForFixtureServer(`${origin}/browser-tests/deck.html`, { server });
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	const shots = process.env.TEDIX_SCREENSHOT_DIR;
	for (const colorScheme of ["light", "dark"] as const)
		for (const [width, height] of [
			[390, 844],
			[768, 1024],
			[1024, 768],
			[1280, 800],
			[1440, 900],
			[1920, 1080],
		] as const)
			// A real shell spends 272px on the sidebar from tablet width up.
			for (const sidebar of width >= 1024 ? [false, true] : [false])
				for (const rail of [false, true]) {
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
					if (rail) {
						await page.keyboard.press("i");
						await page.waitForTimeout(400);
					}
					const label = `${width}x${height} ${colorScheme} sidebar=${sidebar} rail=${rail}`;
					const available = width - (sidebar ? 272 : 0);
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
								...document.querySelectorAll("[data-decision-actions] button"),
							].map((el) => el.getBoundingClientRect().bottom),
							height: innerHeight,
							inlineRail: !!document.querySelector(
								"aside[data-decision-context]:not([hidden])",
							),
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
					if (rail && available < 880)
						assert(!result.inlineRail, `${label}: rail should be a sheet`);
					if (rail && available >= 960)
						assert(
							result.inlineRail,
							`${label}: rail should sit beside the card`,
						);
					if (shots)
						await page.screenshot({
							path: `${shots}/deck-responsive-${width}-${sidebar ? "sidebar-" : ""}${rail ? "rail" : "closed"}-${colorScheme}.png`,
						});
					console.log(`PASS ${label}`);
				}
} finally {
	await browser?.close();
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
