import assert from "node:assert/strict";
import { chromium } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
const browser = await chromium.launch({ headless: true });
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		if (i === 99) throw new Error("Avatar fixture did not start");
		await Bun.sleep(200);
	}
	const page = await browser.newPage();
	await page.goto(`${origin}/browser-tests/entity-avatar.html`);
	await page.locator("[data-avatar-palette]").last().waitFor();
	for (const dark of [false, true]) {
		for (const palette of [
			null,
			{ background: "#fff8e7", foreground: "#352614" },
			{ background: "#18212f", foreground: "#e2e9f4" },
			{ background: "#777777", foreground: "#000000" },
		]) {
			const ratios = await page.evaluate(
				({ dark, palette }) => {
					const root = document.documentElement;
					root.classList.toggle("dark", dark);
					root.dataset.mode = dark ? "dark" : "light";
					root.dataset.theme = "tedix";
					for (const key of ["background", "foreground"] as const) {
						if (palette) root.style.setProperty(`--${key}`, palette[key]);
						else root.style.removeProperty(`--${key}`);
					}
					const canvas = document.createElement("canvas");
					canvas.width = canvas.height = 1;
					const ctx = canvas.getContext("2d")!;
					const luminance = (color: string) => {
						ctx.fillStyle = color;
						ctx.fillRect(0, 0, 1, 1);
						const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data)
							.slice(0, 3)
							.map((value) => {
								const channel = value / 255;
								return channel <= 0.04045
									? channel / 12.92
									: ((channel + 0.055) / 1.055) ** 2.4;
							});
						return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
					};
					return Array.from(
						document.querySelectorAll("[data-avatar-palette]"),
						(el) => {
							const style = getComputedStyle(el);
							const bg = luminance(style.backgroundColor),
								fg = luminance(style.color);
							return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
						},
					);
				},
				{ dark, palette },
			);
			assert.equal(ratios.length, 11);
			for (const ratio of ratios)
				assert.ok(ratio >= 4.5, `Avatar contrast ${ratio} below AA`);
			const portraits = await page
				.locator('[data-entity-kind="tedi"]')
				.evaluateAll((elements) =>
					elements.map((element) => {
						const style = getComputedStyle(element);
						return [style.backgroundColor, style.color];
					}),
				);
			assert.deepEqual(
				portraits[0],
				portraits[1],
				"Feed and Team must use the same tedi colors",
			);
		}
	}
	console.log(
		"PASS: all nine avatar tints meet 4.5:1 in light, dark and custom organization palettes",
	);
} finally {
	await browser.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
	await server.exited;
}
