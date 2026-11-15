import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";
import { workpieceViewMenu } from "./workpiece-views";

/*
 * An open file on a phone sits under two rows: the workspace's top bar and
 * one row for the open item (its tab, Share, the view menu and Close). The
 * view choice (Doc / Code / Connections for a file, App / Code / History /
 * Connections for an app) is a menu in that row, not a third row, so the
 * file starts at least 60px higher than the 171px it used to.
 */
const workspaceId = "00000030-0000-4000-8000-000000000001";
const outputId = "00000040-0000-4000-8000-000000000001";
const appPath = `/workspace/${workspaceId}?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece`;
const docPath = `/workspace/${workspaceId}?workpiece=output%3A${outputId}&pane=workpiece`;
/** Where the open item started with three rows above it, at 375 x 812. */
const OLD_CONTENT_TOP = 171;
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	join(tmpdir(), "tedix-workspace-phone-item-row");
await mkdir(evidence, { recursive: true });

// Installing the Doc's editor writes fixture state, so this spec owns its server.
const server = await startFixtureServer("/", { shared: false });
const browser = await chromium.launch({ headless: true });

async function chrome(page: Page) {
	return page.evaluate(() => {
		const box = (selector: string) =>
			document.querySelector(selector)?.getBoundingClientRect();
		const content = box(".canvas-stage-content");
		const rows = [
			...document.querySelectorAll(
				".canvas-workspace-header, .canvas-workpiece-bar",
			),
		].filter((row) => {
			const rect = row.getBoundingClientRect();
			return rect.height > 0 && content && rect.top < content.top;
		}).length;
		// Every control in the item's row shares one line.
		const controls = [
			...(document.querySelector(".canvas-workpiece-bar")?.children ?? []),
		]
			.map((child) => child.getBoundingClientRect())
			.filter((rect) => rect.width > 0 && rect.height > 0);
		const tops = controls.map((rect) => rect.top);
		return {
			rows,
			contentTop: Math.round(content?.top ?? -1),
			barLines:
				tops.length === 0
					? 0
					: Math.max(...tops) - Math.min(...tops) < 8
						? 1
						: 2,
			sideways: document.documentElement.scrollWidth > innerWidth,
		};
	});
}

try {
	const setup = await browser.newPage();
	const response = await setup.request.post(
		`${server.origin}/api/rpc/osWorkspaces/gadgets/installOutputEditor`,
		{ data: { json: { workspaceId, outputId, kind: "document" } } },
	);
	assert(response.ok(), `install the Doc editor: ${await response.text()}`);
	await setup.close();

	for (const width of [375, 390]) {
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport: { width, height: 812 },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: true,
				hasTouch: true,
			});
			const page = await context.newPage();
			page.setDefaultNavigationTimeout(120_000);
			for (const [item, path, views] of [
				["doc", docPath, ["Doc", "Code", "Connections"]],
				["app", appPath, ["App", "Code", "History", "Connections"]],
			] as const) {
				const label = `${width}/${theme}/${item}`;
				await page.goto(`${server.origin}${path}`, {
					waitUntil: "domcontentloaded",
				});
				const menuButton = workpieceViewMenu(page);
				await menuButton.waitFor();
				// Let the open item's own actions (Share) join the row.
				await page.waitForTimeout(1500);

				const layout = await chrome(page);
				assert.equal(
					layout.rows,
					2,
					`${label}: two rows above the open item (top bar, item row)`,
				);
				assert.equal(layout.barLines, 1, `${label}: the item row is one line`);
				assert(
					layout.contentTop <= OLD_CONTENT_TOP - 60,
					`${label}: the item starts at ${layout.contentTop}px, at least 60px above ${OLD_CONTENT_TOP}px`,
				);
				assert.equal(layout.sideways, false, `${label}: no sideways scroll`);
				assert.equal(
					await page
						.getByRole("group", { name: "Active workpiece view" })
						.count(),
					0,
					`${label}: no separate row of view tabs`,
				);
				await page.screenshot({
					path: join(evidence, `${width}-${theme}-${item}.png`),
				});

				// Every view stays one choice away.
				for (const view of views.toReversed()) {
					await menuButton.click();
					const menu = page.getByRole("menu");
					const items = menu.getByRole("menuitemradio");
					await items.first().waitFor();
					assert.deepEqual(
						(await items.allInnerTexts()).map((text) => text.trim()),
						[...views],
						`${label}: the menu lists every view`,
					);
					if (view === views.at(-1))
						await page.screenshot({
							path: join(evidence, `${width}-${theme}-${item}-menu.png`),
						});
					await menu
						.getByRole("menuitemradio", { name: view, exact: true })
						.click();
					await menu.waitFor({ state: "hidden" });
					assert.equal(
						await menuButton.getAttribute("aria-label"),
						`View: ${view}`,
						`${label}: ${view} opens`,
					);
					const after = await chrome(page);
					assert.equal(after.barLines, 1, `${label}/${view}: still one line`);
					assert.equal(
						after.sideways,
						false,
						`${label}/${view}: no sideways scroll`,
					);
				}
			}
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await context.close();
			console.log(`workspace phone item row ${width}/${theme}: ok`);
		}
	}
	console.log(`PASS workspace phone item row; screenshots in ${evidence}`);
} finally {
	await browser.close();
	await server.stop();
}
