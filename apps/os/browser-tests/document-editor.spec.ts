import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * The document Output in edit and read mode, at phone and desktop widths, in
 * both themes: the page holds a readable measure, the outline and block rails
 * appear only where they fit, `/` opens the block menu at the caret, the
 * shortcut sheet opens from the keyboard, and nothing scrolls sideways.
 */
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? "/tmp/tedix-document-editor";
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer("/browser-tests/document-editor.html", {
	stdout: "ignore",
});
const { origin } = server;
let browser: Browser | undefined;
const receipts: unknown[] = [];

async function open(
	page: Page,
	query: string,
	ready: (page: Page) => Promise<unknown>,
) {
	await page.goto(`${origin}/browser-tests/document-editor.html?${query}`);
	await ready(page);
	await page.evaluate(() => document.fonts.ready);
}

const noSidewaysScroll = (page: Page) =>
	page.evaluate(() => ({
		viewport: innerWidth,
		page: document.documentElement.scrollWidth,
	}));

try {
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 740 },
		{ width: 1280, height: 800 },
	]) {
		const phone = viewport.width < 640;
		for (const theme of ["light", "dark"] as const) {
			const name = `${viewport.width}-${theme}`;
			const page = await browser.newPage({
				viewport,
				isMobile: phone,
				hasTouch: phone,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (entry) => {
				if (entry.type() === "error") errors.push(entry.text());
			});

			// --- Edit mode -------------------------------------------------
			await open(page, `theme=${theme}&view=edit`, (p) =>
				p.getByRole("button", { name: "Bold", exact: true }).waitFor(),
			);
			const editGeometry = await page.evaluate(() => {
				const prose = document.querySelector<HTMLElement>(".ProseMirror")!;
				const pill = document.querySelector<HTMLElement>(
					"[data-document-pill]",
				)!;
				const rect = pill.getBoundingClientRect();
				return {
					prose: prose.getBoundingClientRect().width,
					pill: { left: rect.left, right: rect.right, bottom: rect.bottom },
					outline: Boolean(document.querySelector('nav[aria-label="Outline"]')),
					blocks: Boolean(
						document.querySelector('aside[aria-label="Add a block"]'),
					),
				};
			});
			const editScroll = await noSidewaysScroll(page);
			assert.ok(
				editScroll.page <= editScroll.viewport,
				`${name}: edit page scrolls sideways ${JSON.stringify(editScroll)}`,
			);
			// A readable measure: never wider than 48rem.
			assert.ok(
				editGeometry.prose <= 768,
				`${name}: prose ${editGeometry.prose}`,
			);
			assert.ok(editGeometry.pill.left >= 0);
			assert.ok(editGeometry.pill.right <= viewport.width);
			assert.ok(editGeometry.pill.bottom <= viewport.height);
			assert.equal(editGeometry.outline, !phone, `${name}: outline rail`);
			assert.equal(editGeometry.blocks, !phone, `${name}: block rail`);
			await page.screenshot({ path: `${evidence}/edit-${name}.png` });

			if (!phone) {
				// The outline lists the headings and marks the section clicked.
				const outline = page.getByRole("navigation", { name: "Outline" });
				const risks = outline.getByRole("button", { name: "Risks" });
				await risks.click();
				await page.waitForFunction(() =>
					document
						.querySelector('nav[aria-label="Outline"] [aria-current]')
						?.textContent?.includes("Risks"),
				);
			}

			// `/` on an empty line opens the block menu at the caret; typing
			// narrows it and Enter inserts the highlighted block.
			const tablesBefore = await page.locator(".ProseMirror table").count();
			// The caret goes to the end of the intro paragraph (after the title).
			await page.evaluate(() => {
				const { editor } = document.querySelector(".tiptap") as unknown as {
					editor: {
						state: {
							doc: { child(index: number): { nodeSize: number } };
						};
						commands: { focus(position: number): boolean };
					};
				};
				const { doc } = editor.state;
				editor.commands.focus(
					doc.child(0).nodeSize + doc.child(1).nodeSize - 1,
				);
			});
			// Tiptap focuses on the next animation frame; keys must reach the editor.
			await page.waitForFunction(
				() => document.activeElement === document.querySelector(".tiptap"),
			);
			await page.keyboard.press("Enter");
			await page.keyboard.type("/tab");
			const menu = page.getByRole("listbox", { name: "Insert a block" });
			await menu.waitFor();
			const menuBox = await menu.boundingBox();
			assert.ok(menuBox, "slash menu has a box");
			assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= viewport.width);
			assert.equal(
				await menu
					.getByRole("option")
					.first()
					.getAttribute("data-document-block"),
				"table",
			);
			await page.screenshot({ path: `${evidence}/slash-${name}.png` });
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "detached" });
			assert.equal(
				await page.locator(".ProseMirror table").count(),
				tablesBefore + 1,
			);
			assert.ok(
				!(await page.locator(".ProseMirror").innerText()).includes("/tab"),
				"the typed query is replaced by the block",
			);

			// Escape closes the menu and keeps the typed text. The caret is in
			// the new table's first cell, itself an empty paragraph.
			await page.keyboard.type("/");
			await menu.waitFor();
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "detached" });
			await page.keyboard.press("Backspace");

			// The shortcut sheet opens from the keyboard.
			await page.keyboard.press("ControlOrMeta+/");
			const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
			await sheet.waitFor();
			await page.screenshot({ path: `${evidence}/shortcuts-${name}.png` });
			await page.keyboard.press("Escape");
			await sheet.waitFor({ state: "hidden" });

			// --- Read mode -------------------------------------------------
			await open(page, `theme=${theme}&view=read`, (p) =>
				p.locator('[data-kumo-part="document-paper"]').waitFor(),
			);
			const contents = page.getByRole("navigation", { name: "Contents" });
			assert.equal(
				await contents.isVisible(),
				!phone,
				`${name}: contents beside the page`,
			);
			const readScroll = await noSidewaysScroll(page);
			assert.ok(readScroll.page <= readScroll.viewport, `${name}: read scroll`);
			await page.screenshot({ path: `${evidence}/read-${name}.png` });

			// --- Empty document --------------------------------------------
			await open(page, `theme=${theme}&view=read&empty=1`, (p) =>
				p.getByText("This document is empty").waitFor(),
			);
			assert.ok(
				await page.getByRole("button", { name: "Start writing" }).isVisible(),
			);
			await page.screenshot({ path: `${evidence}/empty-read-${name}.png` });
			await open(page, `theme=${theme}&view=edit&empty=1`, (p) =>
				p.getByRole("button", { name: "Bold", exact: true }).waitFor(),
			);
			await page.screenshot({ path: `${evidence}/empty-edit-${name}.png` });

			assert.deepEqual(errors, [], `${name}: page errors`);
			receipts.push({ name, editGeometry, editScroll, readScroll });
			await page.close();
		}
	}
	await writeFile(
		`${evidence}/receipts.json`,
		JSON.stringify(receipts, null, 2),
	);
	console.log(
		`Passed ${receipts.length} document editor viewport/theme cases; screenshots: ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
