import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * A workspace page has at most two navigation rows above the canvas: the
 * workspace's top bar, and the open item's tab row. No control appears twice
 * (one chat toggle, one Files toggle, one presence stack, one place for each
 * view), and every width gets the same structure in both themes.
 */
const appPath =
	"/workspace/00000030-0000-4000-8000-000000000001?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece";

const server = await startFixtureServer("/");
const browser = await chromium.launch({ headless: true });

async function navigationRows(page: Page): Promise<number> {
	// Rows of chrome that stack above the canvas column's content.
	return page.evaluate(() => {
		const rows = [
			...document.querySelectorAll(
				".canvas-workspace-header, .canvas-pane-switcher, .canvas-workpiece-bar, .canvas-desktop-pane-switcher",
			),
		].filter((row) => {
			const box = row.getBoundingClientRect();
			return box.height > 0 && box.width > 0;
		});
		const canvas = document
			.querySelector(".canvas-stage-content")
			?.getBoundingClientRect();
		return rows.filter((row) => {
			const box = row.getBoundingClientRect();
			return !canvas || box.top < canvas.top;
		}).length;
	});
}

try {
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 470, 768, 1280, 1600]) {
			const label = `${width}/${theme}`;
			const phone = width < 700;
			// Below 960px the workbench shows one pane at a time.
			const narrow = width < 960;
			const context = await browser.newContext({
				viewport: { width, height: phone ? 812 : 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
				isMobile: phone,
				hasTouch: phone,
			});
			const page = await context.newPage();
			// One collaborator in the open app, so the roster renders.
			await page.routeWebSocket("**/collab/*/workspace%3A*", (socket) => {
				socket.onMessage((data) => {
					const frame = JSON.parse(String(data));
					if (frame.t !== "base") return;
					socket.send(JSON.stringify({ t: "hello", peerId: 1 }));
					socket.send(
						JSON.stringify({
							t: "base",
							id: frame.id,
							generation: 0,
							revision: 0,
							files: [["document", ""]],
							canonical: { revision: 0, revisionId: null },
						}),
					);
					socket.send(
						JSON.stringify({
							t: "presence",
							peers: [
								[
									2,
									{
										user: {
											key: "p_ada",
											displayName: "Ada Lovelace",
											kind: "human",
											role: "build",
											verified: true,
										},
										location: {
											surface: "canvas",
											artifactKind: "gadget",
											artifactLabel: "Activity",
										},
									},
								],
							],
						}),
					);
				});
			});
			await page.route("**/userSettings/getPreferences", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.preferences.theme = theme;
				return route.fulfill({ response, json: body });
			});
			await page.goto(`${server.origin}${appPath}`, {
				waitUntil: "domcontentloaded",
			});
			await page.getByRole("tab").first().waitFor();
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: theme applied`,
			);

			assert(
				(await navigationRows(page)) <= 2,
				`${label}: at most two navigation rows above the canvas`,
			);
			const switcher = page.locator(".canvas-pane-switcher");
			assert.equal(
				await switcher.count(),
				1,
				`${label}: one pane switcher in the tree`,
			);
			assert.equal(
				await switcher.isVisible(),
				narrow,
				`${label}: the pane switcher is for narrow screens only`,
			);
			assert.deepEqual(
				await page
					.getByRole("group", { name: "Active workpiece view" })
					.getByRole("button")
					.allInnerTexts(),
				["App", "Edit", "History"],
				`${label}: three plain tabs for the open app`,
			);

			// One control per job: a single chat toggle and a single Files toggle,
			// both in the top bar, and nothing named Resources or Outputs.
			for (const name of [/^(Hide|Show) files$/, /^(Hide|Show) chat$/]) {
				const toggles = page.getByRole("button", { name });
				assert.equal(
					await toggles.count(),
					narrow ? 0 : 1,
					`${label}: one ${name} toggle on wide screens, none on narrow ones`,
				);
				if (!narrow)
					assert(
						await toggles.evaluate(
							(button) => !!button.closest(".canvas-workspace-header"),
						),
						`${label}: ${name} sits in the top bar`,
					);
			}

			// Who is here shows once, in the top bar, as tall as its icon buttons.
			const roster = page.getByRole("button", {
				name: "1 collaborator here now. Open collaborator details.",
			});
			await roster.waitFor();
			assert.equal(
				await page.locator(".canvas-presence-trigger").count(),
				1,
				`${label}: exactly one presence stack on the page`,
			);
			assert(
				await roster.evaluate(
					(button) => !!button.closest(".canvas-workspace-header"),
				),
				`${label}: the presence stack sits in the top bar`,
			);
			const share = page.getByRole("button", { name: /^Share\b/ });
			assert.equal(
				(await roster.boundingBox())?.height,
				(await share.boundingBox())?.height,
				`${label}: presence stack is as tall as the icon buttons`,
			);
			await roster.click();
			await page.getByText("In this app", { exact: true }).waitFor();
			await page.keyboard.press("Escape");

			// The title never collapses to an empty segment.
			const emptySegments = await page.evaluate(
				() =>
					[
						...document.querySelectorAll(
							".canvas-workspace-title :is(h1, [data-kumo-part=link], [aria-current=page])",
						),
					].filter((segment) => {
						const box = segment.getBoundingClientRect();
						// Hidden, or kept for assistive technology only.
						if (box.width <= 1 || box.height <= 1) return false;
						return box.width < 24 || !segment.textContent?.trim();
					}).length,
			);
			assert.equal(emptySegments, 0, `${label}: no empty title segment`);

			// The view tabs keep their place whichever view is open.
			const viewTabs = page.getByRole("group", {
				name: "Active workpiece view",
			});
			const tabX: number[] = [];
			for (const view of ["App", "Edit", "History"]) {
				await viewTabs.getByRole("button", { name: view, exact: true }).click();
				await page.waitForTimeout(150);
				tabX.push(Math.round((await viewTabs.boundingBox())?.x ?? -1));
			}
			assert.equal(
				new Set(tabX).size,
				1,
				`${label}: view tabs stay put across App, Edit and History (${tabX})`,
			);
			await viewTabs.getByRole("button", { name: "App", exact: true }).click();

			// The open item's bar is at most two rows, on one left edge.
			const barRows = await page.evaluate(() => {
				const bar = document.querySelector(".canvas-workpiece-bar");
				const boxes = [...(bar?.children ?? [])]
					.map((child) => child.getBoundingClientRect())
					.filter((box) => box.width > 0 && box.height > 0)
					.sort((a, b) => a.top - b.top);
				// A row starts where a control begins below the previous row.
				const rows: { bottom: number; left: number }[] = [];
				for (const box of boxes) {
					const row = rows.at(-1);
					if (row && box.top < row.bottom - 1) {
						row.bottom = Math.max(row.bottom, box.bottom);
						row.left = Math.min(row.left, box.left);
					} else rows.push({ bottom: box.bottom, left: box.left });
				}
				return rows.map((row) => Math.round(row.left));
			});
			assert(barRows.length <= 2, `${label}: item bar is at most two rows`);
			assert.equal(
				new Set(barRows).size,
				1,
				`${label}: item bar rows share one left edge (${barRows})`,
			);
			for (const stale of ["Resources", "Outputs", "Editor"]) {
				assert.equal(
					await page.getByRole("button", { name: stale, exact: true }).count(),
					0,
					`${label}: no "${stale}" control`,
				);
			}
			assert.equal(
				await page.getByRole("button", { name: "Focus", exact: true }).count(),
				phone ? 0 : 1,
				`${label}: one Focus control, none on a phone`,
			);
			// One Share, in the top bar. Sharing the open app alone is a section
			// of its dialog, not a second icon beside History.
			assert.equal(await share.count(), 1, `${label}: one Share control`);
			assert(
				await share.evaluate(
					(button) => !!button.closest(".canvas-workspace-header"),
				),
				`${label}: Share sits in the top bar`,
			);
			await share.click();
			const dialog = page.getByRole("dialog");
			await dialog.getByText("People with access").waitFor();
			// Sharing the open app alone is a scope inside the same dialog, never
			// a popover stacked on top of it.
			await dialog
				.getByRole("button", { name: "This app", exact: true })
				.click();
			await dialog.getByRole("combobox", { name: "General access" }).waitFor();
			assert.equal(await page.getByRole("dialog").count(), 1);
			assert.equal(await page.locator(".kumo-popover-popup").count(), 0);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				`${label}: no sideways page scroll with Share open`,
			);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
				`${label}: no sideways page scroll`,
			);
			// Focus mode (wide screens only) hides the top bar; Share stays
			// reachable from the panel.
			if (!phone) {
				await page.getByRole("button", { name: "Focus", exact: true }).click();
				const focusShare = page.getByRole("button", { name: /^Share\b/ });
				await focusShare.waitFor();
				assert.equal(
					await focusShare.count(),
					1,
					`${label}: one Share in focus`,
				);
				await focusShare.click();
				await page
					.getByRole("dialog")
					.getByText("People with access")
					.waitFor();
				assert.equal(await page.getByRole("dialog").count(), 1);
				await page.keyboard.press("Escape");
				await page.getByRole("dialog").waitFor({ state: "hidden" });
				await page
					.getByRole("button", { name: "Exit focus", exact: true })
					.click();
			}
			// Drop route handlers first: a request still in flight must not
			// reach route.fetch() after the context is gone.
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await context.close();
			console.log(`workspace nav ${label}: ok`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
