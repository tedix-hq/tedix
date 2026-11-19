import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";
import { workpieceViewMenu } from "./workpiece-views";

// The workpiece view switcher (App / Edit / History / Connections) is shell
// chrome shared by every workspace gadget. On a phone its labels must never
// overlap or clip, and every view must stay reachable. Review opens from the
// workspace menu and joins the row only while it shows; when the row is too
// narrow for every segment (chat open beside the app), the selected view
// stays scrolled into sight. Below the 820px tablet line the switcher
// segments and the workspace header actions keep a 44px hit target, and
// keyboard focus stays visible inside the scrolling row. On a phone the views
// fold into one "View" menu in the open item's row instead: every view is a
// thumb-sized choice there, and the button names the view on screen.
const workpiecePath =
	"/workspace/00000030-0000-4000-8000-000000000001?workpiece=gadget%3A00000031-0000-4000-8000-00000000000a&pane=workpiece";
const views = ["App", "Code", "History", "Connections"];
const server = await startFixtureServer("/work");

try {
	for (const [engine, width] of [
		[chromium, 768],
		[webkit, 390],
	] as const) {
		const browser = await engine.launch({ headless: true });
		try {
			const label = `${engine.name()}/${width}`;
			const phone = width < 640;
			const page = await browser.newPage({
				viewport: { width, height: 844 },
				hasTouch: phone,
			});
			await page.goto(`${server.origin}${workpiecePath}`);
			if (phone) {
				const menuButton = workpieceViewMenu(page);
				await menuButton.waitFor();
				assert.equal(
					await page
						.getByRole("group", { name: "Active workpiece view" })
						.count(),
					0,
					`${label}: no view tabs on a phone`,
				);
				const button = await menuButton.boundingBox();
				assert(
					button && button.width >= 44 && button.height >= 44,
					`${label}: the view menu keeps a 44px hit target`,
				);
				for (const view of views.toReversed()) {
					await menuButton.click();
					const menu = page.getByRole("menu");
					await menu
						.getByRole("menuitemradio", { name: view, exact: true })
						.click();
					await menu.waitFor({ state: "hidden" });
					assert.equal(
						await menuButton.getAttribute("aria-label"),
						`View: ${view}`,
						`${label}: ${view} is reachable`,
					);
				}
				// Check the menu's geometry, options and selection once.
				await menuButton.click();
				const items = page.getByRole("menuitemradio");
				await items.first().waitFor();
				assert.deepEqual(
					await items.evaluateAll((rows) =>
						rows.map((row) => [
							row.textContent?.trim(),
							row.getAttribute("aria-checked"),
							row.getBoundingClientRect().height >= 44,
						]),
					),
					views.map((view) => [view, String(view === "App"), true]),
					`${label}: every view has a 44px target and only App is selected`,
				);
				await page.keyboard.press("Escape");
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${label}: no sideways page scroll`,
				);
				// Review opens from the workspace menu; the view menu names it.
				await page.goto(`${server.origin}${workpiecePath}&view=activity`);
				await page
					.getByRole("button", { name: "View: Review", exact: true })
					.waitFor();
				await page.close();
				continue;
			}
			const switcher = page.getByRole("group", {
				name: "Active workpiece view",
			});
			await switcher.waitFor();
			const segments = await switcher.locator("button").evaluateAll((els) =>
				els.map((el) => {
					const box = el.getBoundingClientRect();
					return {
						text: el.textContent ?? "",
						left: box.left,
						right: box.right,
						width: box.width,
						height: box.height,
						clipped: el.scrollWidth > el.clientWidth,
					};
				}),
			);
			assert.deepEqual(
				segments.map((segment) => segment.text),
				views,
				`${label}: exactly these views are offered`,
			);
			for (const [index, segment] of segments.entries()) {
				assert(!segment.clipped, `${label}: ${segment.text} label fits`);
				const next = segments[index + 1];
				if (next)
					assert(
						segment.right <= next.left + 0.5,
						`${label}: ${segment.text} does not overlap ${next.text}`,
					);
				assert(
					segment.width >= 44 && segment.height >= 44,
					`${label}: ${segment.text} keeps a 44px hit target`,
				);
			}
			const headerActions = await page
				.locator(".canvas-workspace-header button")
				.evaluateAll((els) =>
					els
						.filter((el) => el.getBoundingClientRect().width > 0)
						.map((el) => {
							const box = el.getBoundingClientRect();
							return {
								name:
									el.getAttribute("aria-label") ??
									el.getAttribute("title") ??
									el.textContent ??
									"",
								width: box.width,
								height: box.height,
							};
						}),
				);
			assert(
				headerActions.length > 0,
				`${label}: the workspace header shows its actions`,
			);
			for (const action of headerActions) {
				assert(
					action.width >= 44 && action.height >= 44,
					`${label}: header action "${action.name}" is at least 44x44`,
				);
			}
			// A focused view segment keeps its ring inside the scrolling row.
			{
				const focus = await switcher
					.getByRole("button", { name: "History", exact: true })
					.evaluate((el) => {
						el.focus({ focusVisible: true });
						const style = getComputedStyle(el);
						return {
							visible: el.matches(":focus-visible"),
							outlineStyle: style.outlineStyle,
							outlineWidth: style.outlineWidth,
						};
					});
				assert.equal(
					focus.visible,
					true,
					`${label}: a view segment takes keyboard focus`,
				);
				assert.equal(
					focus.outlineStyle,
					"solid",
					`${label}: the focus ring is drawn`,
				);
				assert.equal(
					focus.outlineWidth,
					"2px",
					`${label}: the focus ring is 2px`,
				);
			}
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${label}: no sideways page scroll`,
			);
			for (const view of views.toReversed()) {
				const segment = switcher.getByRole("button", {
					name: view,
					exact: true,
				});
				await segment.click();
				assert.equal(
					await segment.getAttribute("aria-pressed"),
					"true",
					`${label}: ${view} is reachable`,
				);
			}
			// Open straight on Review, which joins the row as its last segment:
			// the row must reveal it unaided.
			await page.goto(`${server.origin}${workpiecePath}&view=activity`);
			await page.waitForFunction(() => {
				const el = document.querySelector(
					'[aria-label="Active workpiece view"]',
				);
				if (!el) return false;
				const view = el.getBoundingClientRect();
				const active = el
					.querySelector('[aria-pressed="true"]')
					?.getBoundingClientRect();
				return (
					active &&
					active.left >= view.left - 0.5 &&
					active.right <= view.right + 0.5 &&
					active.right <= innerWidth + 0.5
				);
			});
			assert.equal(
				await switcher
					.getByRole("button", { name: "Review", exact: true })
					.getAttribute("aria-pressed"),
				"true",
			);
			await page.close();
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
