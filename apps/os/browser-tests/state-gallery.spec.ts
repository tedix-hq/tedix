import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, type Browser, type Page } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const screenshots =
	process.env.STATE_GALLERY_SCREENSHOTS ?? "/tmp/ui-state-gallery-screenshots";
const probe = createServer();
await new Promise<void>((resolve, reject) => {
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", resolve);
});
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve, reject) =>
	probe.close((error) => (error ? reject(error) : resolve())),
);
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

// Runs in the page, on real computed CSS, including inherited and translucent colors.
async function audit(page: Page) {
	return page.evaluate(() => {
		type Color = [number, number, number, number];
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
		const color = (value: string): Color => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = value;
			ctx.fillRect(0, 0, 1, 1);
			const pixel = ctx.getImageData(0, 0, 1, 1).data;
			return [
				pixel[0]! / 255,
				pixel[1]! / 255,
				pixel[2]! / 255,
				pixel[3]! / 255,
			];
		};
		const over = (fg: Color, bg: Color): Color => [
			fg[0] * fg[3] + bg[0] * (1 - fg[3]),
			fg[1] * fg[3] + bg[1] * (1 - fg[3]),
			fg[2] * fg[3] + bg[2] * (1 - fg[3]),
			1,
		];
		const luminance = (rgb: Color) => {
			const channels = rgb
				.slice(0, 3)
				.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
			return (
				channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
			);
		};
		const visible = (el: Element) => {
			const css = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return (
				css.visibility !== "hidden" &&
				css.display !== "none" &&
				Number(css.opacity) > 0 &&
				rect.width > 1 &&
				rect.height > 1 &&
				!el.closest(".sr-only, [hidden]")
			);
		};
		const selector = (el: Element): string => {
			if (el.id) return `#${el.id}`;
			const parent = el.parentElement;
			return parent
				? `${selector(parent)} > ${el.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(el) + 1})`
				: el.tagName.toLowerCase();
		};
		const offenders: string[] = [];
		const missingText: string[] = [];
		let checked = 0;
		for (const frame of document.querySelectorAll("[data-state-frame]")) {
			const content = frame.querySelector("[data-state-content]")!;
			const textElements = Array.from(frame.querySelectorAll("*")).filter(
				(el) =>
					visible(el) &&
					Array.from(el.childNodes).some(
						(node) =>
							node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
					),
			);
			if (!visible(content) || !textElements.some((el) => content.contains(el)))
				missingText.push(selector(frame));
			for (const el of [
				...textElements,
				...Array.from(
					content.querySelectorAll(
						"svg path, svg circle, svg rect, svg line, svg polyline, svg polygon",
					),
				).filter(visible),
			]) {
				const ancestors: Element[] = [];
				for (let node: Element | null = el; node; node = node.parentElement)
					ancestors.unshift(node);
				let background: Color = [1, 1, 1, 1];
				let opacity = 1;
				for (const ancestor of ancestors) {
					const css = getComputedStyle(ancestor);
					background = over(color(css.backgroundColor), background);
					opacity *= Number(css.opacity);
				}
				const css = getComputedStyle(el);
				const icon = el instanceof SVGElement;
				const paint = icon
					? css.fill !== "none"
						? css.fill
						: css.stroke
					: css.color;
				if (paint === "none") continue;
				const ink = color(
					paint.toLowerCase() === "currentcolor" ? css.color : paint,
				);
				ink[3] *=
					opacity *
					(icon
						? Number(css.fill !== "none" ? css.fillOpacity : css.strokeOpacity)
						: 1);
				const fg = luminance(over(ink, background));
				const bg = luminance(background);
				const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
				const large =
					parseFloat(css.fontSize) >= 24 ||
					(parseFloat(css.fontSize) >= 18.6667 &&
						Number(css.fontWeight) >= 700);
				const threshold = icon || large ? 3 : 4.5;
				checked++;
				if (ratio < threshold)
					offenders.push(
						`${selector(el)}: ${ratio.toFixed(2)}:1 (requires ${threshold}:1)`,
					);
			}
		}
		return { missingText, offenders, checked };
	});
}

let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			ready = (await fetch(`${origin}/browser-tests/state-gallery.html`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Vite serves the gallery");
	await mkdir(screenshots, { recursive: true });
	browser = await chromium.launch({ headless: true });
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
				locale: "en-GB",
				timezoneId: "UTC",
			});
			await page.clock.install({ time: new Date("2026-01-15T09:00:00Z") });
			await page.clock.pauseAt(new Date("2026-01-15T09:00:00Z"));
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.goto(
				`${origin}/browser-tests/state-gallery.html?theme=${theme}`,
			);
			await page.locator("[data-state-frame]").last().waitFor();
			await page.addStyleTag({
				content:
					"*, *::before, *::after { transition: none !important; animation: none !important; }",
			});
			await page.evaluate(() => document.fonts.ready);
			assert.equal(await page.locator("[data-state-frame]").count(), 28);
			for (const surface of [
				"feed",
				"deck",
				"connections",
				"team",
				"skills",
				"memory",
				"chat",
			])
				for (const state of ["empty", "loading", "error", "partial"]) {
					assert(
						await page.locator(`#${surface}-${state}`).isVisible(),
						`${surface}/${state} is visible`,
					);
				}
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${width}/${theme}: no horizontal overflow`,
			);
			const result = await audit(page);
			assert.deepEqual(
				result.missingText,
				[],
				"Every state branch has visible text beyond its heading",
			);
			assert(result.checked > 100, "Audit covers text and icons in all frames");
			assert.deepEqual(
				result.offenders,
				[],
				`${width}/${theme} contrast offenders`,
			);
			assert.deepEqual(errors, [], "Gallery renders without runtime errors");
			const screenshot = await page.screenshot({
				path: `${screenshots}/state-gallery-${width}-${theme}.png`,
				fullPage: true,
				animations: "disabled",
			});

			await page.reload();
			await page.locator("#chat-partial").waitFor();
			await page.addStyleTag({
				content:
					"*, *::before, *::after { transition: none !important; animation: none !important; }",
			});
			await page.evaluate(() => document.fonts.ready);
			assert(
				(
					await page.screenshot({ fullPage: true, animations: "disabled" })
				).equals(screenshot),
				"Fixed data and clock reproduce the same screenshot after reload",
			);

			// Negative controls prove a blank state and low-contrast text/icon fail the gate.
			await page
				.locator("#feed-empty [data-state-content]")
				.evaluate((el) => ((el as HTMLElement).style.visibility = "hidden"));

			const hidden = await audit(page);
			assert(
				hidden.missingText.some((selector) =>
					selector.startsWith("#feed-empty"),
				),
				JSON.stringify(hidden),
			);
			await page
				.locator("#feed-empty [data-state-content]")
				.evaluate((el) =>
					(el as HTMLElement).style.removeProperty("visibility"),
				);
			const title = page.locator("#team-empty [data-slot=empty-title]");
			await title.evaluate((el) => {
				(el as HTMLElement).style.color = "rgb(128,128,128)";
				(el as HTMLElement).style.backgroundColor = "rgb(128,128,128)";
			});
			assert(
				(await audit(page)).offenders.some(
					(offender) =>
						offender.includes("#team-empty") && offender.includes("1.00:1"),
				),
			);
			await title.evaluate((el) => el.removeAttribute("style"));
			const icon = page.locator("#team-empty svg");
			await icon.evaluate((el) => {
				el.style.color = "rgb(128,128,128)";
				el.style.backgroundColor = "rgb(128,128,128)";
			});
			assert(
				(await audit(page)).offenders.some(
					(offender) =>
						offender.includes("svg") && offender.includes("requires 3:1"),
				),
			);
			await icon.evaluate((el) => el.removeAttribute("style"));
			for (const surface of [
				"feed",
				"deck",
				"connections",
				"team",
				"skills",
				"memory",
				"chat",
			]) {
				const frame = page.locator(`#${surface}-error`);
				await frame
					.getByRole("button", { name: "Try again", exact: true })
					.click();
				assert(
					await frame
						.getByText("Retry requested (1)", { exact: true })
						.isVisible(),
				);
			}
			await page.close();
			console.log(
				`State gallery passed: ${width}/${theme}, ${result.checked} contrast checks`,
			);
		}
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
