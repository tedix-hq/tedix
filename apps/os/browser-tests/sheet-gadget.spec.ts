import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * The sheet Output, read and edited, at phone and desktop widths in both
 * themes: headers stay put while the grid scrolls, numbers read as numbers,
 * the keyboard edits without the mouse, the read view sorts and filters
 * without writing, and both empty states say what to do.
 */
const server = await startFixtureServer("/browser-tests/sheet-gadget.html");
const browser = await chromium.launch();
const evidence = process.env.TEDIX_SCREENSHOT_DIR ?? "/tmp/tedix-sheet-gadget";
await mkdir(evidence, { recursive: true });
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function open(
	width: number,
	theme: "light" | "dark",
	mode: "view" | "edit",
	data: "full" | "empty" = "full",
) {
	const phone = width < 640;
	const page = await browser.newPage({
		viewport: { width, height: phone ? 760 : 820 },
		colorScheme: theme,
		hasTouch: phone,
		reducedMotion: "reduce",
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(
		`${server.origin}/browser-tests/sheet-gadget.html?theme=${theme}&mode=${mode}&data=${data}&workspace=1`,
	);
	await page.evaluate(() => document.fonts.ready);
	return { page, errors, label: `${width}px ${theme} ${mode} ${data}` };
}

async function noPageOverflow(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: the page itself never scrolls sideways`,
	);
}

const cell = (page: Page, row: number, column: number) =>
	page.locator(`[data-cell-row="${row}"][data-cell-column="${column}"]`);

try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			// --- Edit mode ----------------------------------------------------
			{
				const { page, errors, label } = await open(width, theme, "edit");
				await page.getByRole("grid", { name: "Spreadsheet grid" }).waitFor();
				await noPageOverflow(page, label);
				const toolbarGeometry = await page
					.locator(".output-editor-toolbar")
					.evaluate((toolbar) => {
						const controls = [
							...toolbar.querySelectorAll<HTMLElement>(
								'button[data-toolbar-control="icon"], [data-toolbar-control="color"], [data-kumo-component="Select"][data-kumo-part="trigger"]',
							),
						];
						return controls.map((control) => {
							const box = control.getBoundingClientRect();
							return {
								name: control.getAttribute("aria-label") ?? control.title,
								width: box.width,
								height: box.height,
								top: box.top,
								select: control.getAttribute("role") === "combobox",
							};
						});
					});
				assert(
					toolbarGeometry.length > 20,
					`${label}: all toolbar sections measured`,
				);
				for (const control of toolbarGeometry) {
					assert.equal(
						control.height,
						width < 640 ? 44 : 32,
						`${label}: ${control.name} height`,
					);
					if (!control.select)
						assert.equal(
							control.width,
							control.height,
							`${label}: ${control.name} square target`,
						);
				}
				assert.equal(
					new Set(toolbarGeometry.map((control) => control.top)).size,
					1,
					`${label}: all controls align`,
				);
				const tabs = await page
					.locator(".canvas-workpiece-tabs")
					.evaluate((strip) => {
						const first = strip
							.querySelector('[role="tab"]')!
							.getBoundingClientRect();
						return {
							left: strip.getBoundingClientRect().left,
							first: first.left,
						};
					});
				assert(
					Math.abs(tabs.first - tabs.left) <= 1,
					`${label}: workpieces start at the left edge ${JSON.stringify(tabs)}`,
				);
				await page.screenshot({
					path: `${evidence}/sheet-toolbar-${width}-${theme}.png`,
				});

				// Cached values that were never computed still show on load.
				assert.equal(
					(await cell(page, 10, 1).textContent())?.trim(),
					"€142,810.00",
					`${label}: totals are evaluated on open`,
				);

				// Numbers are right-aligned and tabular; text stays left.
				const money = await cell(page, 0, 1).evaluate((el) => {
					const style = getComputedStyle(el);
					return [style.textAlign, style.fontVariantNumeric];
				});
				assert.deepEqual(
					money,
					["right", "tabular-nums"],
					`${label}: numbers align`,
				);
				assert.notEqual(
					await cell(page, 0, 0).evaluate(
						(el) => getComputedStyle(el).textAlign,
					),
					"right",
					`${label}: text stays left`,
				);

				// Keyboard-only editing: type, Enter moves down, Tab moves right.
				await cell(page, 0, 2).click();
				await page.keyboard.type("777");
				await page.keyboard.press("Enter");
				assert.equal(
					await page.getByLabel("Selected cell").inputValue(),
					"C2",
					`${label}: Enter commits and moves down`,
				);
				await page.keyboard.press("Shift+ArrowUp");
				assert.equal(
					await page.getByLabel("Selected cell").inputValue(),
					"C1:C2",
					`${label}: Shift+Arrow extends`,
				);
				const saved = JSON.parse(
					(await page.getByLabel("Saved cells").textContent()) ?? "[]",
				) as string[][];
				assert.equal(saved[0]?.[2], "777", `${label}: the edit is saved`);

				// The selection adds up in the status line.
				const status = page.locator(".sheet-editor-tabs .sheet-status");
				assert.match(
					(await status.textContent()) ?? "",
					/Sum\s*1,294.*Count\s*2/,
					`${label}: the status line sums the selection`,
				);
				assert(await status.isVisible(), `${label}: the sum is visible`);

				// Format shortcuts: currency on Mod+Shift+4, undo restores.
				await cell(page, 1, 2).click();
				await page.keyboard.press(`${mod}+Shift+Digit4`);
				assert.match(
					(await cell(page, 1, 2).textContent()) ?? "",
					/€/,
					`${label}: Mod+Shift+4 applies currency`,
				);
				await page.keyboard.press(`${mod}+z`);
				assert.doesNotMatch(
					(await cell(page, 1, 2).textContent()) ?? "",
					/€/,
					`${label}: undo removes it`,
				);

				// Headers stay put while the grid scrolls.
				const grid = page.locator(".sheet-editor-grid");
				const header = page.locator('[data-column-header="1"]');
				const before = await header.boundingBox();
				await grid.evaluate((el) => {
					el.scrollTop = 200;
					el.scrollLeft = 200;
				});
				const after = await header.boundingBox();
				assert.equal(
					Math.round(after!.y),
					Math.round(before!.y),
					`${label}: the column header row is sticky`,
				);
				const rowHeader = page.locator('[data-row-header="5"]');
				const gridBox = await grid.boundingBox();
				if ((await rowHeader.boundingBox())!.y > gridBox!.y)
					assert(
						Math.abs((await rowHeader.boundingBox())!.x - gridBox!.x) <= 2,
						`${label}: row numbers stay at the left edge`,
					);

				// The shortcuts list opens from the toolbar and the keyboard.
				await grid.evaluate((el) => {
					el.scrollTop = 0;
					el.scrollLeft = 0;
				});
				await cell(page, 0, 0).click();
				await page.keyboard.press(`${mod}+Slash`);
				const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
				await dialog.waitFor();
				await page.keyboard.press("Escape");
				await dialog.waitFor({ state: "hidden" });

				// Cell sizes use the shared Select and survive another cell
				// selection. Options are chosen by keyboard: a pointer click on an
				// item can race the popup's open-time measurement and land on a
				// neighbour.
				const textSize = page.getByRole("combobox", {
					name: "Cell text size",
				});
				const sizeOption = (name: string) =>
					page.getByRole("option", { name, exact: true });
				await textSize.click();
				await sizeOption("24 px").waitFor();
				await page.keyboard.press("2");
				await page.waitForFunction(
					() => document.activeElement?.textContent === "24 px",
				);
				await page.keyboard.press("Enter");
				await page.waitForFunction(
					() =>
						getComputedStyle(
							document.querySelector(
								'[data-cell-row="0"][data-cell-column="0"]',
							)!,
						).fontSize === "24px",
				);
				assert.equal(
					await cell(page, 0, 0).evaluate(
						(el) => getComputedStyle(el).fontSize,
					),
					"24px",
					`${label}: cell text size applies`,
				);
				await cell(page, 0, 1).click();
				assert.equal((await textSize.textContent())?.trim(), "Default");
				await cell(page, 0, 0).click();
				assert.equal((await textSize.textContent())?.trim(), "24 px");
				await textSize.click();
				await sizeOption("Default").waitFor();
				await page.keyboard.press("d");
				await page.waitForFunction(
					() => document.activeElement?.textContent === "Default",
				);
				await page.keyboard.press("Enter");
				await page.waitForFunction(
					() =>
						getComputedStyle(
							document.querySelector(
								'[data-cell-row="0"][data-cell-column="0"]',
							)!,
						).fontSize !== "24px",
				);
				assert.notEqual(
					await cell(page, 0, 0).evaluate(
						(el) => getComputedStyle(el).fontSize,
					),
					"24px",
					`${label}: default size restores the theme`,
				);
				await noPageOverflow(page, label);

				await page.screenshot({
					path: `${evidence}/edit-${width}-${theme}.png`,
				});
				assert.deepEqual(errors, [], `${label}: no page errors`);
				await page.close();
			}

			// --- Read mode ----------------------------------------------------
			{
				const { page, errors, label } = await open(width, theme, "view");
				const table = page.locator("[data-sheet-view] table");
				await table.waitFor();
				await noPageOverflow(page, label);
				const firstColumn = async () =>
					(
						await page
							.locator("[data-sheet-view] tbody tr")
							.evaluateAll((rows) =>
								rows.map((row) => row.querySelector("td")?.textContent),
							)
					).slice(0, 3);
				assert.deepEqual(await firstColumn(), ["W29", "W30", "W31"]);

				// Sorting is view state: descending revenue puts the total first.
				const revenue = page.getByRole("button", { name: /Revenue/ });
				await revenue.click();
				await revenue.click();
				assert.equal(
					await page.locator("th", { has: revenue }).getAttribute("aria-sort"),
					"descending",
				);
				assert.equal((await firstColumn())[0], "Total", `${label}: sorted`);
				await revenue.click();
				assert.deepEqual(await firstColumn(), ["W29", "W30", "W31"]);

				// Filtering hides rows and says how many remain.
				await page.getByLabel("Filter rows").fill("sourdough");
				assert.deepEqual(await firstColumn(), ["W37"], `${label}: filtered`);
				assert.match(
					(await page
						.locator("[data-sheet-view] .sheet-status")
						.textContent()) ?? "",
					/1 of 11 rows/,
				);
				await page.getByLabel("Filter rows").fill("");

				// The header row stays visible while the cells scroll.
				const scroller = page.locator(".sheet-read-grid");
				const head = page.locator("[data-sheet-view] thead th").nth(1);
				const top = (await head.boundingBox())!.y;
				await scroller.evaluate((el) => {
					el.scrollTop = 120;
				});
				assert.equal(
					Math.round((await head.boundingBox())!.y),
					Math.round(top),
					`${label}: read header is sticky`,
				);

				// Tabs switch sheets; the error cell reads as an error.
				await page.getByRole("button", { name: "Suppliers" }).click();
				const error = page
					.locator('[data-sheet-view] td[data-kind="error"]')
					.first();
				assert.equal((await error.textContent())?.trim(), "#DIV/0!");

				await page.screenshot({
					path: `${evidence}/view-${width}-${theme}.png`,
				});
				assert.deepEqual(errors, [], `${label}: no page errors`);
				await page.close();
			}

			// --- Empty states -------------------------------------------------
			for (const mode of ["view", "edit"] as const) {
				const { page, errors, label } = await open(width, theme, mode, "empty");
				if (mode === "view") {
					await page.getByText("This sheet is empty").waitFor();
				} else {
					await page.getByRole("grid", { name: "Spreadsheet grid" }).waitFor();
					await page.getByText("Type to start").waitFor();
				}
				await noPageOverflow(page, label);
				await page.screenshot({
					path: `${evidence}/${mode}-empty-${width}-${theme}.png`,
				});
				assert.deepEqual(errors, [], `${label}: no page errors`);
				await page.close();
			}
			console.log(`Sheet gadget passed: ${width}px ${theme}`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
