import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const output =
	process.env.CARD_DATES_SCREENSHOTS ?? "/tmp/tedix-card-text-dates";
await mkdir(output, { recursive: true });
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
const browser = await webkit.launch({ headless: true });
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		if (i === 99) throw new Error("Date fixture did not start");
		await Bun.sleep(200);
	}
	const page = await browser.newPage();
	for (const [width, height] of [
		[375, 667],
		[390, 844],
		[1280, 900],
	]) {
		await page.setViewportSize({ width: width!, height: height! });
		for (const dark of [false, true]) {
			for (const raw of [true, false]) {
				await page.goto(
					`${origin}/browser-tests/card-text-dates.html?locale=en-US&timezone=America%2FLos_Angeles${raw ? "&raw" : ""}`,
				);
				await page.locator("[data-calendar]").waitFor();
				await page.evaluate((dark) => {
					document.documentElement.classList.toggle("dark", dark);
					document.documentElement.dataset.mode = dark ? "dark" : "light";
				}, dark);
				assert.equal(
					await page.locator("[data-calendar]").textContent(),
					raw
						? "The repository cannot be checked; review it by 2026-10-20."
						: "The repository cannot be checked; review it by Oct 20, 2026.",
				);
				if (!raw) {
					assert.match(
						await page.locator("[data-instant]").innerText(),
						/Oct 19, 2026.*5:30 PM/,
					);
					assert.equal(
						await page.locator("[data-next]").textContent(),
						"Next review: Jan 2, 2027.",
					);
					assert.doesNotMatch(
						await page.locator("main").innerText(),
						/\d{4}-\d{2}-\d{2}/,
					);
				}
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
				);
				await page.screenshot({
					path: `${output}/${raw ? "before" : "after"}-${width}-${dark ? "dark" : "light"}.png`,
				});
			}
		}
	}
	await page.goto(
		`${origin}/browser-tests/card-text-dates.html?locale=de-DE&timezone=Europe%2FBerlin`,
	);
	assert.match(
		await page.locator("[data-calendar]").innerText(),
		/20\. Okt\. 2026/,
	);
	assert.match(
		await page.locator("[data-instant]").innerText(),
		/20\. Okt\. 2026.*2:30/,
	);
	console.log(
		"WebKit card dates: 3 viewports × light/dark × before/after, locale and timezone passed",
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
