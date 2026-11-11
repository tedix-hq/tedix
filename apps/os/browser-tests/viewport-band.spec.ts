import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const mobileSafari = process.env.TEDIX_VIEWPORT_ENGINE === "webkit";

const server = await startFixtureServer();
const { origin } = server;
const shots = process.env.TEDIX_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
let browser;
try {
	browser = await (mobileSafari ? webkit : chromium).launch({ headless: true });
	for (const width of mobileSafari ? [390] : [390, 768, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 800 } });
		await page.goto(`${origin}/admin/connections`);
		const accounts = page.locator(
			'[aria-label="Settings sections"] a[href="/account/connections"]',
		);
		await accounts.waitFor({ state: "attached" });
		// Below md the settings sidebar opens as a sheet from one menu row.
		if (width < 768) await page.locator("[data-settings-menu]").click();
		await accounts.waitFor();
		const capabilityRail = page.locator("[data-capability-nav]");
		await capabilityRail.waitFor({ state: "attached" });
		assert.equal(await capabilityRail.isVisible(), width >= 768);
		await accounts.click();
		await page.waitForURL((url) => url.pathname === "/account/connections");
		await page.close();
	}
	for (const width of mobileSafari ? [390] : [1280, 390]) {
		for (const zoom of width === 1280 ? [0.8, 1, 1.25, 1.5, 1.75] : [1, 1.5]) {
			// Desktop browser zoom changes CSS viewport dimensions and pixel density together.
			const page = await browser.newPage({
				viewport: {
					width: Math.round(width / zoom),
					height: Math.round(800 / zoom),
				},
				deviceScaleFactor: zoom,
				isMobile: width === 390,
				hasTouch: width === 390,
				reducedMotion: "reduce",
			});
			// Keep widget networking local while exercising OsQuickChat's real mount,
			// launcher styling and route suppression against the full fixture app.
			await page.route("https://widget.tedix.dev/**", (route) =>
				route.fulfill({
					contentType: "application/javascript",
					body: `const listeners = new Map(); let host;
window.Tedix = {
 on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event); },
 init() {
  host = document.createElement('div'); host.dataset.tedixWidget = '';
  host.attachShadow({mode:'open'}).innerHTML = '<style>.tedix-launcher{position:fixed;z-index:1000;border-radius:50%}</style><button class="tedix-launcher" aria-label="Quick chat">✦</button>';
  document.body.append(host); listeners.get('ready')?.({});
 }, context() {}, shutdown() { host?.remove(); }
};`,
				}),
			);
			await page.route("**/api/rpc/osWorkspaces/gadgets/workApps", (route) =>
				route.fulfill({
					json: {
						json: {
							items: [
								{
									gadget: {
										id: "00000050-0000-4000-8000-000000000001",
										workspaceId: "00000030-0000-4000-8000-000000000001",
										name: "Activity",
										status: "active",
									},
									currentRevision: {
										manifest: {
											entry: "tedix:app/activity-feed",
											navigation: { work: "feed" },
											capabilities: [],
											config: {
												version: 1,
												scope: "organization",
												projects: [],
											},
										},
									},
								},
							],
							truncated: false,
						},
					},
				}),
			);
			for (const [name, path] of [
				["outputs", "/outputs/00000040-0000-4000-8000-000000000001"],
				["work-feed", "/work?view=feed"],
				["settings", "/account/settings"],
			]) {
				await page.goto(`${origin}${path}`);
				await page.locator(":root[data-quick-chat-launcher]").waitFor();
				await page.locator('[data-slot="page"] > :last-child').waitFor();
				await page.waitForFunction(
					() =>
						parseFloat(
							getComputedStyle(
								document.querySelector('.route-content [data-slot="page"]')!,
							).paddingBottom,
						) >= 80,
				);
				if (name === "outputs" || name === "settings")
					await page.locator('[data-slot="page-title"]').waitFor();
				if (name === "work-feed") {
					await page.locator(".focus-feed").waitFor();
					await page
						.getByText("Opening your feed…", { exact: true })
						.waitFor({ state: "hidden" });
				}
				await page.evaluate(() => document.fonts.ready);
				const result = await page.evaluate(() => {
					const content = document.querySelector<HTMLElement>(
						'.route-content [data-slot="page"]',
					)!;
					content.scrollTop = content.scrollHeight;
					const launcher = document
						.querySelector("[data-tedix-widget]")!
						.shadowRoot!.querySelector(".tedix-launcher")!
						.getBoundingClientRect();
					const navigation = document
						.querySelector('[data-slot="bottom-nav"]')
						?.getBoundingClientRect();
					return {
						mainBottom: document
							.querySelector(".route-content")!
							.getBoundingClientRect().bottom,
						scrollBottom:
							navigation && Math.abs(navigation.bottom - innerHeight) <= 1
								? navigation.top
								: innerHeight,
						bottom: content.getBoundingClientRect().bottom,
						height: innerHeight,
						metric: parseFloat(
							document.documentElement.style.getPropertyValue(
								"--viewport-tedix-height",
							),
						),
						lastBottom:
							content.lastElementChild!.getBoundingClientRect().bottom,
						launcherTop: launcher.top,
						padding: parseFloat(getComputedStyle(content).paddingBottom),
					};
				});
				assert(
					Math.abs(result.mainBottom - result.height) <= 1,
					JSON.stringify(result),
				);
				assert(
					Math.abs(result.bottom - result.scrollBottom) <= 1,
					JSON.stringify(result),
				);
				assert(
					Math.abs(result.metric - result.height) <= 1,
					JSON.stringify(result),
				);
				assert(
					result.lastBottom <= result.launcherTop - 15,
					JSON.stringify(result),
				);
				assert(result.padding >= 80, JSON.stringify(result));
				if (shots && [1, 1.5].includes(zoom))
					await page.screenshot({
						path: `${shots}/viewport-band-after-${name}-${width}-zoom-${zoom}${mobileSafari ? "-webkit" : ""}.png`,
					});
				// Force overflow even when a fixture is short: the final control must
				// remain reachable, and full-height canvases must inherit no clearance.
				const overflow = await page.evaluate(() => {
					const content = document.querySelector<HTMLElement>(
						'.route-content [data-slot="page"]',
					)!;
					const filler = document.createElement("div");
					filler.style.height = "120vh";
					const last = document.createElement("button");
					last.textContent = "Last control";
					content.append(filler, last);
					content.scrollTop = content.scrollHeight;
					const bottom = last.getBoundingClientRect().bottom;
					return { bottom };
				});
				assert(
					overflow.bottom <= result.launcherTop - 15,
					JSON.stringify(overflow),
				);
				await page
					.locator('.route-content [data-slot="page"]')
					.evaluate((content) =>
						content.setAttribute("data-full-height", "true"),
					);
				await page.waitForFunction(
					() =>
						parseFloat(
							getComputedStyle(
								document.querySelector('.route-content [data-slot="page"]')!,
							).paddingBottom,
						) < 80,
				);
				console.log(
					`PASS ${name} ${width} zoom=${zoom}: bottom=${result.bottom}/${result.height}, last=${result.lastBottom}, launcher=${result.launcherTop}`,
				);
			}
			await page.close();
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
