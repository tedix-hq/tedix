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

async function measure(scope: Locator) {
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
	await page.screenshot({ path: `${evidence}/${name}.png` });
}

try {
	browser = await webkit.launch({ headless: true });
	const viewport = { width: 375, height: 667 };
	const theme = "dark";
	const context = await browser.newContext({
		viewport,
		colorScheme: theme,
		hasTouch: true,
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
	let reply: { message?: string; release: Promise<void> };
	await context.route(
		"**/api/rpc/osWorkspaces/outputs/export",
		async (route) => {
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
			const { message, release } = reply;
			await release;
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
		},
	);
	await context.route(/^https?:\/\/(?!127\.0\.0\.1:)/, (route) =>
		route.abort(),
	);
	await page.goto(
		`${origin}/browser-tests/b9-export-phone.html?theme=${theme}`,
	);
	for (const [variant, results] of [
		["compact", [token, undefined]],
		["normal", [spaced]],
	] as const) {
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
			"PDF with title and revision",
		]);
		await menu.and(page.locator(":focus-within")).waitFor();
		for (const item of await menu.getByRole("menuitem").all()) {
			const box = (await item.boundingBox())!;
			receipts.push({ label, menuTarget: box });
			assert(box.height >= 44 && box.width >= 44, "44px menu target");
		}
		await capture(page, `${label}-menu`);
		await page.keyboard.press("Escape");
		await trigger.and(page.locator(":focus")).waitFor();
		assert(
			await trigger.evaluate(
				(el) =>
					el.matches(":focus-visible") &&
					getComputedStyle(el).boxShadow !== "none",
			),
			"visible keyboard focus",
		);
		for (const message of results) {
			const before = calls;
			const held = Promise.withResolvers<void>();
			reply = { message, release: held.promise };
			await trigger.click();
			await Promise.all([
				page.waitForRequest("**/api/rpc/osWorkspaces/outputs/export"),
				page.getByRole("menuitem", { name: "PDF", exact: true }).click(),
			]);
			const pending = scope.getByRole("button", {
				name: "Exporting PDF",
				exact: true,
			});
			try {
				await pending.and(page.locator(":disabled")).waitFor();
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
				await measure(scope);
				await capture(page, `${label}-pending`);
			} finally {
				held.resolve();
			}
			await trigger.and(page.locator(":enabled")).waitFor();
			assert.equal(calls, before + 1, "one mutation while pending");
			if (message) {
				const alert = scope.getByRole("alert");
				await alert.waitFor();
				assert.equal(await alert.textContent(), `Export failed: ${message}`);
				await alert.scrollIntoViewIfNeeded();
				await capture(
					page,
					`${label}-${message === spaced ? "spaced" : "token"}`,
				);
				await measure(scope);
			} else assert.equal(await scope.getByRole("alert").count(), 0);
		}
	}
	assert.equal(calls, 3, "one request per explicit attempt");
	assert.deepEqual(
		await page.evaluate(
			() => (window as unknown as { downloads: unknown[] }).downloads,
		),
		[
			{
				href: `${origin}/api/os-exports/fixture/rev-2.pdf?fixture=1`,
				download: "rev-2.pdf",
			},
		],
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
	console.log(
		"PASS: real export controls wrap diagnostics, retain focus and 44px phone targets, and allow only explicit retries with one inert proxy download (WebKit phone)",
	);
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify(receipts, null, 2),
	);
	await browser?.close();
	await server.stop();
}
