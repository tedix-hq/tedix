import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/organization-domain/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			let domain: Record<string, unknown> | null = null;
			let failVerification = true;
			await page.route(
				"**/api/rpc/organizations/*CustomDomain*",
				async (route) => {
					const method = new URL(route.request().url()).pathname
						.split("/")
						.at(-1);
					if (method === "beginCustomDomain")
						domain = {
							claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							hostname: "share.example.com",
							status: "pending",
							txtName: "_tedix-os.share.example.com",
							txtValue: "a".repeat(64),
							cnameTarget: "os.tedix.dev",
							expiresAt: "2027-01-01T00:00:00.000Z",
							validationRecords: [],
						};
					if (method === "verifyCustomDomain") {
						if (failVerification) {
							failVerification = false;
							return route.fulfill({
								status: 400,
								contentType: "application/json",
								body: JSON.stringify({
									json: {
										defined: true,
										code: "BAD_REQUEST",
										message:
											"TXT ownership record was not found. Check the record and try again.",
									},
								}),
							});
						}
						domain = { ...domain!, status: "active" };
					}
					if (method === "removeCustomDomain") domain = null;
					return route.fulfill({
						contentType: "application/json",
						body: JSON.stringify({
							json:
								method === "removeCustomDomain" ? { success: true } : domain,
						}),
					});
				},
			);
			await page.goto(`${server.origin}/account/settings`);
			const app = page.getByRole("region", { name: "Organization domain" });
			await app
				.getByRole("textbox", { name: "Hostname" })
				.fill("share.example.com");
			await app
				.getByRole("button", { name: "Add domain", exact: true })
				.click();
			await app
				.getByText("_tedix-os.share.example.com", { exact: true })
				.waitFor();
			await app.getByRole("button", { name: "Verify domain" }).click();
			await app
				.getByText(
					"TXT ownership record was not found. Check the record and try again.",
				)
				.waitFor()
				.catch(async (error) => {
					console.error(await app.innerText());
					await page.screenshot({
						path: `${evidence}/failure-${width}-${theme}.png`,
						fullPage: true,
					});
					throw error;
				});
			await app.getByRole("button", { name: "Verify domain" }).click();
			await app
				.getByText("Verified. Share links can use this hostname.")
				.waitFor();
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			);
			assert.equal(overflow, false, `${width}/${theme}: horizontal overflow`);
			const remove = app.getByRole("button", { name: "Remove domain" });
			await remove.focus();
			assert(await remove.evaluate((el) => el === document.activeElement));
			const targets = await app
				.getByRole("button")
				.evaluateAll((buttons) =>
					buttons.map((button) => ({
						width: button.getBoundingClientRect().width,
						height: button.getBoundingClientRect().height,
					})),
				);
			assert(targets.every((r) => r.width >= 24 && r.height >= 24));
			await app.scrollIntoViewIfNeeded();
			await page.screenshot({
				path: `${evidence}/${width}-${theme}.png`,
				fullPage: true,
			});
			await remove.click();
			await app.getByRole("textbox", { name: "Hostname" }).waitFor();
			assert.deepEqual(errors, []);
			await page.close();
		}
	console.log(
		`PASS: add, TXT failure, verify, remove, focus, targets and overflow at 375/1280 light/dark; screenshots ${evidence}`,
	);
} finally {
	await browser.close();
	await server.stop();
}
