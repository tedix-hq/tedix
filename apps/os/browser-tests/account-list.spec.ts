import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * Organization connections and My accounts share one account list. Both pages
 * at phone and desktop width, light and dark: one status per row, the
 * needs-attention reason on the affected row (no page banner), unconnected
 * apps collapsed, identifiers only behind Technical details, no overflow.
 */
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/account-list/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
const backgrounds = new Map<string, string>();
let checks = 0;
try {
	for (const [path, owner] of [
		["/admin/connections", "organization"],
		["/account/connections", "personal"],
	] as const)
		for (const width of [375, 390, 1280])
			for (const theme of ["light", "dark"] as const) {
				const label = `${owner}/${width}/${theme}`;
				const page = await browser.newPage({
					viewport: { width, height: 900 },
					colorScheme: theme,
					reducedMotion: "reduce",
				});
				await page.goto(`${server.origin}${path}`);
				const rows = page.locator(
					'[aria-label="Connected accounts"] > li[data-account-group]',
				);
				await rows.first().waitFor();
				await page.evaluate(() => document.fonts.ready);
				const text = await page.locator("main, body").first().innerText();
				assert.ok(
					!text.includes("Verification incomplete"),
					`${label}: page-level verification banner is gone`,
				);
				assert.ok(
					text.includes(
						"Needs attention: Provider didn't allow a status check",
					),
					`${label}: the unverifiable account says so on its own row`,
				);
				assert.ok(
					text.includes("Available to connect"),
					`${label}: never-connected apps are collapsed`,
				);
				for (const noise of [
					"MCP service not checked",
					"App references",
					"Referenced by",
					"pricewise-official-f9ab445d",
					"Access",
				])
					assert.ok(!text.includes(noise), `${label}: no "${noise}"`);

				// Needs attention sorts before connected.
				const kinds = await rows.evaluateAll((items) =>
					items.map(
						(item) =>
							item
								.querySelector("[data-account-status]")
								?.getAttribute("data-account-status") ?? "",
					),
				);
				const firstConnected = kinds.indexOf("connected");
				assert.ok(
					firstConnected === -1 ||
						kinds.slice(firstConnected).every((kind) => kind === "connected"),
					`${label}: attention rows first (${kinds.join(",")})`,
				);

				// One status per row: never a second "Connected" badge.
				for (const count of await rows.evaluateAll((items) =>
					items.map(
						(item) =>
							(item.textContent ?? "").split("Connected").length -
							1 -
							(item.textContent?.match(/Connected accounts/g)?.length ?? 0),
					),
				))
					assert.ok(count <= 1, `${label}: duplicate Connected status`);

				const target =
					owner === "organization" ? "Pricewise" : "Google Calendar";
				await page.getByRole("button", { name: `${target} details` }).click();
				const opened = await page.locator("main, body").first().innerText();
				assert.ok(
					opened.includes("Who can use it") &&
						opened.includes(
							owner === "organization"
								? "Everyone in this organization"
								: "Only you",
						),
					`${label}: details name the owner`,
				);
				assert.ok(
					opened.includes(
						owner === "organization" ? "One account" : "Multiple accounts",
					),
					`${label}: account mode stated`,
				);
				assert.ok(
					!opened.includes("pricewise-official-f9ab445d"),
					`${label}: slug hidden until Technical details`,
				);
				if (owner === "personal") {
					for (const app of ["Notion", "GitHub"]) {
						await page.getByRole("button", { name: `${app} details` }).click();
						const details = await page
							.locator("main, body")
							.first()
							.innerText();
						for (const copy of [
							"What Tedix can do with it",
							"Read:",
							"Create and edit:",
							"Protected effects:",
							`Tedix keeps your ${app} key`,
						])
							assert.ok(
								details.includes(copy),
								`${label}: ${app} shows ${copy}`,
							);
						await page.getByRole("button", { name: `${app} details` }).click();
					}
					await page
						.getByRole("button", { name: /Available to connect/ })
						.click();
					const gmail = page.locator('[data-account-group="google-gmail"]');
					await gmail.getByRole("button", { name: "Connect" }).click();
					const dialog = page.getByRole("dialog");
					for (const copy of [
						"What Tedix can do with it",
						"Read:",
						"Create and edit:",
						"Protected effects:",
						"Tedix keeps your Gmail key",
					])
						assert.ok(
							(await dialog.innerText()).includes(copy),
							`${label}: Gmail dialog shows ${copy}`,
						);
					await dialog.getByRole("button", { name: "Cancel" }).click();
				}
				// One account: actions sit in the details. Several accounts: each
				// account carries its own Reconnect/Disconnect menu.
				if (owner === "personal")
					for (const name of [
						"Manage Google Calendar Default account",
						"Manage Google Calendar Work",
						"Connect another account",
					])
						assert.ok(
							await page.getByRole("button", { name, exact: true }).isVisible(),
							`${label}: ${name} available`,
						);
				for (const action of owner === "organization"
					? ["Check connection", "Reconnect", "Disconnect"]
					: ["Check connection"])
					assert.ok(
						await page
							.getByRole("group", { name: `Actions for ${target}` })
							.getByRole("button", { name: action, exact: true })
							.isVisible(),
						`${label}: ${action} available`,
					);

				const overflow = await page.evaluate(
					() => document.documentElement.scrollWidth - innerWidth,
				);
				assert.equal(overflow, 0, `${label}: horizontal overflow`);
				backgrounds.set(
					label,
					await page.evaluate(
						() => getComputedStyle(document.body).backgroundColor,
					),
				);
				await page.screenshot({
					path: `${evidence}${owner}-${width}-${theme}.png`,
					fullPage: true,
				});
				checks += 1;
				await page.close();
			}
	for (const owner of ["organization", "personal"])
		for (const width of [375, 390, 1280])
			assert.notEqual(
				backgrounds.get(`${owner}/${width}/light`),
				backgrounds.get(`${owner}/${width}/dark`),
				`${owner}/${width}: dark theme applied`,
			);
	console.log(
		`PASS: account list ${checks} page states; screenshots in ${evidence}`,
	);
} finally {
	await browser.close();
	await server.stop();
}
