import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	devices,
	webkit,
	type Browser,
	type Locator,
	type Page,
} from "playwright";
import { startFixtureServer } from "./fixture-server";

// Slide rail touch actions: on coarse pointers Duplicate/Delete are always
// discoverable as real 44px targets beside (never over) the thumbnail/label;
// fine pointers keep the compact hover/focus overlay and keyboard focus.
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	join(tmpdir(), "tedix-b13-slide-rail-touch");
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/b13-slide-rail-touch-actions.html",
);
const { origin } = server;
const failures: string[] = [];
const measurements: unknown[] = [];
let browser: Browser | undefined;

const overlap = (
	a: { x: number; y: number; right: number; bottom: number },
	b: { x: number; y: number; right: number; bottom: number },
) => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;

async function rowMeasure(row: Locator) {
	return row.evaluate((li) => {
		const rect = (el: Element) => {
			const r = el.getBoundingClientRect();
			return {
				x: r.x,
				y: r.y,
				width: r.width,
				height: r.height,
				right: r.right,
				bottom: r.bottom,
			};
		};
		const hit = (el: Element) => {
			const r = el.getBoundingClientRect();
			const at = document.elementFromPoint(
				r.x + r.width / 2,
				r.y + r.height / 2,
			);
			return at !== null && el.contains(at);
		};
		const dup = li.querySelector('[aria-label="Duplicate slide"]')!;
		const del = li.querySelector('[aria-label="Delete slide"]')!;
		const thumb = li.querySelector(".slide-thumb-canvas")!;
		const label = [...li.querySelectorAll(".type-tedix-caption")].at(-1)!;
		const wrap = dup.parentElement!;
		const wrapStyle = getComputedStyle(wrap);
		return {
			liDisplay: getComputedStyle(li).display,
			wrapPosition: wrapStyle.position,
			wrapOpacity: wrapStyle.opacity,
			thumb: rect(thumb),
			label: rect(label),
			dup: { ...rect(dup), hit: hit(dup) },
			del: { ...rect(del), hit: hit(del) },
		};
	});
}

async function keyboardFocus(page: Page, target: Locator) {
	await target.focus();
	await page.keyboard.press("Alt+Tab");
	await page.keyboard.press("Alt+Shift+Tab");
	assert(
		await target.evaluate((node) => node === document.activeElement),
		`Tab/Shift+Tab must return focus: ${await page.evaluate(() => document.activeElement?.outerHTML)}`,
	);
	assert(
		await target.evaluate((node) => {
			const style = getComputedStyle(node);
			return (
				node.matches(":focus-visible") &&
				(style.boxShadow !== "none" ||
					(style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0))
			);
		}),
		"Keyboard focus must have a visible outline or ring",
	);
}

try {
	browser = await webkit.launch({ headless: true });
	for (const device of [
		{ ...devices["iPhone 8"], viewport: { width: 375, height: 667 } },
		{ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
		{
			viewport: { width: 1280, height: 900 },
			isMobile: false,
			hasTouch: false,
		},
	]) {
		for (const theme of ["light", "dark"] as const) {
			const phone = device.isMobile === true;
			const label = `${device.viewport.width}x${device.viewport.height}-${theme}`;
			const context = await browser.newContext({
				...device,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			const consoleEntries: string[] = [];
			page.on("console", (entry) =>
				consoleEntries.push(`${entry.type()}: ${entry.text()}`),
			);
			page.on("pageerror", (error) =>
				failures.push(`${label}: pageerror ${error.message}`),
			);
			try {
				await page.goto(
					`${origin}/browser-tests/b13-slide-rail-touch-actions.html?theme=${theme}`,
				);
				const editable = page.locator('[data-variant="editable"]');
				const rows = () => editable.locator("[data-slide-row]");
				const state = async () =>
					JSON.parse(
						(await editable.locator("[data-deck-state]").textContent())!,
					) as { names: string[]; viewed: string; deckActive: string };
				const open = (index: number) =>
					rows().nth(index).locator("[data-slide-open]");
				const act = (name: string, index: number) =>
					rows().nth(index).getByRole("button", { name, exact: true });
				const press = (target: Locator) =>
					phone ? target.tap() : target.click();
				await rows().first().waitFor({ timeout: 15_000 });

				const geometry = await page.evaluate(() => ({
					width: innerWidth,
					clientWidth: document.documentElement.clientWidth,
					scrollWidth: document.documentElement.scrollWidth,
					mode: document.documentElement.dataset.mode,
					coarse: matchMedia("(pointer: coarse)").matches,
				}));
				assert.equal(geometry.coarse, phone, `${label}: pointer mode`);
				assert.equal(geometry.mode, theme, `${label}: theme`);
				assert(
					geometry.scrollWidth <= geometry.clientWidth + 1,
					`${label}: page overflow ${JSON.stringify(geometry)}`,
				);

				// --- Discoverability, 44px targets, no content overlap -----------
				const first = await rowMeasure(rows().first());
				measurements.push({ label, geometry, first });
				if (phone) {
					assert.equal(first.liDisplay, "flex", `${label}: row layout`);
					assert.equal(
						first.wrapPosition,
						"static",
						`${label}: actions leave the overlay`,
					);
					assert.equal(
						first.wrapOpacity,
						"1",
						`${label}: actions discoverable`,
					);
					for (const [name, b] of [
						["dup", first.dup],
						["del", first.del],
					] as const) {
						assert(
							b.width >= 43.5 && b.height >= 43.5,
							`${label}: ${name} target ${JSON.stringify(b)} requires 44px`,
						);
						assert(b.hit, `${label}: ${name} covered at center`);
						assert(
							!overlap(b, first.thumb),
							`${label}: ${name} overlaps thumbnail`,
						);
						assert(
							!overlap(b, first.label),
							`${label}: ${name} overlaps label`,
						);
					}
				} else {
					assert.equal(
						first.wrapPosition,
						"absolute",
						`${label}: fine pointer keeps overlay`,
					);
					for (const b of [first.dup, first.del])
						assert(
							b.width < 44 && b.height < 44,
							`${label}: fine pointer stays compact`,
						);
				}
				await page.screenshot({ path: `${evidence}/${label}-rail.png` });

				// --- Keyboard focus stays visible (and reveals actions) --------
				await keyboardFocus(page, open(0));
				if (!phone) {
					await page.waitForFunction(
						() =>
							getComputedStyle(
								document.querySelector(
									'[data-variant="editable"] [data-slide-row] [aria-label="Duplicate slide"]',
								)!.parentElement!,
							).opacity === "1",
						undefined,
						{ timeout: 5_000 },
					);
					await page.screenshot({
						path: `${evidence}/${label}-focus.png`,
					});
				}

				// --- Duplicate/delete through the real commit path -------------
				assert.deepEqual((await state()).names, [
					"Slide 1",
					"Slide 2",
					"Slide 3",
					"Slide 4",
				]);
				await press(act("Duplicate slide", 0));
				assert.deepEqual(
					(await state()).names.slice(0, 2),
					["Slide 1", "Slide 1 copy"],
					`${label}: duplicate inserts after source`,
				);
				await press(act("Delete slide", 1));
				assert.deepEqual(
					(await state()).names,
					["Slide 1", "Slide 2", "Slide 3", "Slide 4"],
					`${label}: delete removes the copy`,
				);

				// Active and non-active deletion keep the viewed slide honest.
				await press(open(1));
				assert.equal((await state()).viewed, "e2");
				await press(act("Delete slide", 0));
				assert.equal(
					(await state()).deckActive,
					"e2",
					`${label}: non-active deletion keeps the viewed slide`,
				);
				await press(act("Delete slide", 0));
				assert.equal(
					(await state()).deckActive,
					"e3",
					`${label}: active deletion moves to the nearest slide`,
				);
				await press(
					editable.getByRole("button", { name: "Undo", exact: true }),
				);
				await press(
					editable.getByRole("button", { name: "Undo", exact: true }),
				);
				assert.deepEqual(
					(await state()).names,
					["Slide 1", "Slide 2", "Slide 3", "Slide 4"],
					`${label}: undo restores deleted slides`,
				);

				// Reorder by keyboard, announced through aria-live.
				await keyboardFocus(page, open(0));
				await page.keyboard.press("Alt+ArrowDown");
				assert.deepEqual(
					(await state()).names.slice(0, 2),
					["Slide 2", "Slide 1"],
					`${label}: Alt+ArrowDown reorders`,
				);
				assert.equal(
					await editable.locator('[aria-live="polite"]').textContent(),
					"Moved Alpha revenue summary to position 2 of 4",
				);
				await press(
					editable.getByRole("button", { name: "Undo", exact: true }),
				);
				assert.deepEqual((await state()).names.slice(0, 2), [
					"Slide 1",
					"Slide 2",
				]);

				// Filtered rows keep their real slide identity.
				await editable.getByRole("searchbox").fill("hiring");
				assert.equal(await rows().count(), 1);
				await press(act("Duplicate slide", 0));
				await editable.getByRole("searchbox").fill("");
				assert.deepEqual(
					(await state()).names.slice(0, 3),
					["Slide 1", "Slide 2", "Slide 2 copy"],
					`${label}: filtered duplicate binds the filtered slide`,
				);
				await press(act("Delete slide", 2));
				assert.equal((await state()).names.length, 4);

				// maxSlides caps duplication; read-only disables both actions.
				await press(act("Duplicate slide", 0));
				await press(act("Duplicate slide", 0));
				assert.equal((await state()).names.length, 6);
				assert(
					await act("Duplicate slide", 0).isDisabled(),
					`${label}: duplicate disabled at cap`,
				);
				for (const name of ["Duplicate slide", "Delete slide"])
					assert(
						await page
							.locator('[data-variant="readonly"]')
							.getByRole("button", { name, exact: true })
							.first()
							.isDisabled(),
						`${label}: read-only disables ${name}`,
					);
				assert(
					await page
						.locator('[data-variant="capped"]')
						.getByRole("button", { name: "Duplicate slide", exact: true })
						.first()
						.isDisabled(),
					`${label}: capped duplicate disabled`,
				);
				assert(
					await page
						.locator('[data-variant="capped"]')
						.getByRole("button", { name: "Delete slide", exact: true })
						.first()
						.isEnabled(),
					`${label}: capped delete stays enabled`,
				);

				await page.screenshot({ path: `${evidence}/${label}-after.png` });
				assert(
					!consoleEntries.some((line) => line.startsWith("error:")),
					`${label}: console errors\n${consoleEntries.join("\n")}`,
				);
				console.log(`PASS ${label}`);
			} catch (error) {
				failures.push(`${label}: ${String(error)}`);
				await page
					.screenshot({
						path: `${evidence}/${label}-failure.png`,
						fullPage: true,
					})
					.catch(() => {});
			}
			await context.close();
		}
	}
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify({ origin, measurements, failures }, null, 2),
	);
	await browser?.close();
	await server.stop();
}
assert.deepEqual(
	failures,
	[],
	`Slide rail touch regressions; evidence: ${evidence}`,
);
console.log(
	"PASS: slide rail actions are discoverable 44px targets beside (never over) content on coarse pointers, compact focus-revealed overlay on fine pointers, with duplicate/delete/reorder/filter/maxSlides/read-only/undo intact (WebKit, 6 viewport/theme combinations)",
);
