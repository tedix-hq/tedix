import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-template-copy";
await mkdir(directory, { recursive: true });
const server = await startFixtureServer("/blueprints");
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [375, 768, 1280]) {
				for (const theme of ["light", "dark"] as const) {
					const context = await browser.newContext({
						viewport: { width, height: 900 },
						colorScheme: theme,
						reducedMotion: "reduce",
					});
					try {
						await context.addInitScript(
							(mode) => localStorage.setItem("tedix-os-theme", mode),
							theme,
						);
						const page = await context.newPage();
						const errors: string[] = [];
						page.on("pageerror", (error) => errors.push(error.message));
						let release = () => {};
						const pending = new Promise<void>((resolve) => {
							release = resolve;
						});
						// Keep the mutation local and hold it to inspect the pending label.
						await page.route(
							"**/api/rpc/osWorkspaces/blueprints/instantiateFromGallery",
							async (route) => {
								await pending;
								await route.fulfill({
									status: 503,
									json: {
										json: {
											defined: false,
											code: "INTERNAL_SERVER_ERROR",
											message: "Fictional creation failure",
										},
									},
								});
							},
						);
						await page.goto(`${server.origin}/blueprints`);
						await page
							.getByText("Workspace templates saved by your organization.", {
								exact: true,
							})
							.waitFor();
						await page
							.getByRole("button", { name: "Explore", exact: true })
							.click();
						const card = page.locator(".blueprint-gallery-card").first();
						await card.getByRole("textbox").fill("Weekly reports");
						const create = card.getByRole("button", {
							name: "Create workspace",
							exact: true,
						});
						await create.waitFor();
						assert.equal(await create.isEnabled(), true);
						const label = `${engine.name()}-${width}-${theme}`;
						async function capture(state: string) {
							await card.scrollIntoViewIfNeeded();
							assert.equal(
								await page.evaluate(() =>
									document.documentElement.classList.contains("dark"),
								),
								theme === "dark",
							);
							assert.ok(
								await page.evaluate(
									() =>
										document.documentElement.scrollWidth <=
										document.documentElement.clientWidth + 1,
								),
								`${label}: horizontal overflow`,
							);
							assert.doesNotMatch(
								await card.innerText(),
								/Instantiate|Instantiation|versioned workspace/i,
							);
							await page.screenshot({
								path: `${directory}/${label}-${state}.png`,
								fullPage: true,
							});
						}
						await capture("ready");
						await create.click();
						const creating = card.getByRole("button", {
							name: "Creating…",
							exact: true,
						});
						await creating.waitFor();
						assert.equal(await creating.isDisabled(), true);
						await capture("creating");
						release();
						await card
							.getByText("Couldn't create workspace", { exact: true })
							.waitFor();
						await capture("failed");
						assert.deepEqual(errors, []);
						console.log(`PASS ${label}: ready, creating, failed`);
					} finally {
						await context.close();
					}
				}
			}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
