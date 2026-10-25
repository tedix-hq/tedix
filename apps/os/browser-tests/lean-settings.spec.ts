import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit } from "playwright";

const evidence = process.env.SETTINGS_EVIDENCE_DIR ?? "/tmp/lean-settings";
const before = process.env.SETTINGS_CAPTURE_BEFORE === "1";
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
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
const browser = await webkit.launch();
try {
	for (let i = 0; ; i++) {
		if (i === 180 || server.exitCode !== null)
			throw new Error("Fixture server unavailable");
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(500);
	}
	for (const viewport of [
		{ width: 320, height: 568 },
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport,
				colorScheme: theme,
				isMobile: viewport.width < 600,
				hasTouch: viewport.width < 600,
				reducedMotion: "reduce",
			});
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== origin) return route.abort();
				if (url.pathname.endsWith("/userSettings/getPreferences")) {
					const response = await route.fetch();
					const body = await response.json();
					body.json.preferences.theme = theme;
					return route.fulfill({ response, json: body });
				}
				return route.continue();
			});
			for (const path of [
				"/account/settings",
				"/admin",
				"/admin/organization",
			]) {
				await page.goto(`${origin}${path}`);
				await page.locator('.route-content [data-slot="page"]').waitFor();
				await page.evaluate(() => document.fonts.ready);
				if (path === "/account/settings")
					await page
						.getByRole("group", { name: "Appearance", exact: true })
						.waitFor();
				if (path === "/admin/organization")
					await page
						.getByRole("heading", { name: "Organization profile", exact: true })
						.waitFor();
				assert.equal(
					await page.locator("html").getAttribute("data-mode"),
					theme,
				);
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth + 1,
					),
				);
				const name = `${viewport.width}-${theme}-${path.replaceAll("/", "-")}`;
				await page.screenshot({
					path: `${evidence}/${before ? "before" : "after"}${name}.png`,
				});
				if (!before && path === "/account/settings") {
					const rows = page.locator('[data-slot="setting-row"]');
					for (const row of await rows.all()) {
						await row.scrollIntoViewIfNeeded();
						const geometry = await row.evaluate((el) => {
							const r = el.getBoundingClientRect();
							const title = el
								.querySelector('[data-slot="setting-row-title"]')!
								.getBoundingClientRect();
							const control = el.querySelector(
								'[data-slot="setting-row-control"]',
							);
							const c = control?.getBoundingClientRect();
							return {
								right: r.right,
								left: r.left,
								scroll: el.scrollWidth,
								width: el.clientWidth,
								title: title.left,
								control: c && { left: c.left, right: c.right },
							};
						});
						assert(
							geometry.scroll <= geometry.width + 1,
							JSON.stringify(geometry),
						);
						assert(
							geometry.right <= viewport.width + 1,
							JSON.stringify(geometry),
						);
						if (viewport.width < 600 && geometry.control)
							assert(
								Math.abs(geometry.title - geometry.control.left) < 2,
								JSON.stringify(geometry),
							);
					}
					for (const label of ["Language", "Time zone"]) {
						const trigger = page.getByRole("combobox", {
							name: label,
							exact: true,
						});
						await trigger.scrollIntoViewIfNeeded();
						await trigger.click();
						const option =
							label === "Language"
								? "English (United Kingdom)"
								: "America/Los_Angeles";
						await page
							.getByRole("option", { name: option, exact: true })
							.click();
						await trigger.focus();
						const focus = await trigger.evaluate((el) => {
							const value = el.firstElementChild as HTMLElement;
							return {
								ring: getComputedStyle(el).boxShadow,
								width: el.clientWidth,
								scroll: el.scrollWidth,
								valueClipped:
									value.scrollWidth > value.clientWidth + 1 ||
									value.scrollHeight > value.clientHeight + 1,
							};
						});
						assert(!focus.valueClipped, JSON.stringify(focus));
						assert(focus.ring !== "none");
						assert(focus.scroll <= focus.width + 1);
					}
					await page.screenshot({
						path: `${evidence}/after${name}-regional.png`,
					});
					const compact = page.getByRole("button", {
						name: "Compact",
						exact: true,
					});
					const nextDensity =
						(await compact.getAttribute("aria-pressed")) === "true"
							? "Comfortable"
							: "Compact";
					await page
						.getByRole("button", { name: nextDensity, exact: true })
						.click();
					await page
						.getByRole("button", { name: "Save preferences", exact: true })
						.click();
					await page.getByText("No unsaved changes", { exact: true }).waitFor();
					await page.reload();
					await page
						.getByRole("button", { name: nextDensity, exact: true })
						.waitFor();
					assert.equal(
						await page
							.getByRole("button", { name: nextDensity, exact: true })
							.getAttribute("aria-pressed"),
						"true",
					);
				}
			}
			await page.close();
			console.log(`PASS ${viewport.width} ${theme}`);
		}
	}
} finally {
	await browser.close();
	if (server.exitCode === null) process.kill(-server.pid, "SIGTERM");
	await server.exited;
}
