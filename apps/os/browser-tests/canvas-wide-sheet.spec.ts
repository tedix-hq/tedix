import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * A wide, many-tab sheet open in the workspace canvas, read-only because the
 * fixture has no collaboration room. The sheet stays inside its pane: the grid
 * scrolls sideways in its own container, the filter bar and tab strip are as
 * wide as the grid's frame, the tab strip scrolls inside the pane with the row
 * count still visible, and the page itself never scrolls sideways.
 */
const WORKSPACE = "00000030-0000-4000-8000-000000000001";
const SHEET = "00000040-0000-4000-8000-000000000014";
const path = `/workspace/${WORKSPACE}?workpiece=output%3A${SHEET}&pane=workpiece`;
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? "/tmp/tedix-canvas-wide-sheet";
await mkdir(evidence, { recursive: true });

const COLUMNS = 16;
const TABS = 13;
const cell = (input: string) => ({ input, value: null });
/** A sheet of `TABS` tabs, `COLUMNS` columns wide and `rows` rows deep. */
const wideWorkbook = (rows: number) => ({
	kind: "sheet",
	columns: [],
	rows: [],
	workbook: {
		activeSheetId: "tab-0",
		sheets: Array.from({ length: TABS }, (_, tab) => ({
			id: `tab-${tab}`,
			name: tab === 0 ? "Threads" : `Review round ${tab}`,
			columns: Array.from({ length: COLUMNS }, (_, column) => ({
				id: `tab-${tab}-col-${column}`,
				label: `Column ${column + 1}`,
				width: 180,
			})),
			rows: Array.from({ length: rows }, (_, row) =>
				Array.from({ length: COLUMNS }, (_, column) =>
					cell(`Row ${row + 1} · a longer note for column ${column + 1}`),
				),
			),
			frozenRows: 0,
			frozenColumns: 0,
		})),
	},
});

async function widenSheet(page: Page, rows: number) {
	await page.route("**/api/rpc/osWorkspaces/outputs/get*", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		const detail = body.json ?? body;
		if (detail?.output?.id === SHEET) {
			detail.currentRevision.content = wideWorkbook(rows);
		}
		await route.fulfill({ response, json: body });
	});
}

const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}px ${theme}`;
			const phone = width < 640;
			const page = await browser.newPage({
				viewport: { width, height: phone ? 760 : 820 },
				colorScheme: theme,
				isMobile: phone,
				hasTouch: phone,
				reducedMotion: "reduce",
			});
			await widenSheet(page, 24);
			await page.goto(`${server.origin}${path}`);
			const grid = page.locator(".sheet-read-grid");
			await grid.waitFor();
			await page.evaluate(() => document.fonts.ready);
			const geometry = await page.evaluate(() => {
				const box = (selector: string) => {
					const rect = document
						.querySelector(selector)!
						.getBoundingClientRect();
					return { left: rect.left, right: rect.right };
				};
				const gridElement = document.querySelector(".sheet-read-grid")!;
				const strip = document.querySelector(".sheet-tab-strip")!;
				return {
					viewport: innerWidth,
					scrollWidth: document.documentElement.scrollWidth,
					desk: box(".sheet-read-desk"),
					page: box(".sheet-read-page"),
					bar: box(".sheet-read-bar"),
					grid: box(".sheet-read-grid"),
					footer: box(".sheet-footer"),
					status: box(".sheet-status"),
					gridScrolls: gridElement.scrollWidth > gridElement.clientWidth,
					stripScrolls: strip.scrollWidth > strip.clientWidth,
				};
			});
			const detail = JSON.stringify(geometry);
			assert(
				geometry.scrollWidth <= geometry.viewport + 1,
				`${label}: the page never scrolls sideways ${detail}`,
			);
			for (const part of ["page", "bar", "grid", "footer"] as const) {
				assert(
					geometry[part].left >= geometry.desk.left - 1 &&
						geometry[part].right <= geometry.desk.right + 1,
					`${label}: ${part} stays inside the sheet's frame ${detail}`,
				);
			}
			assert(
				Math.abs(geometry.bar.right - geometry.grid.right) <= 1 &&
					Math.abs(geometry.footer.right - geometry.grid.right) <= 1,
				`${label}: filter bar and tab strip match the grid's width ${detail}`,
			);
			assert(
				geometry.desk.right <= geometry.viewport + 1,
				`${label}: the sheet's frame ends inside the viewport ${detail}`,
			);
			assert(geometry.gridScrolls, `${label}: the grid scrolls in place`);
			assert(geometry.stripScrolls, `${label}: the tab strip scrolls in place`);
			assert(
				geometry.status.right <= geometry.footer.right + 1 &&
					geometry.status.left >= geometry.footer.left - 1,
				`${label}: the row count stays visible ${detail}`,
			);
			const status = page.locator(".canvas-document-status");
			assert.equal(
				await status.locator("[data-connection]").count(),
				0,
				`${label}: no second connection pill`,
			);
			assert.equal(
				((await status.textContent()) ?? "").match(/Connecting/g)?.length,
				1,
				`${label}: one connection status`,
			);
			await page.screenshot({
				path: `${evidence}/canvas-wide-sheet-${width}-${theme}.png`,
			});
			await page.locator(".sheet-footer").scrollIntoViewIfNeeded();
			await page.locator(".sheet-read-desk").screenshot({
				path: `${evidence}/canvas-wide-sheet-${width}-${theme}-footer.png`,
			});
			await page.close();
			console.log(`canvas wide sheet ${label}: ok`);
		}
	}
	// A saved version longer than a room can hold opens read-only with one
	// "Read-only" status and a notice, instead of reconnecting forever.
	{
		const page = await browser.newPage({
			viewport: { width: 1280, height: 820 },
			colorScheme: "dark",
		});
		await widenSheet(page, 120);
		await page.goto(`${server.origin}${path}`);
		await page.locator("[data-canvas-too-large]").waitFor();
		const status =
			(await page.locator(".canvas-document-status").textContent()) ?? "";
		assert.match(status, /Read-only/, "too large: the status says read-only");
		assert.doesNotMatch(status, /Connecting/, "too large: it does not connect");
		assert.equal(
			await page.getByRole("button", { name: "Retry connection" }).count(),
			0,
			"too large: nothing to retry",
		);
		await page.screenshot({
			path: `${evidence}/canvas-too-large-1280-dark.png`,
		});
		await page.close();
		console.log("canvas too-large sheet: ok");
	}
} finally {
	await browser.close();
	await server.stop();
}
