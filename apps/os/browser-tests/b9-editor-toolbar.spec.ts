import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { webkit, type Browser } from "playwright";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? "/tmp/tedix-b9-editor-toolbar";
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = String(probe.port!);
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
	{
		cwd: new URL("../", import.meta.url).pathname,
		stdout: "ignore",
		stderr: "inherit",
		detached: true,
	},
);
let browser: Browser | undefined;
const receipts: unknown[] = [];
try {
	for (let attempt = 0; ; attempt++) {
		if (attempt === 120 || server.exitCode !== null)
			throw new Error(
				`Toolbar fixture server unavailable (exit ${server.exitCode})`,
			);
		try {
			if ((await fetch(`${origin}/browser-tests/b9-editor-toolbar.html`)).ok)
				break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await webkit.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 800 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			const phone = viewport.width < 640;
			const page = await browser.newPage({
				viewport,
				deviceScaleFactor: 1,
				isMobile: phone,
				hasTouch: phone,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const consoleEntries: string[] = [];
			const errors: string[] = [];
			page.on("console", (entry) =>
				consoleEntries.push(`${entry.type()}: ${entry.text()}`),
			);
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(
				`${origin}/browser-tests/b9-editor-toolbar.html?theme=${theme}`,
			);
			await page.getByRole("button", { name: "Bold", exact: true }).waitFor();
			await page.evaluate(() => document.fonts.ready);
			const geometry = await page.evaluate(() => {
				const toolbar = document.querySelector<HTMLElement>(
					".output-editor-toolbar",
				)!;
				return {
					viewport: { width: innerWidth, height: innerHeight },
					pageWidth: document.documentElement.scrollWidth,
					toolbar: {
						width: toolbar.clientWidth,
						scrollWidth: toolbar.scrollWidth,
					},
					targets: Array.from(
						toolbar.querySelectorAll<HTMLElement>(
							'button[data-toolbar-control="icon"], [data-toolbar-control="color"], input[type="color"]',
						),
						(element) => {
							const rect = element.getBoundingClientRect();
							return {
								name: element.getAttribute("aria-label") ?? element.title,
								tag: element.tagName,
								width: rect.width,
								height: rect.height,
								y: rect.y,
							};
						},
					),
				};
			});
			const name = `webkit-${viewport.width}x${viewport.height}-${theme}`;
			const screenshot = await page.screenshot({
				path: `${evidence}/${name}.png`,
			});
			assert.equal(screenshot.readUInt32BE(16), viewport.width);
			assert.equal(screenshot.readUInt32BE(20), viewport.height);
			await writeFile(
				`${evidence}/${name}.json`,
				JSON.stringify(
					{ engine: "webkit", theme, geometry, consoleEntries, errors },
					null,
					2,
				),
			);
			assert.deepEqual(geometry.viewport, viewport);
			assert.ok(
				geometry.pageWidth <= viewport.width,
				`Page overflow: ${JSON.stringify(geometry)}`,
			);
			assert.ok(
				geometry.toolbar.scrollWidth > geometry.toolbar.width,
				"Fixture must overflow within toolbar",
			);
			for (const target of geometry.targets) {
				assert.equal(
					target.width,
					phone ? 44 : 28,
					`${name}: ${target.name} width`,
				);
				assert.equal(
					target.height,
					phone ? 44 : 28,
					`${name}: ${target.name} height`,
				);
			}
			assert.equal(
				new Set(geometry.targets.map((target) => target.y)).size,
				1,
				"Disabled and enabled targets align",
			);
			const bold = page.getByRole("button", { name: "Bold", exact: true });
			await bold.focus();
			await page.keyboard.press("Space");
			await page.waitForFunction(
				() =>
					document
						.querySelector('[aria-label="Bold"]')
						?.getAttribute("aria-pressed") === "true",
			);
			assert.equal(await bold.getAttribute("aria-pressed"), "true");
			const activeBackground = await bold.evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			);
			await page.screenshot({ path: `${evidence}/${name}-active.png` });
			await page.keyboard.press("Space");
			await page.waitForFunction(
				() =>
					document
						.querySelector('[aria-label="Bold"]')
						?.getAttribute("aria-pressed") === "false",
			);
			await page.waitForFunction(
				(background) =>
					getComputedStyle(document.querySelector('[aria-label="Bold"]')!)
						.backgroundColor !== background,
				activeBackground,
			);
			await page.screenshot({ path: `${evidence}/${name}-inactive.png` });
			assert.notEqual(
				await bold.evaluate(
					(element) => getComputedStyle(element).backgroundColor,
				),
				activeBackground,
				"Toggle state has visible background",
			);
			await page.keyboard.press("ArrowRight");
			assert.notEqual(
				await page.evaluate(() =>
					document.activeElement?.getAttribute("aria-label"),
				),
				"Bold",
			);
			const color = page.getByLabel("Text color", { exact: true });
			await color.focus();
			assert.equal(
				await color.evaluate((element) => element === document.activeElement),
				true,
			);
			const focusRing = await color.evaluate(
				(element) => getComputedStyle(element.parentElement!).boxShadow,
			);
			assert.notEqual(
				focusRing,
				"none",
				"Transparent colour input needs visible focus on label",
			);
			await color.fill("#13579b");
			assert.equal(
				await page.locator("[data-color-result]").textContent(),
				"#13579b",
			);
			assert.equal(
				await page.getByLabel("Highlight color", { exact: true }).isDisabled(),
				true,
			);
			const select = page.getByRole("combobox", { name: "Paragraph style" });
			await select.focus();
			const labelGeometry = await select.evaluate((element) => {
				const value = element.firstElementChild!;
				return {
					width: element.getBoundingClientRect().width,
					valueWidth: value.clientWidth,
					textWidth: value.scrollWidth,
					label: element.textContent,
				};
			});
			assert.equal(labelGeometry.width, 160);
			assert.ok(labelGeometry.label?.includes("Paragraph"));
			assert.ok(
				labelGeometry.textWidth <= labelGeometry.valueWidth,
				"Select label clipped",
			);
			await page.keyboard.press("Space");
			await page
				.getByRole("option", { name: "Heading", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			await page
				.getByRole("button", { name: "Format 16", exact: true })
				.focus();
			const scroll = await page
				.locator(".output-editor-toolbar")
				.evaluate((element) => ({
					left: element.scrollLeft,
					pageLeft: window.scrollX,
				}));
			assert.ok(scroll.left > 0, "Keyboard focus scrolls the toolbar");
			assert.equal(scroll.pageLeft, 0);
			await page.locator("[data-history-notice]").scrollIntoViewIfNeeded();
			await page.screenshot({ path: `${evidence}/${name}-history.png` });
			assert.deepEqual(errors, []);
			assert.deepEqual(
				consoleEntries.filter((entry) => entry.startsWith("error:")),
				[],
			);
			receipts.push({
				name,
				geometry,
				labelGeometry,
				scroll,
				focusRing,
				consoleEntries,
				errors,
			});
			await page.close();
		}
	}
	await writeFile(
		`${evidence}/receipts.json`,
		JSON.stringify(receipts, null, 2),
	);
	console.log(
		`Passed ${receipts.length} WebKit viewport/theme cases; receipts: ${evidence}`,
	);
} finally {
	await browser?.close();
	if (server.exitCode === null) {
		process.kill(-server.pid, "SIGTERM");
		await server.exited;
	}
}
