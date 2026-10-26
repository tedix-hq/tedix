import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import {
	devices,
	webkit,
	type Browser,
	type Locator,
	type Page,
} from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * Work beyond the Deck on iPhone Safari (WebKit): Feed, Projects, a project,
 * a Work item, Requests, Approvals, Agents, Office, Outbound, Cases, Admission,
 * Clusters and Capacity. Each page
 * keeps to the screen width, keeps its text inside its rows, and keeps its
 * row links 44px tall. Fields keep 16px text (smaller zooms the page on
 * focus) and stay reachable above the software keyboard.
 */
const shots = process.env.TEDIX_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const server = await startFixtureServer("/work");
const { origin } = server;

const PROJECT = "/work/projects/00000076-0000-4000-8000-000000000001";
const ITEM = "/work/items/00000070-0000-4000-8000-000000000001";
const REQUEST = "/work/interactions/000000a7-0000-4000-8000-000000000001";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Pages, each with the element that proves it rendered. */
const PAGES: Array<[string, string]> = [
	["/work?view=feed", ".fd-feed"],
	["/work?view=feed&filter=history", ".fd-feed"],
	["/work?app=portfolio", "[data-project-row]"],
	["/work?app=agents", "[data-agent-state]"],
	["/work?app=office", "#office-for-you-title"],
	[
		"/work?app=outbound",
		"[data-workspace-app-entry=outbound-review] .fd-decision",
	],
	["/work/cases", "[data-mobile-case-row]"],
	["/work/admission", "[aria-label='Work readiness'] li"],
	["/work/clusters", "[aria-label='Work readiness'] li"],
	["/work/capacity", "[data-slot=card] strong"],
	["/work/capacity?view=budgets", "[data-slot=card] strong"],
	["/work/approvals", "[role=tablist][aria-label=Approvals]"],
	["/work/interactions", "[aria-labelledby=interaction-urgent-title]"],
	[PROJECT, "[data-contributor-state]"],
	[ITEM, "textarea"],
	[REQUEST, "textarea"],
	["/outputs", "input[type=search]"],
];

async function settle(page: Page) {
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
	await page.waitForTimeout(150);
}

/** Width, clipping and field-size failures anywhere in the route. */
function layoutFailures(page: Page) {
	return page.evaluate(() => {
		const failures: string[] = [];
		const width = document.documentElement.clientWidth;
		if (document.documentElement.scrollWidth > width + 1)
			failures.push(`page is ${document.documentElement.scrollWidth}px wide`);
		const main = document.querySelector<HTMLElement>("main.route-content")!;
		for (const el of main.querySelectorAll<HTMLElement>("*")) {
			if (!el.getClientRects().length) continue;
			// Screen-reader-only headers retain semantics in stacked tables.
			let visuallyHidden = false;
			for (
				let ancestor: HTMLElement | null = el;
				ancestor && ancestor !== main;
				ancestor = ancestor.parentElement
			) {
				const style = getComputedStyle(ancestor);
				if (
					style.clip.replace(/[ ,]/g, "") === "rect(0px0px0px0px)" ||
					style.clipPath === "inset(50%)"
				) {
					visuallyHidden = true;
					break;
				}
			}
			if (visuallyHidden) continue;
			const box = el.getBoundingClientRect();
			const name = `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}"`;
			const style = getComputedStyle(el);
			if (
				/(auto|scroll)/.test(style.overflowX) &&
				el.scrollWidth > el.clientWidth + 1 &&
				// A tab strip scrolls sideways on purpose, with its own arrows.
				!el.querySelector("[role=tablist]") &&
				!el.closest("[role=tablist], pre, code, .cm-editor")
			)
				failures.push(`${name} scrolls sideways`);
			if (
				el.matches(
					"input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select",
				) &&
				parseFloat(style.fontSize) < 16
			)
				failures.push(`${name} has ${style.fontSize} text and zooms on focus`);
			// Leaf text that runs past the box that clips it is lost.
			if (
				el.children.length ||
				!el.textContent?.trim() ||
				style.textOverflow === "ellipsis"
			)
				continue;
			for (let p = el.parentElement?.parentElement; p; p = p.parentElement) {
				const clip = getComputedStyle(p).overflowX;
				if (!/(hidden|clip|auto|scroll)/.test(clip)) continue;
				// Content a scroller holds can be scrolled into view.
				if (
					/(hidden|clip)/.test(clip) &&
					box.right > p.getBoundingClientRect().right + 2
				)
					failures.push(`${name} is clipped at the right edge`);
				break;
			}
		}
		return failures;
	});
}

/** A touch target: 44px tall, inside the screen, and on top where it says it is. */
async function targetFailures(target: Locator, label: string) {
	await target.evaluate((node) => {
		node.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: "instant",
		});
		return new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
	});
	return target.evaluate((node, label) => {
		const failures: string[] = [];
		const box = node.getBoundingClientRect();
		if (box.height < 43.5)
			failures.push(`${label} is ${Math.round(box.height)}px tall`);
		if (box.width < 43.5)
			failures.push(`${label} is ${Math.round(box.width)}px wide`);
		if (box.left < -1 || box.right > document.documentElement.clientWidth + 1)
			failures.push(`${label} runs off the screen`);
		// Edge midpoints catch covered padding while preserving round buttons.
		const cx = box.left + box.width / 2;
		const cy = box.top + box.height / 2;
		for (const [x, y] of [
			[cx, box.top + 3],
			[box.left + 3, cy],
			[cx, cy],
			[box.right - 3, cy],
			[cx, box.bottom - 3],
		] as const) {
			const hit = document.elementFromPoint(x, y);
			if (!hit || !node.contains(hit))
				failures.push(
					`${label} at x=${Math.round(x - box.left)}, y=${Math.round(y - box.top)} is covered by ${hit?.tagName}.${hit?.className}`,
				);
		}
		return failures;
	}, label);
}

/**
 * The iOS keyboard shrinks the visual viewport only. The field must stay where
 * it is (no layout jump), stay 16px, and its scroller must be able to lift it
 * and the action after it above the keyboard.
 */
async function keyboardFailures(page: Page, field: Locator, action: Locator) {
	await field.scrollIntoViewIfNeeded();
	await field.focus();
	const before = await field.boundingBox();
	await page.evaluate(() => {
		const viewport = window.visualViewport!;
		const height = Math.round(innerHeight * 0.55);
		Object.defineProperty(viewport, "height", {
			configurable: true,
			get: () => height,
		});
		Object.defineProperty(viewport, "offsetTop", {
			configurable: true,
			get: () => 0,
		});
		viewport.dispatchEvent(new Event("resize"));
		viewport.dispatchEvent(new Event("scroll"));
	});
	await settle(page);
	const after = await field.boundingBox();
	const failures: string[] = [];
	if (!before || !after || Math.abs(before.y - after.y) > 1)
		failures.push(`keyboard moved the field ${before?.y} -> ${after?.y}`);
	const reached = await action.evaluate((node) => {
		const visible = window.visualViewport!.height;
		let scroller = node.parentElement;
		while (
			scroller &&
			!(
				/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
				scroller.scrollHeight > scroller.clientHeight
			)
		)
			scroller = scroller.parentElement;
		if (!scroller) return "no scroller";
		scroller.scrollTop += node.getBoundingClientRect().bottom - (visible - 8);
		const box = node.getBoundingClientRect();
		if (box.bottom > visible)
			return `ends at ${box.bottom}, keyboard at ${visible}`;
		if (box.top < scroller.getBoundingClientRect().top)
			return "scrolled under the header";
		const hit = document.elementFromPoint(
			box.left + 8,
			box.top + box.height / 2,
		);
		return hit && node.contains(hit) ? null : `covered by ${hit?.tagName}`;
	});
	if (reached) failures.push(`action above the keyboard: ${reached}`);
	if (
		(await field.evaluate((node) =>
			parseFloat(getComputedStyle(node).fontSize),
		)) < 16
	)
		failures.push("focused field text is under 16px");
	return failures;
}

let browser: Browser | undefined;
const allFailures: string[] = [];
try {
	browser = await webkit.launch({ headless: true });
	for (const width of [390, 1280]) {
		for (const colorScheme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport: { width, height: 844 },
				colorScheme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(theme) => localStorage.setItem("tedix-os-theme", theme),
				colorScheme,
			);
			const page = await context.newPage();
			for (const view of ["feed", "deck"] as const) {
				await page.goto(`${origin}/work?view=${view}`);
				await page
					.locator(
						`[data-workspace-app-entry=${view === "feed" ? "activity-feed" : "decision-deck"}]`,
					)
					.waitFor();
				const headings = page.getByRole("heading", { level: 1 });
				assert.equal(
					await page.locator("vite-error-overlay").count(),
					0,
					`${width} ${colorScheme} ${view}: document scripts load without errors`,
				);
				assert(
					await page.evaluate(() =>
						document.documentElement.style
							.getPropertyValue("--viewport-tedix-height")
							.endsWith("px"),
					),
					`${width} ${colorScheme} ${view}: document viewport metrics are installed`,
				);
				assert.equal(await headings.count(), 1);
				assert.equal(
					await headings.textContent(),
					view === "feed" ? "Feed" : "Deck",
				);
				assert(
					await headings.evaluate((heading) => {
						const box = heading.getBoundingClientRect();
						return (
							box.width <= 1 &&
							box.height <= 1 &&
							[...document.querySelectorAll("h2, h3, h4, h5, h6")].every(
								(other) =>
									Boolean(
										heading.compareDocumentPosition(other) &
										Node.DOCUMENT_POSITION_FOLLOWING,
									),
							)
						);
					}),
					`${width} ${colorScheme} ${view}: hidden page heading precedes content headings`,
				);
				if (shots)
					await page.screenshot({
						path: `${shots}/work-heading-${view}-${width}-${colorScheme}.png`,
					});
			}
			await context.close();
		}
	}
	console.log("Work headings: 8 Feed/Deck viewport/theme checks passed");
	const office = await browser.newPage();
	await office.goto(`${origin}/work?app=office`);
	await office
		.locator("[data-workspace-app-entry=office]")
		.waitFor({ timeout: 20_000 });
	assert.equal(
		await office.getByText("Support tickets are unavailable.").count(),
		0,
		"Office fixture support read should resolve",
	);
	await office.close();
	for (const colorScheme of ["light", "dark"] as const) {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			colorScheme,
			reducedMotion: "reduce",
		});
		await context.addInitScript(
			(theme) => localStorage.setItem("tedix-os-theme", theme),
			colorScheme,
		);
		const page = await context.newPage();
		await page.goto(`${origin}/work/capacity`);
		await page.locator("[data-slot=card] strong").first().waitFor();
		await settle(page);
		assert.deepEqual(
			await layoutFailures(page),
			[],
			`1280x800 ${colorScheme} capacity layout`,
		);
		await context.close();
	}
	for (const [size, device, viewport] of [
		["390x844", devices["iPhone 13"], { width: 390, height: 844 }],
		["375x667", devices["iPhone 8"], { width: 375, height: 667 }],
	] as const)
		for (const colorScheme of ["light", "dark"] as const) {
			const label = `${size} ${colorScheme}`;
			const context = await browser.newContext({
				...device,
				viewport,
				colorScheme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(theme) => localStorage.setItem("tedix-os-theme", theme),
				colorScheme,
			);
			const page = await context.newPage();
			const failures: string[] = [];
			const check = async (path: string, ready: string) => {
				await page.goto(`${origin}${path}`);
				try {
					await page.locator(ready).first().waitFor({ timeout: 20_000 });
				} catch (error) {
					if (shots)
						await page.screenshot({
							path: `${shots}/${size}-${colorScheme}-render-failure.png`,
						});
					throw new Error(
						`${path} did not render: ${await page.locator("main.route-content").innerText()}`,
						{ cause: error },
					);
				}
				await settle(page);
				assert.deepEqual(
					await page.evaluate(() => ({
						width: innerWidth,
						height: innerHeight,
					})),
					viewport,
					`${label} viewport`,
				);
				for (const failure of await layoutFailures(page))
					failures.push(`${path}: ${failure}`);
				if (shots)
					await page.screenshot({
						path: `${shots}/${size}-${colorScheme}-${path.replace(/[^a-z0-9]+/gi, "_").replace(/_[0-9a-f]{8}_0000_4000_8000_0+/, "_")}.png`,
					});
			};
			const targets = async (path: string, locator: Locator, name: string) => {
				const count = await locator.count();
				assert(count > 0, `${label} ${path}: no ${name}`);
				for (let index = 0; index < count; index++)
					for (const failure of await targetFailures(
						locator.nth(index),
						`${name} ${index + 1}`,
					))
						failures.push(`${path}: ${failure}`);
			};

			for (const [path, ready] of PAGES) await check(path, ready);
			if (viewport.width === 375) {
				await check(PROJECT, '[aria-label="Work queue"]');
				const metadata = page.locator('[aria-label="Work queue"] dd');
				assert(
					(await metadata.count()) > 0,
					`${label} ${PROJECT}: no phone metadata`,
				);
				const overflow = await metadata.evaluateAll((cells) =>
					cells.some((cell) => cell.scrollWidth > cell.clientWidth + 1),
				);
				if (overflow)
					failures.push(
						`${PROJECT}: Work queue phone metadata scrolls sideways`,
					);
				// Fixture owner names are short; force a pathological identity to
				// prove the label cannot widen its row and the title keeps the
				// complete value discoverable.
				const owners = page.locator(
					'[aria-label="Work queue"] dd[title^="Owner:"]',
				);
				assert(
					(await owners.count()) > 0,
					`${label} ${PROJECT}: no phone owner metadata`,
				);
				const longOwner =
					"SolsticeLongitudinalOperationsCoordinatorWithoutAnyBreaks";
				const ownerCell = await owners.first().evaluate((cell, name) => {
					const row = cell.closest("li")!;
					// Keep the app's wrapping span and metadata separator intact.
					cell.querySelector("span:last-child")!.textContent = name;
					cell.setAttribute("title", `Owner: ${name}`);
					return {
						page: document.documentElement.scrollWidth,
						viewport: document.documentElement.clientWidth,
						cellRight: cell.getBoundingClientRect().right,
						rowRight: row.getBoundingClientRect().right,
						cellScroll: cell.scrollWidth,
						cellClient: cell.clientWidth,
						title: cell.getAttribute("title"),
					};
				}, longOwner);
				if (ownerCell.page > ownerCell.viewport + 1)
					failures.push(
						`${PROJECT}: a long owner widened the page to ${ownerCell.page}px`,
					);
				if (ownerCell.cellRight > ownerCell.rowRight + 1)
					failures.push(`${PROJECT}: owner label runs past its row`);
				if (ownerCell.cellScroll > ownerCell.cellClient + 1)
					failures.push(`${PROJECT}: owner label scrolls sideways`);
				if (ownerCell.title !== `Owner: ${longOwner}`)
					failures.push(`${PROJECT}: owner title lost the complete value`);
			}
			if (viewport.width === 390) {
				await check("/work/capacity", "[data-slot=card] strong");
				const holder = page
					.locator("[data-slot=card] p")
					.filter({ hasText: "fictional west warehouse" })
					.first();
				assert.equal(await holder.count(), 1, `${label}: no capacity holder`);
				const holderOverflow = await holder.evaluate((node) => ({
					clientWidth: node.clientWidth,
					scrollWidth: node.scrollWidth,
				}));
				if (holderOverflow.scrollWidth > holderOverflow.clientWidth + 1)
					failures.push(
						`/work/capacity: holder details are ${holderOverflow.scrollWidth}px wide in a ${holderOverflow.clientWidth}px row`,
					);
			}
			for (const path of [
				"/work?app=agents",
				"/work?app=office",
				"/work?app=outbound",
				"/work/cases",
				"/work/capacity",
				"/work/capacity?view=budgets",
			]) {
				const ready = PAGES.find(([url]) => url === path)![1];
				await check(path, ready);
				await targets(
					path,
					page.locator(
						"main.route-content a[href]:visible, main.route-content button:visible:not([disabled]), main.route-content input:visible:not([aria-hidden=true]):not([tabindex='-1']), main.route-content summary:visible",
					),
					"view control",
				);
				if (shots && path === "/work?app=office") {
					await page
						.locator("#office-leaderboard-title")
						.scrollIntoViewIfNeeded();
					await page.screenshot({
						path: `${shots}/${size}-${colorScheme}-office-leaderboard.png`,
					});
				}
			}
			await check("/work/cases", "[data-mobile-case-row]");
			await page
				.getByRole("button", { name: "New work stream", exact: true })
				.click();
			for (const failure of await layoutFailures(page))
				failures.push(`/work/cases form: ${failure}`);
			await targets(
				"/work/cases form",
				page.locator(
					"#open-case-form input:visible:not([aria-hidden=true]):not([tabindex='-1']), #open-case-form button:visible",
				),
				"work stream field",
			);

			await check("/work?view=feed", ".focus-today");
			await targets(
				"Today",
				page.locator(".focus-today a[data-link-role=record]"),
				"Today link",
			);

			await check("/work?app=portfolio", "[data-project-row]");
			await targets(
				"Projects",
				page.locator("[data-project-row] a[data-link-role=record]"),
				"project row link",
			);

			// The Work item link once shrank to 2px beside the session name.
			await check(PROJECT, "[data-contributor-state]");
			const contributorLinks = page.locator(
				"[data-contributor-state] a[href^='/work/items/']",
			);
			await targets(PROJECT, contributorLinks, "contributor Work item");
			for (const width of await contributorLinks.evaluateAll((links) =>
				links.map(
					(link) =>
						link.getBoundingClientRect().width /
						link.closest("li")!.getBoundingClientRect().width,
				),
			))
				if (width < 0.6)
					failures.push(
						`${PROJECT}: contributor Work item link is ${Math.round(width * 100)}% of its row`,
					);

			await check("/work/approvals", "[role=tablist][aria-label=Approvals]");
			await page.getByRole("tab", { name: "History" }).click();
			await targets(
				"/work/approvals",
				page.locator("summary", { hasText: "Receipts for past decisions" }),
				"past decisions",
			);

			// Requests read as a list on phones, not a sideways table of UUIDs.
			await check(
				"/work/interactions",
				"[aria-labelledby=interaction-urgent-title]",
			);
			if (await page.locator("table:visible").count())
				failures.push("/work/interactions: a table on a phone");
			const rows = page.locator("[data-mobile-interaction-row]");
			if (await rows.count()) {
				await targets("/work/interactions", rows.locator("a"), "request");
				if (UUID.test(await rows.first().innerText()))
					failures.push("/work/interactions: a request row shows a raw id");
			} else failures.push("/work/interactions: no phone request list");

			await check(ITEM, "textarea");
			await targets(
				ITEM,
				page.getByRole("button", { name: "Copy to clipboard" }),
				"copy link",
			);
			await targets(
				ITEM,
				page.locator("dd a[href^='/work/projects/']"),
				"project link",
			);
			failures.push(
				...(
					await keyboardFailures(
						page,
						page.getByPlaceholder("Share an update or ask a question"),
						page.getByRole("button", { name: "Post comment" }),
					)
				).map((failure) => `${ITEM}: ${failure}`),
			);

			await check(REQUEST, "textarea");
			const evidence = page
				.getByRole("link", { name: "Evidence", exact: true })
				.first();
			const stable = await evidence.evaluate((node) => {
				const text = document.createRange();
				text.selectNodeContents(node);
				const before = text.getBoundingClientRect();
				const parentHeight = node.parentElement!.getBoundingClientRect().height;
				const minHeight = (node as HTMLElement).style.minHeight;
				(node as HTMLElement).style.minHeight = "0px";
				node.classList.remove("tap-target-y");
				const after = text.getBoundingClientRect();
				const same =
					Math.abs(before.y - after.y) < 0.5 &&
					Math.abs(before.x - after.x) < 0.5 &&
					Math.abs(
						parentHeight - node.parentElement!.getBoundingClientRect().height,
					) < 0.5;
				node.classList.add("tap-target-y");
				(node as HTMLElement).style.minHeight = minHeight;
				return same;
			});
			if (!stable)
				failures.push(
					`${REQUEST}: Evidence tap area moves the provenance line`,
				);
			await targets(REQUEST, evidence, "inline Evidence");
			if (shots)
				await page.screenshot({
					path: `${shots}/${size}-${colorScheme}-request-evidence.png`,
				});
			failures.push(
				...(
					await keyboardFailures(
						page,
						page.getByRole("textbox", { name: "Your answer" }),
						page.getByRole("button", { name: "Answer", exact: true }),
					)
				).map((failure) => `${REQUEST}: ${failure}`),
			);
			if (shots)
				await page.screenshot({
					path: `${shots}/${size}-${colorScheme}-request-keyboard.png`,
				});

			await check("/outputs", "input[type=search]");
			await targets(
				"/outputs",
				page.getByRole("searchbox", { name: "Search outputs" }),
				"search",
			);

			allFailures.push(...failures.map((failure) => `${label}: ${failure}`));
			await context.close();
			console.log(`${failures.length ? "FAIL" : "PASS"} ${label}`);
			if (failures.length) console.error(failures.join("\n"));
		}
	assert.deepEqual(allFailures, [], "iPhone Work views");
} finally {
	await browser?.close();
	await server.stop();
}
