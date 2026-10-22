import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { webkit, type Browser, type Page, type Locator } from "playwright";

const evidence =
	process.env.B9_EXPORT_PHONE_EVIDENCE ?? "/tmp/tedix-b9-export-phone-errors";
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer("/browser-tests/b9-export-phone.html");
const { origin } = server;
const spaced =
	"The export could not finish because the source image is unavailable. Check the document resources and choose Export again to retry this format.";
const token = `diagnostic_${"0123456789abcdef".repeat(12)}`;
const receipts: unknown[] = [];
let browser: Browser | undefined;

async function until(check: () => Promise<boolean>, message: string) {
	for (let i = 0; i < 100; i++) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	throw new Error(message);
}
async function measure(page: Page, scope: Locator, phone: boolean) {
	const result = await scope.evaluate((el) => {
		const trigger = el.querySelector<HTMLButtonElement>(
			'button[aria-haspopup="menu"]',
		)!;
		const alert = el.querySelector<HTMLElement>('[role="alert"]');
		const box = trigger.getBoundingClientRect();
		const diagnostic = alert?.getBoundingClientRect();
		return {
			viewport: { width: innerWidth, height: innerHeight },
			theme: document.documentElement.dataset.mode,
			pageWidth: document.documentElement.scrollWidth,
			trigger: {
				width: box.width,
				height: box.height,
				left: box.left,
				right: box.right,
			},
			alert:
				alert && diagnostic
					? {
							text: alert.textContent,
							width: diagnostic.width,
							height: diagnostic.height,
							left: diagnostic.left,
							right: diagnostic.right,
							scrollWidth: alert.scrollWidth,
							clientWidth: alert.clientWidth,
							overflow: getComputedStyle(alert).overflow,
							whiteSpace: getComputedStyle(alert).whiteSpace,
						}
					: null,
		};
	});
	receipts.push(result);
	assert(
		result.pageWidth <= result.viewport.width,
		`page overflow: ${JSON.stringify(result)}`,
	);
	assert(
		result.trigger.left >= 0 && result.trigger.right <= result.viewport.width,
	);
	if (phone)
		assert(
			result.trigger.width >= 44 && result.trigger.height >= 44,
			"44px trigger",
		);
	if (result.alert) {
		assert(
			result.alert.left >= 0 && result.alert.right <= result.viewport.width,
			"diagnostic within viewport",
		);
		assert(
			result.alert.scrollWidth <= result.alert.clientWidth + 1,
			"diagnostic wraps fully",
		);
		assert.equal(result.alert.overflow, "visible");
		assert.notEqual(result.alert.whiteSpace, "nowrap");
	}
}
async function capture(page: Page, name: string) {
	const png = await page.screenshot({ path: `${evidence}/${name}.png` });
	const viewport = page.viewportSize()!;
	assert.equal(png.readUInt32BE(16), viewport.width);
	assert.equal(png.readUInt32BE(20), viewport.height);
}

try {
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
			});
			const page = await context.newPage();
			const consoleEntries: string[] = [];
			receipts.push({ viewport, theme, engine: "webkit", consoleEntries });
			page.on("console", (entry) =>
				consoleEntries.push(`${entry.type()}: ${entry.text()}`),
			);
			page.on("pageerror", (error) =>
				consoleEntries.push(`pageerror: ${error.message}`),
			);
			await page.addInitScript(() => {
				(window as unknown as { downloads: unknown[] }).downloads = [];
				HTMLAnchorElement.prototype.click = function () {
					(window as unknown as { downloads: unknown[] }).downloads.push({
						href: this.href,
						download: this.download,
					});
				};
			});
			let calls = 0;
			let finish: ((message?: string) => Promise<void>) | undefined;
			await context.route("**/api/**", async (route) => {
				assert.equal(
					new URL(route.request().url()).pathname,
					"/api/rpc/osWorkspaces/outputs/export",
				);
				assert.equal(route.request().method(), "POST");
				assert.deepEqual(route.request().postDataJSON(), {
					json: {
						outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						format: "pdf",
					},
				});
				calls++;
				await new Promise<void>((resolve) => {
					finish = async (message) => {
						await route.fulfill(
							message
								? {
										status: 500,
										json: {
											json: {
												defined: false,
												code: "INTERNAL_SERVER_ERROR",
												message,
											},
										},
									}
								: {
										json: {
											json: {
												key: "fixture/rev-2.pdf",
												format: "pdf",
												revision: 2,
												sizeBytes: 0,
												url: "https://api.example.test/os-exports/fixture/rev-2.pdf?fixture=1",
											},
										},
									},
						);
						finish = undefined;
						resolve();
					};
				});
			});
			await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/, (route) =>
				route.abort(),
			);
			await page.goto(
				`${origin}/browser-tests/b9-export-phone.html?theme=${theme}`,
			);
			for (const variant of ["compact", "normal"]) {
				const label = `${viewport.width}x${viewport.height}-${theme}-${variant}`;
				const scope = page.locator(`[data-variant="${variant}"]`);
				const trigger = scope.getByRole("button", {
					name: "Export",
					exact: true,
				});
				await trigger.focus();
				await page.keyboard.press("ArrowDown");
				const menu = page.getByRole("menu");
				await menu.waitFor();
				assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
					"PDF",
					"PNG",
					"Document (.docx)",
					"Markdown (.md)",
					"HTML (.html)",
				]);
				await until(
					() => menu.evaluate((el) => el.contains(document.activeElement)),
					"menu receives focus",
				);
				if (viewport.width < 640)
					for (const item of await menu.getByRole("menuitem").all()) {
						const box = (await item.boundingBox())!;
						receipts.push({ label, menuTarget: box });
						assert(box.height >= 44 && box.width >= 44, "44px menu target");
					}
				await capture(page, `${label}-menu`);
				await page.keyboard.press("Escape");
				await until(
					() => trigger.evaluate((el) => document.activeElement === el),
					"focus returns to trigger",
				);
				assert(
					await trigger.evaluate(
						(el) =>
							el.matches(":focus-visible") &&
							getComputedStyle(el).boxShadow !== "none",
					),
					"visible keyboard focus",
				);
				for (const message of [spaced, token, undefined]) {
					const before = calls;
					await trigger.click();
					await page
						.getByRole("menuitem", { name: "PDF", exact: true })
						.click();
					await until(
						async () => calls === before + 1 && Boolean(finish),
						"one mock export starts",
					);
					const pending = scope.getByRole("button", {
						name: "Exporting PDF",
						exact: true,
					});
					assert(await pending.isDisabled());
					assert.equal(await pending.getAttribute("aria-busy"), "true");
					assert.equal(
						await scope.getByRole("status").textContent(),
						"Exporting PDF",
					);
					assert.equal(await scope.getByRole("alert").count(), 0);
					await pending.evaluate((el: HTMLButtonElement) => {
						el.click();
						el.click();
					});
					await page.waitForTimeout(100);
					assert.equal(calls, before + 1, "one mutation while pending");
					await measure(page, scope, viewport.width < 640);
					await capture(page, `${label}-pending`);
					await finish!(message);
					await until(() => trigger.isEnabled(), "export settles");
					if (message) {
						const alert = scope.getByRole("alert");
						await alert.waitFor();
						assert.equal(
							await alert.textContent(),
							`Export failed: ${message}`,
						);
						await alert.scrollIntoViewIfNeeded();
						await capture(
							page,
							`${label}-${message === spaced ? "spaced" : "token"}`,
						);
						await measure(page, scope, viewport.width < 640);
					} else assert.equal(await scope.getByRole("alert").count(), 0);
				}
			}
			assert.equal(calls, 6, "three explicit requests per variant");
			assert.deepEqual(
				await page.evaluate(
					() => (window as unknown as { downloads: unknown[] }).downloads,
				),
				Array.from({ length: 2 }, () => ({
					href: `${origin}/api/os-exports/fixture/rev-2.pdf?fixture=1`,
					download: "rev-2.pdf",
				})),
			);
			receipts.push({
				viewport,
				theme,
				engine: "webkit",
				calls,
				consoleEntries,
			});
			assert(
				!consoleEntries.some((line) => line.startsWith("pageerror:")),
				consoleEntries.join("\n"),
			);
			await context.close();
		}
	}
	console.log(
		"PASS: real export controls wrap diagnostics, retain focus and 44px phone targets, and allow only explicit retries with inert proxy downloads (WebKit, 6 viewport/theme combinations)",
	);
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify(receipts, null, 2),
	);
	await browser?.close();
	await server.stop();
}
