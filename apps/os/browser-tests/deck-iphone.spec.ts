import assert from "node:assert/strict";
import { devices, webkit, type Browser, type Page } from "playwright";

/*
 * The Work Deck on iPhone Safari (WebKit). A software keyboard shrinks only the
 * visual viewport there; the Deck once followed it, collapsed the card to 42px,
 * spilled its footer and lifted the Feed/Deck bar into mid-screen.
 */
const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = process.env.TEDIX_BROWSER_TEST_PORT || String(probe.port!);
probe.stop();
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
const shots = process.env.TEDIX_SCREENSHOT_DIR;
const MIN_CARD_HEIGHT = 240;

async function settle(page: Page) {
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await page.waitForTimeout(150);
}

/** Geometry the Deck must keep at any viewport. */
function measure(page: Page) {
	return page.evaluate(() => {
		const card = document.querySelector<HTMLElement>(
			".fd-deck-current .fd-card",
		)!;
		const cardBox = card.getBoundingClientRect();
		const footer = card.querySelector<HTMLElement>(
			'[data-slot="card-footer"]',
		)!;
		const footerBox = footer.getBoundingClientRect();
		const body = card.querySelector<HTMLElement>('[data-slot="card-content"]')!;
		const nav = document.querySelector<HTMLElement>(
			'[data-slot="bottom-nav"]',
		)!;
		const failures: string[] = [];
		if (
			footerBox.top < cardBox.top - 1 ||
			footerBox.bottom > cardBox.bottom + 1
		)
			failures.push(
				`footer ${footerBox.top}-${footerBox.bottom} outside card ${cardBox.top}-${cardBox.bottom}`,
			);
		if (body.getBoundingClientRect().bottom > footerBox.top + 1)
			failures.push("card body runs into the footer");
		// "Tedix · 19h ago", "Details", the actions and "Not useful" never overlap.
		const pieces = [
			...card.querySelectorAll<HTMLElement>(
				'[data-slot="card-description"] > *, [data-slot="card-footer"] button, [data-slot="card-footer"] a',
			),
		]
			.filter((node) => node.getClientRects().length)
			.map((node) => ({
				name: (node.textContent ?? node.tagName).trim().slice(0, 24),
				box: node.getBoundingClientRect(),
			}))
			.filter(({ box }) => box.width > 0 && box.height > 0);
		for (const [index, a] of pieces.entries()) {
			if (a.box.bottom > cardBox.bottom + 1 || a.box.top < cardBox.top - 1)
				failures.push(`${a.name} outside the card`);
			for (const b of pieces.slice(index + 1)) {
				const overlapX =
					Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
				const overlapY =
					Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
				if (overlapX > 1 && overlapY > 1)
					failures.push(`${a.name} overlaps ${b.name}`);
			}
		}
		// Hit-test the bar so an ancestor clipping it at the keyboard edge fails too.
		const navBox = nav.getBoundingClientRect();
		const hit = document.elementFromPoint(
			navBox.left + navBox.width / 3,
			navBox.bottom - 4,
		);
		if (!hit || !nav.contains(hit))
			failures.push("Feed/Deck bar is covered or clipped");
		// The quick-chat launcher floats above the bar, never on the Deck tab.
		const launcher = document
			.querySelector("[data-tedix-widget]")
			?.shadowRoot?.querySelector(".tedix-launcher")
			?.getBoundingClientRect();
		if (launcher && launcher.height && launcher.bottom > navBox.top - 8)
			failures.push(
				`chat launcher ends at ${launcher.bottom}, bar starts at ${navBox.top}`,
			);
		const active = document.activeElement;
		return {
			failures,
			cardHeight: cardBox.height,
			navBottom: nav.getBoundingClientRect().bottom,
			layoutHeight: document.documentElement.clientHeight,
			focused:
				active && active !== document.body
					? `${active.tagName} ${active.getAttribute("aria-label") ?? active.textContent?.slice(0, 30)}`
					: null,
		};
	});
}

let browser: Browser | undefined;
try {
	for (let attempt = 0; ; attempt++) {
		if (attempt === 100 || server.exitCode !== null)
			throw new Error("Deck test server unavailable");
		try {
			if ((await fetch(`${origin}/work?view=deck`)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await webkit.launch({ headless: true });
	for (const [size, device] of [
		["390x844", devices["iPhone 13"]],
		["375x667", devices["iPhone 8"]],
	] as const)
		for (const colorScheme of ["light", "dark"] as const) {
			const label = `${size} ${colorScheme}`;
			const context = await browser.newContext({
				...device,
				colorScheme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(theme) => localStorage.setItem("tedix-os-theme", theme),
				colorScheme,
			);
			const page = await context.newPage();
			await page.goto(`${origin}/work?view=deck`);
			await page.locator(".fd-deck-current .fd-card").waitFor();
			await page.locator('[data-slot="card-footer"]').first().waitFor();
			await page.waitForFunction(
				() =>
					document
						.querySelector("[data-tedix-widget]")
						?.shadowRoot?.querySelector(".tedix-launcher")
						?.getBoundingClientRect().height,
			);
			await page.evaluate(() => document.fonts.ready);
			await settle(page);

			const loaded = await measure(page);
			assert.equal(loaded.focused, null, `${label}: focused on load`);
			assert.deepEqual(loaded.failures, [], `${label}: card layout on load`);
			assert(
				loaded.cardHeight >= MIN_CARD_HEIGHT,
				`${label}: card only ${loaded.cardHeight}px tall`,
			);
			assert(
				Math.abs(loaded.navBottom - loaded.layoutHeight) <= 1,
				`${label}: Feed/Deck bar ends at ${loaded.navBottom}, viewport ${loaded.layoutHeight}`,
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/after-${size}-${colorScheme}.png`,
				});

			// The iOS keyboard: the layout viewport stays, the visual viewport shrinks and pans.
			await page.evaluate(() => {
				const viewport = window.visualViewport!;
				const height = Math.round(innerHeight * 0.55);
				Object.defineProperty(viewport, "height", {
					configurable: true,
					get: () => height,
				});
				Object.defineProperty(viewport, "offsetTop", {
					configurable: true,
					get: () => 40,
				});
				viewport.dispatchEvent(new Event("resize"));
				viewport.dispatchEvent(new Event("scroll"));
			});
			await settle(page);
			const keyboard = await measure(page);
			assert.deepEqual(
				keyboard.failures,
				[],
				`${label}: card layout with keyboard`,
			);
			assert(
				Math.abs(keyboard.cardHeight - loaded.cardHeight) <= 1,
				`${label}: keyboard resized the card ${loaded.cardHeight} -> ${keyboard.cardHeight}`,
			);
			assert(
				Math.abs(keyboard.navBottom - keyboard.layoutHeight) <= 1,
				`${label}: keyboard lifted the Feed/Deck bar to ${keyboard.navBottom}`,
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/after-keyboard-${size}-${colorScheme}.png`,
				});

			// A browser that shrinks the layout viewport for its keyboard still keeps a usable card.
			await page.setViewportSize({ width: device.viewport.width, height: 360 });
			await settle(page);
			const short = await measure(page);
			assert.deepEqual(short.failures, [], `${label}: card layout at 360px`);
			assert(
				short.cardHeight >= MIN_CARD_HEIGHT,
				`${label}: card only ${short.cardHeight}px tall at 360px`,
			);
			// Wider glyphs (CI's Linux fonts) wrap the action row onto two lines.
			await page.addStyleTag({
				content:
					".fd-deck-current [data-decision-actions] > button { padding-inline: 1.6rem !important }",
			});
			await settle(page);
			const wrapped = await measure(page);
			assert.deepEqual(
				wrapped.failures,
				[],
				`${label}: card layout at 360px with a wrapped action row`,
			);
			await context.close();
			console.log(`PASS ${label}`);
		}
} finally {
	await browser?.close();
	process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
