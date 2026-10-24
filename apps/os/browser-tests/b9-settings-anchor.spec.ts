import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit, type Browser, type Page } from "playwright";

// Runs in `bun run --cwd apps/os test:browser:settings` (part of test:run).
// Uses the actual fixture app; neither component markup nor geometry is mocked.
const evidence =
	process.env.SETTINGS_ANCHOR_EVIDENCE_DIR ??
	"/tmp/tedix-settings-anchor-webkit";
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--strictPort",
	],
	{
		cwd: new URL("../", import.meta.url).pathname,
		stdout: Bun.file(`${evidence}/server.log`),
		stderr: "inherit",
		detached: true,
	},
);
const railSelector = 'nav[aria-label="Organization settings sections"]';
const results: Array<Record<string, unknown>> = [];
let browser: Browser | undefined;
let failures = 0;

async function geometry(page: Page) {
	return page.evaluate((selector) => {
		const rail = document.querySelector<HTMLElement>(selector);
		const root =
			rail?.closest<HTMLElement>('[data-slot="page"]') ??
			document.querySelector<HTMLElement>('.route-content [data-slot="page"]');
		if (!root) throw new Error("Real app Page scroll root missing");
		const rect = (element: Element) => {
			const r = element.getBoundingClientRect();
			return {
				left: r.left,
				right: r.right,
				top: r.top,
				bottom: r.bottom,
				width: r.width,
				height: r.height,
			};
		};
		const viewport = rail?.firstElementChild as HTMLElement | undefined;
		const settings = document.querySelector(
			'nav[aria-label="Settings sections"]',
		);
		const activeSettings = settings?.querySelector("[data-settings-active]");
		return {
			path: location.pathname,
			hash: location.hash,
			width: innerWidth,
			height: innerHeight,
			theme: document.documentElement.dataset.mode,
			windowY: scrollY,
			documentWidth: document.documentElement.scrollWidth,
			root: {
				...rect(root),
				scrollTop: root.scrollTop,
				clientHeight: root.clientHeight,
				scrollHeight: root.scrollHeight,
				clientWidth: root.clientWidth,
				scrollWidth: root.scrollWidth,
			},
			rail: rail && rect(rail),
			viewport: viewport && {
				...rect(viewport),
				scrollLeft: viewport.scrollLeft,
				clientWidth: viewport.clientWidth,
				scrollWidth: viewport.scrollWidth,
			},
			links: Array.from(
				rail?.querySelectorAll<HTMLAnchorElement>("a[data-section-target]") ??
					[],
				(link) => ({
					...rect(link),
					href: link.getAttribute("href"),
					id: link.dataset.sectionTarget,
					current: link.getAttribute("aria-current"),
					target: !!document.getElementById(link.dataset.sectionTarget!),
				}),
			),
			settings: settings && rect(settings),
			activeSettings: activeSettings && rect(activeSettings),
			sectionRails: document.querySelectorAll("a[data-section-target]").length,
		};
	}, railSelector);
}

async function currentIs(page: Page, id: string) {
	await page.waitForFunction(
		({ selector, id }) => {
			const current = document.querySelectorAll(
				`${selector} a[aria-current="location"]`,
			);
			return (
				current.length === 1 &&
				(current[0] as HTMLElement).dataset.sectionTarget === id
			);
		},
		{ selector: railSelector, id },
	);
}

async function setHash(page: Page, id: string) {
	await page.evaluate((id) => {
		location.hash = id;
	}, id);
	await page.waitForURL((url) => url.hash === `#${id}`);
	await currentIs(page, id);
}

async function atTarget(page: Page, id: string) {
	await page.waitForFunction(
		({ selector, id }) => {
			const rail = document.querySelector(selector)!;
			const root = rail.closest<HTMLElement>('[data-slot="page"]')!;
			const target = document.getElementById(id)!;
			const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
			const remaining = root.scrollHeight - root.clientHeight - root.scrollTop;
			const delta =
				target.getBoundingClientRect().top - root.getBoundingClientRect().top;
			return (
				root.scrollTop > 0 && (Math.abs(delta - margin) <= 3 || remaining <= 12)
			);
		},
		{ selector: railSelector, id },
	);
}

async function assertRail(page: Page, phone: boolean) {
	const state = await geometry(page);
	assert.equal(
		state.links.filter((link) => link.current === "location").length,
		1,
		JSON.stringify(state),
	);
	assert(state.links.length >= 4);
	for (const link of state.links) {
		assert.equal(link.href, `#${link.id}`);
		assert(link.target, `Missing anchor target ${link.id}`);
		if (phone)
			assert(link.height >= 44, `Phone anchor target: ${JSON.stringify(link)}`);
	}
	assert(state.documentWidth <= state.width + 1, JSON.stringify(state));
	assert(
		state.root.scrollWidth <= state.root.clientWidth + 1,
		JSON.stringify(state),
	);
	assert(state.viewport && state.rail);
	assert(
		state.viewport.left >= -1 && state.viewport.right <= state.width + 1,
		JSON.stringify(state),
	);
	if (phone)
		assert(
			state.viewport.scrollWidth > state.viewport.clientWidth,
			"Phone rail must exercise overflow",
		);
	assert(
		state.settings && state.activeSettings,
		"Active settings navigation missing",
	);
	assert(
		state.activeSettings.left >= state.settings.left - 1 &&
			state.activeSettings.right <= state.settings.right + 1,
		JSON.stringify(state),
	);
	assert(
		state.activeSettings.top >= state.settings.top - 1 &&
			state.activeSettings.bottom <= state.settings.bottom + 1,
		JSON.stringify(state),
	);
	return state;
}

async function keyboardRail(page: Page) {
	const links = page.locator(`${railSelector} a[data-section-target]`);
	await links.first().focus();
	for (let index = 1; index < (await links.count()); index++) {
		// WebKit's default keyboard mode includes links with Option+Tab.
		await page.keyboard.press("Alt+Tab");
		assert(
			await links
				.nth(index)
				.evaluate((link) => link === document.activeElement),
			`Tab skipped anchor ${index}`,
		);
		const focus = await links.nth(index).evaluate((link) => {
			const r = link.getBoundingClientRect();
			const viewport =
				link.parentElement!.parentElement!.getBoundingClientRect();
			const style = getComputedStyle(link);
			return {
				visible: r.left >= viewport.left - 1 && r.right <= viewport.right + 1,
				focusVisible: link.matches(":focus-visible"),
				ring: style.boxShadow,
				outline: style.outlineStyle,
			};
		});
		assert(focus.visible && focus.focusVisible, JSON.stringify(focus));
		assert(
			focus.ring !== "none" || focus.outline !== "none",
			JSON.stringify(focus),
		);
	}
	const lastId = await links.last().getAttribute("data-section-target");
	// Focus can already make the last section current. Wait for the router's
	// hash scroll restoration before the next key cancels section restoration.
	const navigation = await page.evaluateHandle(async (id) => {
		const { osRouter } = await import("/src/router.tsx");
		const state = { rendered: false };
		const unsubscribe = osRouter.subscribe("onRendered", (event) => {
			if (event.toLocation.hash !== id) return;
			state.rendered = true;
			unsubscribe();
		});
		return state;
	}, lastId!);
	await page.keyboard.press("Enter");
	await page.waitForFunction((state) => state.rendered, navigation);
	await navigation.dispose();
	await currentIs(page, lastId!);
	assert(
		await links.last().evaluate((link) => link === document.activeElement),
		"Hash navigation must retain the keyboard-activated anchor",
	);
}

try {
	for (let attempt = 0; ; attempt++) {
		if (server.exitCode !== null)
			throw new Error(`Owned fixture server exited early: ${server.exitCode}`);
		if (attempt === 120)
			throw new Error("Owned fixture server did not become ready");
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	for (const { engine, viewport, scenarios } of [
		{
			engine: webkit,
			scenarios: [
				"routes",
				"restore-history",
				"wheel",
				"touch",
				"key",
			] as const,
			viewports: [
				{ width: 375, height: 667 },
				{ width: 390, height: 844 },
				{ width: 1280, height: 900 },
			],
		},
		{
			engine: chromium,
			scenarios: ["settings-pages"] as const,
			viewports: [
				{ width: 390, height: 844 },
				{ width: 1280, height: 900 },
			],
		},
	].flatMap(({ engine, viewports, scenarios }) =>
		viewports.map((viewport) => ({ engine, viewport, scenarios })),
	)) {
		browser = await engine.launch({ headless: true });
		for (const theme of ["light", "dark"] as const) {
			for (const scenario of scenarios) {
				const settingsPages =
					scenario === "routes" || scenario === "settings-pages";
				// Playwright mobile WebKit rejects wheel input; exercise it on desktop.
				if (scenario === "wheel" && viewport.width < 600) continue;
				const name = `${engine.name()}-${viewport.width}x${viewport.height}-${theme}-${scenario}`;
				const page = await browser.newPage({
					viewport,
					colorScheme: theme,
					isMobile: viewport.width < 600,
					hasTouch: viewport.width < 600 || scenario === "touch",
					reducedMotion: "reduce",
				});
				page.setDefaultTimeout(12_000);
				const consoleEntries: string[] = [];
				const requests: string[] = [];
				page.on("console", (entry) =>
					consoleEntries.push(`${entry.type()}: ${entry.text()}`),
				);
				page.on("pageerror", (error) =>
					consoleEntries.push(`pageerror: ${error.message}`),
				);
				let release = () => {};
				const delayed = new Promise<void>((resolve) => {
					release = resolve;
				});
				let readStarted = false;
				let readFinished = false;
				// Loader-prefetched API reads block the rail mount. Delay the real
				// lazy section's local GET instead, preserving its Suspense boundary.
				await page.route("**/*", async (route) => {
					const url = new URL(route.request().url());
					if (url.origin !== origin) return route.abort("blockedbyclient");
					requests.push(url.pathname);
					if (url.pathname.endsWith("/userSettings/getPreferences")) {
						const response = await route.fetch();
						const body = await response.json();
						body.json.preferences.theme = theme;
						return route.fulfill({ response, json: body });
					}
					if (
						(!settingsPages &&
							url.pathname.endsWith("/organization-profile-form.tsx")) ||
						(settingsPages &&
							url.pathname.endsWith("/team_.$tediId.settings.tsx") &&
							url.searchParams.get("tsr-split") === "component")
					) {
						const response = await route.fetch();
						readStarted = true;
						await delayed;
						await route.fulfill({ response });
						readFinished = true;
						return;
					}
					return route.continue();
				});
				try {
					if (settingsPages) {
						for (const path of [
							"/account/settings",
							"/team/00000010-0000-4000-8000-000000000001/settings",
						]) {
							const account = path.startsWith("/account");
							await page.goto(
								`${origin}${account ? path : path.replace(/\/settings$/, "")}`,
								{
									waitUntil: "domcontentloaded",
								},
							);
							if (!account) {
								await page
									.locator(".route-content .tedis-page")
									.getByRole("tab", { name: "Settings", exact: true })
									.click();
								await page
									.locator('.route-content .tedis-page [aria-busy="true"]')
									.waitFor();
								assert(readStarted && !readFinished);
								assert.equal(
									await page
										.locator('.route-content [data-slot="page"]')
										.count(),
									1,
									"Tedi settings must keep one page while its chunk is pending",
								);
								await page.screenshot({
									path: `${evidence}/${name}-tedi-pending.png`,
								});
								release();
							}
							const heading = page.getByRole("heading", {
								name: account ? "Settings" : "Identity & personality",
								exact: true,
							});
							await heading.waitFor();
							if (!account) {
								assert(
									await page
										.getByLabel("Display name", { exact: true })
										.inputValue(),
								);
								assert(
									await page
										.getByLabel("Personality", { exact: true })
										.inputValue(),
								);
							}
							await page.waitForFunction(() => {
								const pages = document.querySelectorAll(
									'.route-content [data-slot="page"]',
								);
								return (
									pages.length === 1 &&
									!pages[0].matches('[aria-busy="true"]') &&
									!pages[0].querySelector('[aria-busy="true"]')
								);
							});
							await page.evaluate(() => document.fonts.ready);
							await heading.scrollIntoViewIfNeeded();
							const state = await geometry(page);
							assert.equal(state.theme, theme);
							assert(
								state.root.scrollHeight > state.root.clientHeight,
								JSON.stringify(state),
							);
							assert(
								state.documentWidth <= state.width + 1,
								JSON.stringify(state),
							);
							assert(
								state.root.scrollWidth <= state.root.clientWidth + 1,
								JSON.stringify(state),
							);
							results.push({ name, ...state });
							await page.screenshot({
								path: `${evidence}/${name}-${path.startsWith("/account") ? "account" : "tedi"}.png`,
							});
						}
						if (scenario === "routes") {
							await page.goto(`${origin}/admin/organization`);
							const settings = page.getByRole("navigation", {
								name: "Settings sections",
								exact: true,
							});
							await settings.waitFor();
							const accounts = settings.getByRole("link", {
								name: "My accounts",
								exact: true,
							});
							assert(
								await accounts.isVisible(),
								"My accounts must stay visible",
							);
							await accounts.click();
							await page.waitForURL(
								(url) => url.pathname === "/account/connections",
							);
							await page
								.getByRole("heading", {
									name: "Accounts",
									level: 1,
									exact: true,
								})
								.waitFor();
							await page.screenshot({
								path: `${evidence}/${name}-my-accounts.png`,
							});
							await page.goBack();
							await page.waitForURL(
								(url) => url.pathname === "/admin/organization",
							);
							await settings
								.getByRole("link", { name: "Activity log", exact: true })
								.click();
							await page.waitForURL((url) => url.pathname === "/audit");
							await page.goBack();
							await page.waitForURL(
								(url) => url.pathname === "/admin/organization",
							);
							await settings.evaluate((nav) => {
								nav.scrollLeft = 0;
								nav.scrollTop = 0;
							});
							await page.goForward();
							await page.waitForURL((url) => url.pathname === "/audit");
							await page.waitForFunction(() => {
								const nav = document.querySelector(
									'nav[aria-label="Settings sections"]',
								)!;
								const link = nav.querySelector<HTMLAnchorElement>(
									"[data-settings-active]",
								)!;
								const r = link.getBoundingClientRect();
								const bounds = nav.getBoundingClientRect();
								return (
									link.getAttribute("href") === "/audit" &&
									r.left >= bounds.left - 1 &&
									r.right <= bounds.right + 1 &&
									r.top >= bounds.top - 1 &&
									r.bottom <= bounds.bottom + 1
								);
							});
							results.push({ name, pathnameNavigation: await geometry(page) });
						}
					} else {
						await page.goto(
							`${origin}/admin/organization#organization-authentication`,
						);
						await page.locator(railSelector).waitFor();
						await atTarget(page, "organization-authentication");
						assert(
							readStarted,
							"Delayed local profile section GET was not exercised",
						);
						const before = await geometry(page);
						if (scenario !== "restore-history") {
							// Browser input is trusted; no dispatchEvent or mocked listeners.
							const point = await page.locator(railSelector).boundingBox();
							assert(point);
							if (scenario === "wheel") {
								await page.mouse.move(
									point.x + point.width / 2,
									point.y + point.height + 30,
								);
								await page.mouse.wheel(0, -500);
							} else if (scenario === "touch") {
								await page.touchscreen.tap(
									point.x + point.width / 2,
									point.y + point.height + 30,
								);
							} else {
								await page.locator(`${railSelector} a`).first().focus();
								await page.keyboard.press("ArrowUp");
							}
							await page.locator(railSelector).evaluate((rail) => {
								rail.closest<HTMLElement>('[data-slot="page"]')!.scrollTop = 0;
							});
						}
						const contentResponse = page.waitForResponse((response) =>
							new URL(response.url()).pathname.endsWith(
								"/organization-profile-form.tsx",
							),
						);
						release();
						await contentResponse;
						await page
							.getByRole("heading", {
								name: "Organization profile",
								exact: true,
							})
							.waitFor();
						await page.getByText("Plan features", { exact: true }).waitFor();
						await page.evaluate(() => document.fonts.ready);
						if (scenario === "restore-history") {
							await atTarget(page, "organization-authentication");
							await currentIs(page, "organization-authentication");
							const state = await assertRail(page, viewport.width < 600);
							assert.equal(state.theme, theme);
							assert.equal(state.windowY, 0, JSON.stringify(state));
							assert(state.root.scrollTop > 0);
							assert(
								state.root.scrollHeight > before.root.scrollHeight + 100,
								"Delayed real content did not exercise layout growth",
							);
							results.push({ name, before, restored: state });
							await setHash(page, "organization-appearance");
							await atTarget(page, "organization-appearance");
							await setHash(page, "organization-billing");
							await page.goBack();
							await currentIs(page, "organization-appearance");
							await page.goForward();
							await currentIs(page, "organization-billing");
							await keyboardRail(page);
							await page.keyboard.press("ArrowUp");
							await page.locator(railSelector).evaluate((rail) => {
								rail.closest<HTMLElement>('[data-slot="page"]')!.scrollTop = 0;
							});
							await currentIs(page, "organization-profile");
							await page.locator(railSelector).evaluate((rail) => {
								const root = rail.closest<HTMLElement>('[data-slot="page"]')!;
								root.scrollTop = root.scrollHeight;
							});
							const last = await page
								.locator(`${railSelector} a[data-section-target]`)
								.last()
								.getAttribute("data-section-target");
							await currentIs(page, last!);
							const end = await geometry(page);
							assert(
								end.root.scrollTop + end.root.clientHeight >=
									end.root.scrollHeight - 12,
							);
							assert.equal(end.windowY, 0);
							results.push({ name, scrollEnd: end });
						} else {
							// Observe through the complete product restoration window. A late
							// response must not pull the user back to the original hash.
							await page.waitForTimeout(3200);
							const state = await geometry(page);
							assert(state.root.scrollTop <= 3, JSON.stringify(state));
							await currentIs(page, "organization-profile");
							assert.equal(state.hash, "#organization-authentication");
							assert.equal(state.windowY, 0);
							results.push({ name, before, cancelled: state });
						}
					}
					console.log(`PASS ${name}`);
				} catch (error) {
					failures++;
					results.push({
						name,
						error: error instanceof Error ? error.stack : String(error),
						geometry: await geometry(page).catch(String),
					});
					console.error(`FAIL ${name}: ${error}`);
				} finally {
					release();
					const screenshot = await page.screenshot({
						path: `${evidence}/${name}.png`,
					});
					assert.equal(screenshot.toString("ascii", 1, 4), "PNG");
					assert.equal(screenshot.readUInt32BE(16), viewport.width);
					assert.equal(screenshot.readUInt32BE(20), viewport.height);
					results.push({
						name,
						consoleEntries,
						requests,
						readStarted,
						readFinished,
						isMobile: viewport.width < 600,
						hasTouch: viewport.width < 600 || scenario === "touch",
						screenshot: {
							width: screenshot.readUInt32BE(16),
							height: screenshot.readUInt32BE(20),
						},
					});
					await writeFile(
						`${evidence}/results.json`,
						JSON.stringify(results, null, 2),
					);
					await page.close();
				}
			}
		}
		await browser.close();
		browser = undefined;
	}
} finally {
	await browser?.close();
	if (server.exitCode === null) process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
assert.equal(
	failures,
	0,
	`${failures} settings checks failed; see ${evidence}/results.json`,
);
