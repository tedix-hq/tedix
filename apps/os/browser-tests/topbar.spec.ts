import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit, type Page } from "playwright";

export async function assertLeanTopbar(origin: string, evidenceDir?: string) {
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	const browser = await webkit.launch();
	async function capture(page: Page, name: string) {
		if (evidenceDir)
			await page.screenshot({ path: `${evidenceDir}/after-${name}.png` });
	}
	try {
		for (const theme of ["light", "dark"] as const)
			for (const [width, height] of [
				[375, 667],
				[390, 844],
				[1280, 900],
			]) {
				const page = await browser.newPage({
					viewport: { width, height },
					colorScheme: theme,
					hasTouch: width < 820,
				});
				await page.addInitScript(
					(value) => localStorage.setItem("tedix-os-theme", value),
					theme,
				);
				await page.goto(`${origin}/work`, { waitUntil: "domcontentloaded" });
				const bar = page.locator("header.topbar");
				await bar.waitFor();
				await page.locator(".fd-context-main").waitFor();
				await page.evaluate(() => document.fonts.ready);
				const title = bar.locator(".topbar-context");
				assert((await title.innerText()).includes("Work"));
				const titleBox = await title.boundingBox();
				assert(
					titleBox && titleBox.width > (width < 820 ? 40 : 0),
					"Page title must retain readable space",
				);
				const more = bar.getByRole("button", {
					name: "More options",
					exact: true,
				});
				await capture(page, `${width}-${theme}`);
				if (width < 820) {
					assert.equal(await bar.getByRole("button").count(), 3);
					for (const name of ["Toggle navigation", "Search", "More options"]) {
						const box = await bar
							.getByRole("button", { name, exact: true })
							.boundingBox();
						assert(
							box && box.width === 44 && box.height === 44,
							`${name} needs a 44px target`,
						);
					}
					const bounds = await bar
						.getByRole("button")
						.evaluateAll((nodes) =>
							nodes.map((node) => node.getBoundingClientRect().toJSON()),
						);
					assert.equal(bounds[2].x - (bounds[1].x + bounds[1].width), 8);
					assert.equal(
						await page.evaluate(
							() => document.documentElement.scrollWidth > innerWidth,
						),
						false,
					);
					await more.click();
					const menu = page.getByRole("menu");
					await menu.waitFor();
					assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), [
						"Info",
						"Get help",
						"Activity",
					]);
					for (const item of await menu.getByRole("menuitem").all()) {
						const box = await item.boundingBox();
						assert(box && box.height >= 44 && box.width >= 44);
					}
					await capture(page, `${width}-${theme}-menu`);
					await menu
						.getByRole("menuitem", { name: "Info", exact: true })
						.click();
					const info = page.getByRole("dialog", {
						name: "Decision context",
						exact: true,
					});
					await info.waitFor();
					await page
						.getByRole("button", {
							name: "Close decision context",
							exact: true,
						})
						.click();
					await info.waitFor({ state: "hidden" });
					await page.waitForFunction(
						() =>
							document.activeElement?.getAttribute("aria-label") ===
							"More options",
					);
					await more.click();
					await menu
						.getByRole("menuitem", { name: "Get help", exact: true })
						.click();
					const help = page.getByRole("dialog", {
						name: "Get help",
						exact: true,
					});
					await help.waitFor();
					await help
						.getByRole("textbox", { name: "Summary", exact: true })
						.fill("Example report");
					await page.keyboard.press("Escape");
					await help.waitFor({ state: "hidden" });
					await more.click();
					await menu
						.getByRole("menuitem", { name: "Activity", exact: true })
						.click();
					await page
						.getByText("No approvals waiting", { exact: true })
						.waitFor();
					const panel = page.locator(".kumo-popover-popup");
					const panelBox = await panel.boundingBox();
					assert(
						panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= width,
					);
					await capture(page, `${width}-${theme}-activity`);
					await page.keyboard.press("Escape");
					await bar
						.getByRole("button", { name: "Search", exact: true })
						.click();
					await page.getByRole("dialog").waitFor();
					await page.keyboard.press("Escape");
					await more.click();
					await page.keyboard.press("Escape");
					await page.goto(`${origin}/team`, { waitUntil: "domcontentloaded" });
					await more.click();
					assert.equal(
						await menu
							.getByRole("menuitem", { name: "Info", exact: true })
							.count(),
						0,
						"Info must disappear on routes without context",
					);
					await page.goto(
						`${origin}/workspace/00000030-0000-4000-8000-000000000001?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece`,
						{ waitUntil: "domcontentloaded" },
					);
					await page
						.getByRole("button", {
							name: "Action approvals: none waiting",
							exact: true,
						})
						.waitFor();
					await page.waitForURL(
						(url) =>
							url.pathname ===
								"/workspace/00000030-0000-4000-8000-000000000001" &&
							url.searchParams.get("pane") === "workpiece" &&
							url.searchParams.get("workpiece") ===
								"gadget:00000031-0000-4000-8000-00000000000a",
						{ waitUntil: "domcontentloaded" },
					);
					await page
						.locator(
							'.canvas-workpiece-tabs [role="tab"][aria-selected="true"]',
						)
						.waitFor();
					// The tab precedes the lazy app; unloading mid-import triggers chunk recovery.
					await page
						.locator(
							'[data-canvas-builtin-app] [data-workspace-app-entry="activity-feed"]',
						)
						.waitFor();
					assert.equal(
						await page.locator("header.topbar").count(),
						0,
						"Workbench retains its own toolbar",
					);
					// The whole shell sits inside the topbar's menu root; a route's
					// own menu must still open and close on its own.
					await page.goto(`${origin}/outputs`, {
						waitUntil: "domcontentloaded",
					});
					const scope = page.getByRole("button", {
						name: "All sharing",
						exact: true,
					});
					await scope.click();
					await menu.waitFor();
					assert.equal(await page.getByRole("menu").count(), 1);
					assert.equal(
						await menu
							.getByRole("menuitem", { name: /^Created by you/ })
							.count(),
						1,
						"Route menu shows its own items",
					);
					assert.equal(await more.getAttribute("aria-expanded"), "false");
					await page.keyboard.press("Escape");
					await menu.waitFor({ state: "hidden" });
					await more.click();
					await menu.waitFor();
					assert.equal(await page.getByRole("menu").count(), 1);
					assert.equal(
						await menu
							.getByRole("menuitem", { name: /^Created by you/ })
							.count(),
						0,
						"Topbar menu keeps route items out",
					);
					assert.equal(await scope.getAttribute("aria-expanded"), "false");
					await page.keyboard.press("Escape");
					await menu.waitFor({ state: "hidden" });
					await scope.click();
					await menu.getByRole("menuitem", { name: /^Created by you/ }).click();
					await menu.waitFor({ state: "hidden" });
					await page
						.getByRole("button", { name: "Yours", exact: true })
						.waitFor();
					assert.equal(await more.getAttribute("aria-expanded"), "false");
				} else {
					assert.equal(await more.count(), 0);
					await bar
						.getByRole("button", { name: "Decision context", exact: true })
						.waitFor();
					await bar
						.getByRole("button", { name: "Get help", exact: true })
						.waitFor();
					await bar
						.getByRole("button", {
							name: "Action approvals: none waiting",
							exact: true,
						})
						.waitFor();
					assert.equal(
						await bar
							.getByRole("button", { name: "Search", exact: true })
							.count(),
						0,
						"Expanded sidebar owns desktop search",
					);
					await page
						.getByRole("button", { name: "Collapse sidebar", exact: true })
						.click();
					await bar
						.getByRole("button", { name: "Search", exact: true })
						.waitFor();
				}
				await page.close();
			}
		console.log(
			"PASS: WebKit topbar title, phone overflow, 44px targets, info/help/activity, search, focus return, independent route menus and desktop controls; 375/390/1280 × light/dark",
		);
	} finally {
		await browser.close();
	}
}
if (import.meta.main)
	await assertLeanTopbar(
		process.env.SHELL_TEST_ORIGIN ?? "http://127.0.0.1:3010",
		process.env.SHELL_EVIDENCE_DIR,
	);
