import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { webkit, type Page } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const evidence =
	process.env.B13_DOCUMENT_LINK_EVIDENCE_DIR ??
	join(
		process.env.TEDIX_LANE_LOG ? dirname(process.env.TEDIX_LANE_LOG) : "/tmp",
		"b13-document-link-webkit",
	);
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const origin = `http://127.0.0.1:${probe.port}`;
const port = probe.port!;
probe.stop();
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
		cwd,
		stdout: Bun.file(`${evidence}/server.stdout.log`),
		stderr: Bun.file(`${evidence}/server.stderr.log`),
		env: { ...process.env, VITE_LIVE_API: "0" },
	},
);
type Driver = {
	select(text: string): void;
	updateHref(href: string): void;
	disabled(value: boolean): void;
	mount(value: boolean): void;
	replace(): void;
	emit(): void;
	destroy(): void;
	state(): { destroyed: boolean; json: unknown };
};
type FixtureWindow = Window & {
	documentLinkFixture: Driver;
	retiredFixture?: Driver;
};
type Receipt = {
	viewport: { width: number; height: number };
	theme: string;
	checks: { name: string; passed: boolean; error?: string }[];
	measurements: unknown[];
	errors: string[];
	navigation: string[];
};
const receipts: Receipt[] = [];
const popover = (page: Page) =>
	page.getByRole("dialog", { name: "Document link", exact: true });
async function select(page: Page, text: string) {
	await page.evaluate(
		(text) => (window as FixtureWindow).documentLinkFixture.select(text),
		text,
	);
}
async function visible(page: Page) {
	await popover(page).waitFor({ state: "visible" });
	await page.waitForFunction(() => {
		const popup = document.querySelector<HTMLElement>(
			'[role="dialog"][aria-label="Document link"]',
		);
		if (!popup || popup.hasAttribute("data-starting-style")) return false;
		const style = getComputedStyle(popup);
		return (
			(style.scale === "none" || style.scale === "1") && style.opacity === "1"
		);
	});
}
async function hidden(page: Page) {
	await popover(page).waitFor({ state: "hidden" });
}
async function capture(page: Page, receipt: Receipt, name: string) {
	const path = `${evidence}/${receipt.viewport.width}-${receipt.viewport.height}-${receipt.theme}-${name}.png`;
	const png = await page.screenshot({ path });
	assert.equal(png.readUInt32BE(16), receipt.viewport.width);
	assert.equal(png.readUInt32BE(20), receipt.viewport.height);
	receipt.measurements.push({
		screenshot: path,
		width: png.readUInt32BE(16),
		height: png.readUInt32BE(20),
	});
}
async function geometry(page: Page, receipt: Receipt) {
	const measurements = await page.evaluate(() => {
		const popup = document.querySelector<HTMLElement>(
			'[role="dialog"][aria-label="Document link"]',
		)!;
		const anchor = document.querySelector<HTMLElement>(".tiptap a")!;
		const bounds = (element: Element) => {
			const { x, y, width, height, right, bottom } =
				element.getBoundingClientRect();
			return { x, y, width, height, right, bottom };
		};
		return {
			viewport: { width: innerWidth, height: innerHeight },
			mode: document.documentElement.dataset.mode,
			dark: document.documentElement.classList.contains("dark"),
			colorScheme: getComputedStyle(document.documentElement).colorScheme,
			background: getComputedStyle(document.body).backgroundColor,
			foreground: getComputedStyle(popup).color,
			overflow: {
				document: document.documentElement.scrollWidth,
				body: document.body.scrollWidth,
				popup: popup.scrollWidth,
				client: popup.clientWidth,
			},
			anchor: bounds(anchor),
			popup: bounds(popup),
			anchorOwned: Boolean(anchor.closest(".tiptap")),
			focus: {
				editor: document.activeElement?.classList.contains("tiptap"),
				tag: document.activeElement?.tagName,
			},
			controls: Array.from(popup.querySelectorAll<HTMLElement>("a,button")).map(
				(element) => ({
					text: element.textContent,
					bounds: bounds(element),
					disabled: element.matches(":disabled"),
					tabIndex: element.tabIndex,
				}),
			),
		};
	});
	receipt.measurements.push(measurements);
	assert.deepEqual(measurements.viewport, receipt.viewport);
	assert.equal(measurements.mode, receipt.theme);
	assert.equal(measurements.dark, receipt.theme === "dark");
	assert.equal(measurements.colorScheme, receipt.theme);
	assert.equal(
		measurements.background,
		receipt.theme === "dark" ? "rgb(3, 3, 3)" : "rgb(251, 251, 251)",
	);
	assert(measurements.anchorOwned);
	assert(measurements.focus.editor, "Opening must preserve editor focus");
	assert(
		measurements.overflow.document <= receipt.viewport.width,
		"Document overflows viewport",
	);
	assert(
		measurements.overflow.body <= receipt.viewport.width,
		"Body overflows viewport",
	);
	assert(
		measurements.overflow.popup <= measurements.overflow.client + 1,
		"Popover content overflows",
	);
	for (const [name, box] of [
		["anchor", measurements.anchor],
		["popover", measurements.popup],
	] as const) {
		assert(
			box.width > 0 &&
				box.height > 0 &&
				box.x >= 0 &&
				box.y >= 0 &&
				box.right <= receipt.viewport.width + 1 &&
				box.bottom <= receipt.viewport.height + 1,
			`${name} must fit viewport: ${JSON.stringify(box)}`,
		);
	}
	for (const control of measurements.controls) {
		const box = control.bounds;
		assert(
			box.x >= measurements.popup.x &&
				box.y >= measurements.popup.y &&
				box.right <= measurements.popup.right + 1 &&
				box.bottom <= measurements.popup.bottom + 1,
			`${control.text} must fit popover`,
		);
		if (receipt.viewport.width < 640)
			assert(
				box.width >= 44 && box.height >= 44,
				`${control.text} phone target must be 44×44: ${JSON.stringify(box)}`,
			);
	}
}
let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
let ready = false;
let serverExit: number | undefined;
void server.exited.then((code) => {
	serverExit = code;
});
try {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (serverExit !== undefined)
			throw new Error(
				`Owned Vite server exited before readiness: ${serverExit}`,
			);
		try {
			ready = (
				await fetch(`${origin}/browser-tests/b13-document-link-webkit.html`)
			).ok;
		} catch {
			/* Server is still starting. */
		}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(
		ready,
		"Owned Vite server did not become ready within 90s; see server logs",
	);
	browser = await webkit.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport,
				colorScheme: theme,
				hasTouch: viewport.width < 640,
				reducedMotion: "reduce",
				deviceScaleFactor: 1,
			});
			const receipt: Receipt = {
				viewport,
				theme,
				checks: [],
				measurements: [],
				errors: [],
				navigation: [],
			};
			receipts.push(receipt);
			await context.route("**/*", async (route) => {
				if (new URL(route.request().url()).origin === origin)
					await route.continue();
				else {
					receipt.navigation.push(route.request().url());
					await route.fulfill({
						status: 200,
						contentType: "text/html",
						body: "<title>Intercepted fictional destination</title>",
					});
				}
			});
			const page = await context.newPage();
			page.setDefaultTimeout(5000);
			page.on("console", (message) => {
				if (message.type() === "error" || message.type() === "warning")
					receipt.errors.push(`${message.type()}: ${message.text()}`);
			});
			page.on("pageerror", (error) =>
				receipt.errors.push(`pageerror: ${error.message}`),
			);
			const load = async (href?: string) => {
				await page.goto(
					`${origin}/browser-tests/b13-document-link-webkit.html?theme=${theme}${href === undefined ? "" : `&href=${encodeURIComponent(href)}`}`,
				);
				await page.waitForFunction(() =>
					Boolean((window as FixtureWindow).documentLinkFixture),
				);
				await page.waitForLoadState("networkidle");
				await page.waitForFunction(
					(theme) =>
						getComputedStyle(document.body).backgroundColor ===
						(theme === "dark" ? "rgb(3, 3, 3)" : "rgb(251, 251, 251)"),
					theme,
				);
			};
			const check = async (name: string, test: () => Promise<void>) => {
				try {
					await test();
					receipt.checks.push({ name, passed: true });
				} catch (error) {
					receipt.checks.push({ name, passed: false, error: String(error) });
					await capture(page, receipt, `${name}-failed`).catch((error) =>
						receipt.errors.push(`capture: ${String(error)}`),
					);
				}
			};
			await check("selection-escape-focus", async () => {
				await load();
				await page.locator(".tiptap a").first().click();
				await visible(page);
				assert.equal(
					await popover(page)
						.locator("a")
						.filter({ hasText: /^Open link$/ })
						.getAttribute("href"),
					"https://example.invalid/alpha",
				);
				assert.equal(
					await page
						.locator(".tiptap")
						.evaluate((node) => node === document.activeElement),
					true,
				);
				await page.keyboard.press("Escape");
				await hidden(page);
				await select(page, "Outside");
				await hidden(page);
				await select(page, "Beta guide");
				await visible(page);
				assert.equal(
					await popover(page)
						.locator("a")
						.filter({ hasText: /^Open link$/ })
						.getAttribute("href"),
					"https://example.invalid/beta",
				);
				assert.deepEqual(
					receipt.navigation,
					[],
					"Selecting a link must not navigate",
				);
			});
			await check("geometry", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				await capture(page, receipt, "geometry");
				await geometry(page, receipt);
			});
			await check("long-destination", async () => {
				await load(`https://example.invalid/${"long-guide-".repeat(60)}`);
				await select(page, "Alpha guide");
				await visible(page);
				await capture(page, receipt, "long-destination");
				await geometry(page, receipt);
			});
			await check("keyboard-control-focus", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				for (let tab = 0; tab < 8; tab++) {
					await page.keyboard.press("Tab");
					if (
						await page.evaluate(() =>
							Boolean(
								document.activeElement?.closest('[aria-label="Document link"]'),
							),
						)
					)
						break;
				}
				const focus = await page.evaluate(() => {
					const element = document.activeElement as HTMLElement;
					const style = getComputedStyle(element);
					return {
						text: element.textContent,
						visible: element.matches(":focus-visible"),
						outline: style.outlineStyle,
						outlineWidth: style.outlineWidth,
						shadow: style.boxShadow,
						popup: Boolean(element.closest('[aria-label="Document link"]')),
					};
				});
				receipt.measurements.push({ focus });
				assert(focus.popup, "Tab must reach a popover action");
				assert(
					focus.visible &&
						((focus.outline !== "none" && focus.outlineWidth !== "0px") ||
							focus.shadow !== "none"),
					"Keyboard action needs visible focus",
				);
				await capture(page, receipt, "keyboard-focus");
			});
			await check("href-update", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				await page.evaluate(() =>
					(window as FixtureWindow).documentLinkFixture.updateHref(
						"https://example.invalid/updated",
					),
				);
				assert.equal(
					await page.locator(".tiptap a").first().getAttribute("href"),
					"https://example.invalid/updated",
				);
				await page.waitForFunction(
					() =>
						document
							.querySelector('[aria-label="Document link"] a')
							?.getAttribute("href") === "https://example.invalid/updated",
				);
				assert(
					(await popover(page).textContent())?.includes(
						"https://example.invalid/updated",
					),
					"Destination text must update too",
				);
				await page.evaluate(() =>
					(window as FixtureWindow).documentLinkFixture.updateHref(
						"/relative-updated",
					),
				);
				await page.waitForFunction(() => {
					const popup = document.querySelector('[aria-label="Document link"]');
					return (
						popup?.textContent?.includes("/relative-updated") &&
						!popup.querySelector("a")
					);
				});
				await page.evaluate(() =>
					(window as FixtureWindow).documentLinkFixture.updateHref(
						"https://example.invalid/final",
					),
				);
				await page.waitForFunction(
					() =>
						document
							.querySelector('[aria-label="Document link"] a')
							?.getAttribute("href") === "https://example.invalid/final",
				);
			});
			for (const href of [
				"http://example.invalid/plain",
				"https://example.invalid/secure",
				"mailto:fictional@example.invalid",
				"tel:+12025550123",
				"javascript:void(0)",
				"data:text/html,fictional",
				"/relative-guide",
			]) {
				await check(
					`protocol-${href.split(":")[0]!.replaceAll("/", "")}`,
					async () => {
						await load(href);
						await select(page, "Alpha guide");
						await visible(page);
						const rendered = await page
							.locator(".tiptap a")
							.first()
							.getAttribute("href");
						receipt.measurements.push({
							inputHref: href,
							renderedHref: rendered,
						});
						const open = popover(page)
							.locator("a")
							.filter({ hasText: /^Open link$/ });
						if (/^(http|https|mailto|tel):/.test(href)) {
							assert.equal(await open.getAttribute("href"), href);
							assert.equal(await open.getAttribute("target"), "_blank");
							assert.equal(
								await open.getAttribute("rel"),
								"noopener noreferrer",
							);
						} else
							assert.equal(
								await open.count(),
								0,
								`${href} must have no Open action`,
							);
					},
				);
			}
			await check("explicit-open", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				const [destination] = await Promise.all([
					context.waitForEvent("page", { timeout: 5000 }),
					popover(page)
						.locator("a")
						.filter({ hasText: /^Open link$/ })
						.click(),
				]);
				await destination.waitForLoadState("domcontentloaded");
				assert.equal(destination.url(), "https://example.invalid/alpha");
				assert.equal(await destination.evaluate(() => window.opener), null);
				assert(receipt.navigation.includes("https://example.invalid/alpha"));
				await destination.close();
			});
			await check("disabled-actions", async () => {
				await load();
				await page.evaluate(() =>
					(window as FixtureWindow).documentLinkFixture.disabled(true),
				);
				await select(page, "Alpha guide");
				await visible(page);
				for (const name of ["Edit link", "Remove link"]) {
					const action = popover(page).getByRole("button", {
						name,
						exact: true,
					});
					assert(await action.isDisabled());
					await action.click({ force: true });
				}
				assert.equal(
					await page.getByLabel("Edit callback count").textContent(),
					"0",
				);
				assert.equal(await page.locator(".tiptap a").count(), 2);
				assert.equal(
					await popover(page)
						.locator("a")
						.filter({ hasText: /^Open link$/ })
						.count(),
					1,
				);
				await capture(page, receipt, "disabled");
			});
			await check("edit-callback", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				await popover(page)
					.getByRole("button", { name: "Edit link", exact: true })
					.click();
				await hidden(page);
				assert.equal(
					await page.getByLabel("Edit callback count").textContent(),
					"1",
				);
				assert.equal(await page.locator(".tiptap a").count(), 2);
			});
			await check("remove-intended-link", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				await popover(page)
					.getByRole("button", { name: "Remove link", exact: true })
					.click();
				await hidden(page);
				assert.equal(await page.locator(".tiptap a").count(), 1);
				assert.equal(
					await page.locator(".tiptap a").textContent(),
					"Beta guide",
				);
				assert.equal(
					await page.locator(".tiptap a").getAttribute("href"),
					"https://example.invalid/beta",
				);
				assert(
					(await page.locator(".tiptap").textContent())?.includes(
						"Alpha guide",
					),
				);
			});
			await check("cleanup-replacement", async () => {
				await load();
				await select(page, "Alpha guide");
				await visible(page);
				await page.evaluate(() => {
					const fixture = window as FixtureWindow;
					fixture.retiredFixture = fixture.documentLinkFixture;
					fixture.documentLinkFixture.replace();
				});
				await page.waitForFunction(
					() =>
						(window as FixtureWindow).retiredFixture !==
						(window as FixtureWindow).documentLinkFixture,
				);
				await hidden(page);
				assert.equal(
					await page.evaluate(
						() => (window as FixtureWindow).retiredFixture!.state().destroyed,
					),
					false,
					"Retired editor stays alive to exercise listener cleanup",
				);
				await page.evaluate(() =>
					(window as FixtureWindow).retiredFixture!.emit(),
				);
				await hidden(page);
				await select(page, "Alpha guide");
				await visible(page);
				assert.equal(
					await popover(page)
						.locator("a")
						.filter({ hasText: /^Open link$/ })
						.getAttribute("href"),
					"https://example.invalid/replacement",
				);
				await page.evaluate(() =>
					(window as FixtureWindow).documentLinkFixture.mount(false),
				);
				await hidden(page);
				await select(page, "Outside");
				await page.evaluate(() =>
					(window as FixtureWindow).documentLinkFixture.mount(true),
				);
				await hidden(page);
				await select(page, "Beta guide");
				await visible(page);
				await page.evaluate(() =>
					(window as FixtureWindow).retiredFixture!.destroy(),
				);
				assert.equal(
					await popover(page)
						.locator("a")
						.filter({ hasText: /^Open link$/ })
						.getAttribute("href"),
					"https://example.invalid/beta",
				);
			});
			await check("console-page-errors", async () =>
				assert.deepEqual(receipt.errors, []),
			);
			await writeFile(
				`${evidence}/results.json`,
				JSON.stringify(
					{ engine: "webkit", version: browser.version(), origin, receipts },
					null,
					2,
				),
			);
			await context.close();
		}
	}
} finally {
	await browser?.close();
	server.kill("SIGTERM");
	const exit = await Promise.race([
		server.exited,
		Bun.sleep(5000).then(() => undefined),
	]);
	if (exit === undefined) server.kill("SIGKILL");
	await writeFile(
		`${evidence}/server.json`,
		JSON.stringify(
			{ origin, pid: server.pid, ready, exit: await server.exited },
			null,
			2,
		),
	);
}
const failures = receipts.flatMap((receipt) =>
	receipt.checks
		.filter((check) => !check.passed)
		.map((check) => ({
			viewport: receipt.viewport,
			theme: receipt.theme,
			...check,
		})),
);
console.log(
	JSON.stringify(
		{
			matrices: receipts.length,
			checks: receipts.reduce(
				(count, receipt) => count + receipt.checks.length,
				0,
			),
			failures,
			evidence,
		},
		null,
		2,
	),
);
assert.equal(receipts.length, 6, "Complete viewport/theme matrix required");
assert.equal(
	failures.length,
	0,
	"Real-editor WebKit failures retained in lane evidence directory",
);
