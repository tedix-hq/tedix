import assert from "node:assert/strict";
import type { Locator } from "playwright";
import { runShellSpec } from "./shell-harness";

/** The Work header shifts while a view loads; measure once it holds still. */
async function settledBox(locator: Locator) {
	let box = await locator.boundingBox();
	for (let tries = 0; tries < 20; tries++) {
		await locator.page().waitForTimeout(250);
		const next = await locator.boundingBox();
		if (box && next && box.x === next.x && box.y === next.y) return box;
		box = next;
	}
	return box;
}

/**
 * The Work Activity tab sits at the left edge of the Work header, next to the
 * collapsed rail. A pointer crossing the rail on its way to the tab used to
 * open the hover flyout over the tab, so the click landed in the sidebar and
 * the view stayed on Decisions. Each width clicks Activity the way a person
 * does: from the rail, across to the tab.
 */
await runShellSpec(async ({ origin, newPage, rail, capture, pageErrors }) => {
	for (const [width, collapsed] of [
		[800, "1"],
		[900, "1"],
		[1280, "1"],
		[1280, "0"],
	] as const) {
		const page = await newPage({ viewport: { width, height: 800 } });
		await page.addInitScript(
			(value) => localStorage.setItem("tedix-os-sidebar-collapsed", value),
			collapsed,
		);
		await page.goto(`${origin}/work?view=deck`);
		const activity = page.locator(
			'nav[data-slot="bottom-nav"] a[href="/work?view=feed"]',
		);
		await activity.waitFor();
		await page.waitForLoadState("networkidle");
		const box = await settledBox(activity);
		assert(box, `Activity tab has no box at ${width}px`);
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		const target = await page.evaluate(
			([px, py]) =>
				document.elementFromPoint(px, py)?.closest("a")?.getAttribute("href"),
			[x, y],
		);
		assert.equal(
			target,
			"/work?view=feed",
			`Activity is covered at ${width}px`,
		);
		// About 25px per 40ms: a normal, unhurried move from the rail to the tab.
		await page.mouse.move(12, y);
		for (let step = 1; step <= Math.ceil((x - 12) / 25); step++) {
			await page.mouse.move(Math.min(x, 12 + step * 25), y);
			await page.waitForTimeout(40);
		}
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForURL((url) => url.searchParams.get("view") === "feed");
		assert.notEqual(
			await rail(page).first().getAttribute("data-state"),
			"peeking",
			`Sidebar flyout opened on the way to Activity at ${width}px`,
		);
		await capture(page, `work-activity-${width}-${collapsed}`);
		await page.close();
	}
	// The everyday path: rest on the collapsed rail until the flyout opens, pick
	// Work in it, then head right for the Work tabs. Both tabs sit inside the
	// flyout's 260px, so a flyout left open under the pointer swallowed them.
	for (const width of [900, 1280]) {
		const page = await newPage({ viewport: { width, height: 800 } });
		await page.addInitScript(() =>
			localStorage.setItem("tedix-os-sidebar-collapsed", "1"),
		);
		await page.goto(`${origin}/team`);
		const workLink = page.locator('[data-sidebar="menu-button"][href="/work"]');
		await workLink.waitFor();
		await page.waitForLoadState("networkidle");
		const link = await workLink.boundingBox();
		assert(link, `Work rail link has no box at ${width}px`);
		await page.mouse.move(28, link.y + link.height / 2);
		await page.waitForFunction(
			() =>
				document
					.querySelector('[data-sidebar="sidebar"]')
					?.getAttribute("data-state") === "peeking",
		);
		// The open flyout adds the search chip, which moves the Work row down.
		await page.waitForTimeout(400);
		const opened = await workLink.boundingBox();
		assert(opened, `Work flyout link has no box at ${width}px`);
		await page.mouse.move(60, opened.y + opened.height / 2, { steps: 4 });
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForURL((url) => url.pathname === "/work");
		let from = 60;
		// The tabs hold their row whichever view's toolbar has loaded beside them.
		let row: number | undefined;
		for (const [name, view] of [
			["Decisions", "deck"],
			["Activity", "feed"],
		] as const) {
			const tab = page.locator(
				`nav[data-slot="bottom-nav"] a[href="/work?view=${view}"]`,
			);
			await tab.waitFor();
			const box = await settledBox(tab);
			assert(box, `${name} tab has no box at ${width}px`);
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			assert.equal(
				y,
				(row ??= y),
				`Work tabs moved when the view changed at ${width}px`,
			);
			for (let step = 1; step <= 8; step++) {
				await page.mouse.move(from + ((x - from) * step) / 8, y);
				await page.waitForTimeout(40);
			}
			await page.mouse.down();
			await page.mouse.up();
			await page.waitForURL((url) => url.searchParams.get("view") === view, {
				timeout: 5000,
			});
			from = x;
		}
		assert.notEqual(
			await rail(page).first().getAttribute("data-state"),
			"peeking",
			`Sidebar flyout stayed open over the Work tabs at ${width}px`,
		);
		await page.close();
	}
	assert.deepEqual(pageErrors, [], "Work pages must not raise browser errors");
	console.log(
		"PASS: Work tabs reachable past the collapsed sidebar at 800, 900 and 1280px, including after picking Work in the flyout",
	);
});
