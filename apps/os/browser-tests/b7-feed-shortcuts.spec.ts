import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { tmpdir } from "node:os";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer(
	"/browser-tests/feed-deck-polish.html",
	{ stdout: "ignore" },
);
const { origin } = server;
assert(
	["127.0.0.1", "localhost"].includes(new URL(origin).hostname),
	"Use an isolated local fixture server",
);
const receipts =
	process.env.B7_FEED_RECEIPTS ?? `${tmpdir()}/b7-feed-shortcut-ownership`;
await mkdir(receipts, { recursive: true });
let browser: Browser | undefined;
const results = [];
try {
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 1440, height: 1000 },
		{ width: 390, height: 844 },
		{ width: 375, height: 667 },
	]) {
		for (const theme of ["light", "dark"]) {
			const page = await browser.newPage({
				viewport,
				colorScheme: theme as "light" | "dark",
				isMobile: viewport.width < 600,
				hasTouch: viewport.width < 600,
				reducedMotion: "reduce",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error")
					errors.push(`${message.text()} (${message.location().url})`);
			});
			await page.route(
				"**/api/rpc/workInteractions/refreshDecisionSources",
				(route) =>
					route.fulfill({
						contentType: "application/json",
						body: JSON.stringify({
							json: { created: 0, superseded: 0, scanned: 0, hasMore: false },
						}),
					}),
			);
			await page.goto(
				`${origin}/browser-tests/feed-deck-polish.html?shell&surface=feed&theme=${theme}`,
			);
			const rows = page.locator("[data-focus-row]");
			await rows.nth(1).waitFor();
			await page.evaluate(() => {
				// Observe the actual shortcut click dispatch without navigating or changing fixture rows.
				document.body.dataset.shortcutClicks = "[]";
				document.addEventListener(
					"click",
					(event) => {
						const node = (event.target as Element).closest(
							'[data-focus-row] a,[data-focus-row] button[aria-label="Pin"],[data-focus-row] button[aria-label="Hide"],[data-focus-row] button[aria-label="Not important"]',
						);
						if (!node) return;
						const clicks = JSON.parse(document.body.dataset.shortcutClicks!);
						clicks.push({
							row: node
								.closest("[data-focus-row]")!
								.getAttribute("data-focus-row"),
							action: node.getAttribute("aria-label") ?? "open",
						});
						document.body.dataset.shortcutClicks = JSON.stringify(clicks);
						event.preventDefault();
						event.stopImmediatePropagation();
					},
					true,
				);
			});
			const clicks = () =>
				page.evaluate(() => JSON.parse(document.body.dataset.shortcutClicks!));
			const feed = page.locator('[data-workspace-app-entry="activity-feed"]');
			const shell = page.locator(".fd-work-navigation a").first();
			await shell.focus();
			for (const key of ["j", "k", "o", "p", "h", "n"])
				await page.keyboard.press(key);
			assert(
				await shell.evaluate((node) => node === document.activeElement),
				"Sibling focus stays in shell",
			);
			assert.deepEqual(
				await clicks(),
				[],
				"Sibling keys never dispatch Feed clicks",
			);
			assert.equal(await feed.getAttribute("role"), "region");
			assert.equal(await feed.getAttribute("aria-label"), "Feed");
			await feed.focus();
			assert(
				await feed.evaluate(
					(node) =>
						node.matches(":focus-visible") &&
						getComputedStyle(node).outlineStyle === "solid",
				),
				"Feed shows a focus ring under keyboard focus",
			);
			for (const key of ["o", "p", "h", "n"]) await page.keyboard.press(key);
			assert.deepEqual(
				await clicks(),
				[],
				"Feed entry has no implicit first-row action",
			);
			await page.keyboard.press("j");
			assert(
				await rows.nth(0).evaluate((node) => node === document.activeElement),
			);
			await page.keyboard.press("j");
			assert(
				await rows.nth(1).evaluate((node) => node === document.activeElement),
			);
			await page.keyboard.press("k");
			assert(
				await rows.nth(0).evaluate((node) => node === document.activeElement),
			);
			const rowId = await rows.first().getAttribute("data-focus-row");
			for (const key of ["o", "p", "h", "n"]) await page.keyboard.press(key);
			assert.deepEqual(
				await clicks(),
				["open", "Pin", "Hide", "Not important"].map((action) => ({
					row: rowId,
					action,
				})),
				"Each row action dispatches once",
			);
			await page.evaluate(() => {
				document.body.dataset.shortcutClicks = "[]";
			});
			const more = rows
				.first()
				.getByRole("button", { name: "More actions", exact: true });
			await more.click();
			const menu = page.getByRole("menu");
			await menu.waitFor();
			// The menu moves focus in after it opens; keys pressed before that are not its keys.
			await page.waitForFunction(() =>
				document.querySelector("[role=menu]")?.contains(document.activeElement),
			);
			assert(
				await menu.evaluate(
					(node) => !node.closest('[data-workspace-app-entry="activity-feed"]'),
				),
				"Kumo menu is portalled outside Feed",
			);
			for (const key of ["p", "h", "n", "o", "j", "k"]) {
				await page.keyboard.press(key);
				assert(
					await menu.evaluate((node) => node.contains(document.activeElement)),
					`Menu retains ${key}`,
				);
			}
			assert.deepEqual(await clicks(), []);
			const menuTarget = await menu.getByRole("menuitem").first().boundingBox();
			const tag = `${viewport.width}x${viewport.height}-${theme}`;
			await page.screenshot({ path: `${receipts}/${tag}-menu.png` });
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });
			await page.evaluate(async () => {
				const React = (await import("/node_modules/.vite/deps/react.js"))
					.default;
				const { createRoot } = (
					await import("/node_modules/.vite/deps/react-dom_client.js")
				).default;
				const {
					Dialog,
					DialogTrigger,
					DialogContent,
					DialogTitle,
					DialogDescription,
				} = await import("/src/components/kumo/dialog.tsx");
				const host = document.createElement("div");
				document.querySelector("header")!.append(host);
				const h = React.createElement;
				createRoot(host).render(
					h(
						Dialog,
						null,
						h(DialogTrigger, null, "Open shortcut dialog"),
						h(
							DialogContent,
							null,
							h(DialogTitle, null, "Shortcut ownership"),
							h(DialogDescription, null, "Keys stay with this dialog."),
							h("input", { "aria-label": "Dialog draft" }),
						),
					),
				);
			});
			await page.getByRole("button", { name: "Open shortcut dialog" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.waitFor();
			assert(
				await dialog.evaluate(
					(node) => !node.closest('[data-workspace-app-entry="activity-feed"]'),
				),
				"Kumo dialog is portalled",
			);
			const close = dialog.getByRole("button", { name: "Close", exact: true });
			await close.focus();
			for (const key of ["p", "h", "n", "o", "j", "k"]) {
				await page.keyboard.press(key);
				assert(
					await dialog.evaluate((node) =>
						node.contains(document.activeElement),
					),
					`Dialog retains ${key}`,
				);
			}
			const draft = dialog.getByRole("textbox", { name: "Dialog draft" });
			await draft.fill("");
			await draft.pressSequentially("ophnjk");
			assert.equal(await draft.inputValue(), "ophnjk");
			assert.deepEqual(await clicks(), []);
			await page.screenshot({ path: `${receipts}/${tag}-dialog.png` });
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			await rows.first().focus();
			await page.keyboard.press("j");
			assert(
				await rows.nth(1).evaluate((node) => node === document.activeElement),
				"Feed navigation resumes after portal close",
			);
			const geometry = await page.evaluate(() => ({
				viewport: { width: innerWidth, height: innerHeight },
				dark: document.documentElement.classList.contains("dark"),
				colorScheme: getComputedStyle(document.documentElement).colorScheme,
				overflow: document.documentElement.scrollWidth > innerWidth,
				focus: document.activeElement?.getAttribute("data-focus-row"),
			}));
			assert.deepEqual(geometry.viewport, viewport);
			assert.equal(geometry.dark, theme === "dark");
			assert.equal(geometry.overflow, false);
			const phoneTarget = await more.boundingBox();
			if (viewport.width < 600) {
				assert(
					phoneTarget && phoneTarget.width >= 44 && phoneTarget.height >= 44,
					"More actions has a 44px phone target",
				);
				assert(
					menuTarget && menuTarget.height >= 44,
					"Menu items have a 44px phone target",
				);
			}
			assert.deepEqual(errors, [], "No console or page errors");
			await page.screenshot({ path: `${receipts}/${tag}-feed.png` });
			results.push({ theme, ...geometry, phoneTarget, menuTarget, errors });
			await page.close();
		}
	}
	await writeFile(
		`${receipts}/browser-receipts.json`,
		JSON.stringify(results, null, 2),
	);
	console.log(
		`Feed shortcut regression passed: ${results.length} viewport/theme combinations`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
