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
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
let browser;
try {
	for (let attempt = 0; ; attempt++) {
		if (attempt === 100 || server.exitCode !== null)
			throw new Error("Deck test server unavailable");
		try {
			if ((await fetch(`${origin}/browser-tests/deck-viewport.html`)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	for (const colorScheme of ["light", "dark"] as const) {
		for (const [width, height] of [
			[1280, 720],
			[1512, 794],
			[1920, 1080],
			[390, 844],
		]) {
			await page.setViewportSize({ width: width!, height: height! });
			await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
			await page.goto(`${origin}/browser-tests/deck-viewport.html`);
			await page.locator("[data-decision-actions]").waitFor();
			await page.evaluate(() => document.fonts.ready);
			// Simulate a published organization accent, which must win in both modes.
			await page.evaluate((mode) => {
				document.documentElement.classList.toggle("dark", mode === "dark");
				document.documentElement.style.setProperty("--primary", "#2463eb");
				document.documentElement.style.setProperty(
					"--card",
					mode === "dark" ? "#1e1a2f" : "#ececf3",
				);
				document.documentElement.style.setProperty(
					"--primary-foreground",
					"#ffffff",
				);
			}, colorScheme);
			async function check(stage: string) {
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() => resolve()),
							),
						),
				);
				// Every body element must be scrollable fully above the reserved footer.
				const overlap = await page.evaluate(() => {
					const card = document.querySelector(".fd-card")!;
					const body = card.querySelector<HTMLElement>(
						'[data-slot="card-content"]',
					)!;
					const footer = card.querySelector<HTMLElement>(
						'[data-slot="card-footer"]',
					)!;
					const boundary = footer.getBoundingClientRect();
					const bodyRect = body.getBoundingClientRect();
					const failures: string[] = [];
					if (bodyRect.bottom > boundary.top + 1)
						failures.push("body overlaps footer");
					if (
						parseFloat(getComputedStyle(body).paddingBottom) < boundary.height
					)
						failures.push("missing footer clearance");
					if (
						parseFloat(getComputedStyle(body).scrollPaddingBottom) <
						boundary.height
					)
						failures.push("missing scroll clearance");
					for (const node of body.querySelectorAll<HTMLElement>(
						"button, input, textarea, a, p, summary",
					)) {
						if (!node.getClientRects().length) continue;
						node.scrollIntoView({ block: "end" });
						const rect = node.getBoundingClientRect();
						if (rect.bottom > boundary.top + 1)
							failures.push(node.textContent ?? node.tagName);
					}
					body.scrollTop = body.scrollHeight;
					for (const button of document.querySelectorAll(
						".fd-deck-current button",
					)) {
						if (button.textContent === "Later" && !footer.contains(button))
							failures.push("Later outside card footer");
					}
					return failures;
				});
				assert.deepEqual(
					overlap,
					[],
					`${width}x${height} ${colorScheme} ${stage}: footer overlap`,
				);
				const result = await page.evaluate(() => {
					const card = document.querySelector(".fd-card")!;
					const actions = [
						...document.querySelectorAll("[data-decision-actions] button"),
					].map((node) => {
						const r = node.getBoundingClientRect();
						return {
							top: r.top,
							bottom: r.bottom,
							left: r.left,
							right: r.right,
						};
					});
					return {
						actions,
						title: document.querySelector("[data-slot=card-title]")!
							.textContent!,
						proposer: document.querySelector(".fd-proposer")!.textContent!,
						font: parseFloat(
							getComputedStyle(
								document.querySelector("[data-slot=card-title]")!,
							).fontSize,
						),
						bodyHeight: card
							.querySelector('[data-slot="card-content"]')!
							.getBoundingClientRect().height,
						scroll: document.documentElement.scrollHeight,
						pageScroll:
							document.querySelector('[data-slot="page"]')!.scrollHeight,
						pageHeight:
							document.querySelector('[data-slot="page"]')!.clientHeight,
						height: innerHeight,
						width: innerWidth,
						surface: getComputedStyle(card).backgroundColor,
						accent: getComputedStyle(
							document.querySelector('[data-decision-intent="approve"]')!,
						).backgroundColor,
					};
				});
				assert(result.actions.length === 3);
				assert(
					result.bodyHeight >= 80,
					`Proposal body collapsed: ${JSON.stringify(result)}`,
				);
				for (const rect of result.actions)
					assert(
						rect.top >= 0 &&
							rect.bottom <= result.height &&
							rect.left >= 0 &&
							rect.right <= result.width,
						`${width}x${height} ${colorScheme} ${stage}: ${JSON.stringify(result)}`,
					);
				assert(
					result.scroll <= result.height &&
						result.pageScroll <= result.pageHeight,
					`Page scrolled: ${JSON.stringify(result)}`,
				);
				assert(result.title.length <= 90 && result.font <= 36);
				assert(
					result.proposer.includes(
						"Codex (for Example Website Publishing Platform)",
					) && !result.proposer.includes("session"),
				);
				assert.equal(result.accent, "rgb(36, 99, 235)");
				assert.equal(
					result.surface,
					colorScheme === "dark" ? "rgb(30, 26, 47)" : "rgb(236, 236, 243)",
				);
			}
			await check("collapsed");
			await page
				.getByRole("button", { name: "More", exact: true })
				.first()
				.click();
			await check("expanded");
			await page
				.getByRole("button", { name: "Why this?", exact: true })
				.click();
			await check("why expanded");
			if (process.env.TEDIX_SCREENSHOT_DIR)
				await page.screenshot({
					path: `${process.env.TEDIX_SCREENSHOT_DIR}/deck-${width}x${height}-${colorScheme}.png`,
				});
			console.log(
				`PASS ${width}x${height} ${colorScheme}: collapsed, More, Why, theme accent, no page scroll`,
			);
		}
	}
	// Exercise the full generic app renderer as well as the long-card fixture.
	for (const [width, height] of [
		[1280, 720],
		[1512, 794],
		[1920, 1080],
		[390, 844],
	]) {
		await page.setViewportSize({ width: width!, height: height! });
		await page.goto(`${origin}/browser-tests/deck.html?long-proposal=1`);
		await page
			.getByRole("button", { name: "Try examples", exact: true })
			.click();
		await page.locator("[data-decision-actions]").waitFor();
		await page.evaluate(() => document.fonts.ready);
		for (const mode of ["light", "dark"]) {
			await page.evaluate(
				(mode) =>
					document.documentElement.classList.toggle("dark", mode === "dark"),
				mode,
			);
			const layout = await page.evaluate(() => ({
				height: innerHeight,
				scroll: document.documentElement.scrollHeight,
				title: document.querySelector('[data-slot="card-title"]')!.textContent!,
				actions: [
					...document.querySelectorAll("[data-decision-actions] button"),
				].map((el) => {
					const r = el.getBoundingClientRect();
					return { top: r.top, bottom: r.bottom };
				}),
			}));
			assert(layout.actions.length >= 2);
			assert(layout.title.length <= 90);
			assert(
				layout.scroll <= layout.height,
				`Generic renderer page scroll ${width}x${height}: ${JSON.stringify(layout)}`,
			);
			for (const rect of layout.actions)
				assert(
					rect.top >= 0 && rect.bottom <= layout.height,
					`Generic renderer action overflow: ${JSON.stringify(layout)}`,
				);
			console.log(`PASS generic renderer ${width}x${height} ${mode}`);
		}
	}
} finally {
	await browser?.close();
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
