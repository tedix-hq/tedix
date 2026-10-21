/**
 * Clipped-control check. Crawls every fixture route (plus the dialogs each
 * route opens) at 1280 and 390, light and dark, focuses every control, and
 * fails when a control's border box or focus ring is cut by an overflow
 * ancestor, or when a form field sticks out of its parent's content column.
 *
 * Run: `bun browser-tests/focus-clip.spec.ts`. Set FOCUS_CLIP_TEST_ORIGIN to
 * reuse a running fixture server, FOCUS_CLIP_ROUTES to a comma list to narrow
 * the crawl, FOCUS_CLIP_REPORT to write the findings as JSON.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

type Finding = {
	route: string;
	viewport: string;
	control: string;
	kind: "border" | "ring" | "column" | "focus";
	sides: string;
	overshoot: number;
	clipper: string;
};

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = process.env.FOCUS_CLIP_TEST_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.FOCUS_CLIP_TEST_ORIGIN
	? undefined
	: Bun.spawn(
			[
				"../../node_modules/.bin/vp",
				"dev",
				"--port",
				String(port),
				"--strictPort",
				"--host",
				"127.0.0.1",
			],
			{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
		);

const SEEDS = [
	"/",
	"/work",
	"/work?view=feed",
	"/team",
	"/team/new",
	"/skills",
	"/apps",
	"/explore/apps",
	"/outputs",
	"/blueprints",
	"/brain",
	"/audit",
	"/chat",
	"/workspaces",
	"/admin",
	"/admin/organization",
	"/admin/billing",
	"/admin/api-keys",
	"/admin/connections",
	"/admin/payments",
	"/account/profile",
	"/account/settings",
	"/account/connections",
	"/account/organizations",
	"/account/authorizations",
	"/compute",
	"/gateways",
	"/sites",
	"/install",
];
/*
 * Open defects in surfaces another lane owns, listed so this check guards
 * everything else meanwhile. Each entry names the rule that causes it; delete
 * the entry with the fix (the run fails while a listed defect is gone).
 */
const KNOWN_DEFECTS: { owner: string; control: RegExp; clipper: RegExp }[] = [];
const KEPT_QUERY = ["view", "section", "tab"];
// A cold dev server compiles each route chunk on first visit.
const NAVIGATION = { waitUntil: "domcontentloaded", timeout: 120_000 } as const;
const MAX_ROUTES = 90;

// Same id shapes the fixture pack uses: UUIDs, prefixed ids, long slugs with digits.
function routePattern(href: string) {
	const url = new URL(href, origin);
	const path = url.pathname
		.split("/")
		.map((segment) =>
			/^[0-9a-f-]{16,}$/i.test(segment) ||
			(/\d/.test(segment) && segment.length > 8) ||
			/^(tedi|wi|run|case|out|skill|app|proj|req|ws)[_-]/.test(segment)
				? ":id"
				: segment,
		)
		.join("/");
	const query = KEPT_QUERY.filter((key) => url.searchParams.has(key))
		.map((key) => `${key}=${url.searchParams.get(key)}`)
		.join("&");
	return query ? `${path}?${query}` : path;
}

async function audit(page: Page) {
	// Focus styles are read synchronously, so they must not be mid-transition.
	await page.addStyleTag({
		content:
			"*, *::before, *::after { transition: none !important; animation: none !important; }",
	});
	return page.evaluate(() => {
		const px = (value: string) => Number.parseFloat(value) || 0;
		const describe = (el: Element) => {
			const name =
				el.getAttribute("aria-label") ??
				el.getAttribute("name") ??
				el.getAttribute("placeholder") ??
				(el.textContent ?? "").trim().slice(0, 32);
			const cls = [...el.classList].slice(0, 3).join(".");
			const id =
				el.id && !el.id.startsWith("base-ui-") && !/_r_/.test(el.id)
					? `#${el.id}`
					: "";
			return `${el.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ""}${name ? ` "${name}"` : ""}`;
		};
		const visible = (el: Element) => {
			const css = getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			return (
				css.visibility !== "hidden" &&
				css.display !== "none" &&
				Number(css.opacity) > 0.05 &&
				rect.width > 2 &&
				rect.height > 2 &&
				!el.closest(".sr-only, [hidden], [inert], [aria-hidden='true']")
			);
		};
		// How far the painted edge (outer box-shadow rings, outline) reaches past the border box.
		const paintExtent = (el: Element) => {
			const css = getComputedStyle(el);
			const extent = { top: 0, right: 0, bottom: 0, left: 0 };
			for (const shadow of css.boxShadow.split(/,(?![^(]*\))/)) {
				if (shadow === "none" || shadow.includes("inset")) continue;
				const lengths = (
					shadow
						.replace(
							/rgba?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)|oklab\([^)]*\)/g,
							"",
						)
						.match(/-?[\d.]+px/g) ?? []
				).map(px);
				const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
				// Rings and borders are hard edges; a soft elevation shadow may fade into a clip.
				const reach = spread;
				if (
					blur > 0 ||
					reach <= 0 ||
					/rgba?\([^)]*,\s*0\)|\/\s*0\)/.test(shadow)
				)
					continue;
				extent.top = Math.max(extent.top, reach - y);
				extent.bottom = Math.max(extent.bottom, reach + y);
				extent.left = Math.max(extent.left, reach - x);
				extent.right = Math.max(extent.right, reach + x);
			}
			if (css.outlineStyle !== "none") {
				const reach = px(css.outlineWidth) + px(css.outlineOffset);
				for (const side of ["top", "right", "bottom", "left"] as const)
					extent[side] = Math.max(extent[side], reach);
			}
			return extent;
		};
		const owner = (el: Element) =>
			el.closest(
				"[class*='deck'], [class*='feed'], [class*='decision-card'], [class*='card-review'], [data-deck], [data-feed]",
			)
				? "deck-feed"
				: "";
		const findings: Array<{
			control: string;
			kind: "border" | "ring" | "column" | "focus";
			sides: string;
			overshoot: number;
			clipper: string;
		}> = [];
		const controls = [
			...document.querySelectorAll<HTMLElement>(
				"input:not([type=hidden]), textarea, select, button, a[href], summary, [role=combobox], [role=tab], [role=switch], [role=checkbox], [role=radio], [role=menuitem], [role=option], [contenteditable=true], [tabindex]:not([tabindex='-1'])",
			),
		].filter((el) => visible(el) && !(el as HTMLButtonElement).disabled);
		for (const el of controls) {
			// Focus can paint on the box or on a pseudo-element (a resize rail's bar).
			const look = (target: Element) =>
				[null, "::before", "::after"]
					.map((pseudo) => {
						const css = getComputedStyle(target, pseudo);
						return `${css.outlineStyle === "none" ? "" : `${css.outlineWidth} ${css.outlineColor}`}|${css.boxShadow}|${css.backgroundColor}|${css.borderColor}`;
					})
					.join("/");
			// A dialog may have focused the control already; compare from rest.
			if (document.activeElement === el) el.blur();
			const hadFocus = document.activeElement === el;
			const resting = look(el);
			el.focus({ preventScroll: true });
			if (document.activeElement !== el) continue;
			const rect = el.getBoundingClientRect();
			const reach = paintExtent(el);
			const tag = owner(el);
			const control = `${tag ? "[deck-feed] " : ""}${describe(el)}`;
			// Buttons, links and tabs must show that they hold focus.
			if (
				el.matches("button, a[href], [role=tab]") &&
				!hadFocus &&
				look(el) === resting &&
				!el.matches(":has(:focus-visible)")
			)
				findings.push({
					control,
					kind: "focus",
					sides: "",
					overshoot: 0,
					clipper: "no focus indicator",
				});
			let node: Element | null = el.parentElement;
			let scrolledAway = false;
			while (node && node !== document.documentElement) {
				const css = getComputedStyle(node);
				const clipsX = css.overflowX !== "visible";
				const clipsY = css.overflowY !== "visible";
				if (clipsX || clipsY) {
					const box = node.getBoundingClientRect();
					const margin =
						css.overflowX === "clip" || css.overflowY === "clip"
							? px(css.overflowClipMargin)
							: 0;
					const left = box.left + node.clientLeft - margin;
					const top = box.top + node.clientTop - margin;
					const clip = {
						left,
						top,
						right: left + node.clientWidth + 2 * margin,
						bottom: top + node.clientHeight + 2 * margin,
					};
					const scrollsX =
						css.overflowX !== "hidden" &&
						css.overflowX !== "clip" &&
						node.scrollWidth > node.clientWidth + 1;
					const scrollsY =
						css.overflowY !== "hidden" &&
						css.overflowY !== "clip" &&
						node.scrollHeight > node.clientHeight + 1;
					const inside = {
						left: rect.left >= clip.left - 0.5,
						right: rect.right <= clip.right + 0.5,
						top: rect.top >= clip.top - 0.5,
						bottom: rect.bottom <= clip.bottom + 0.5,
					};
					const intersects =
						rect.right > clip.left &&
						rect.left < clip.right &&
						rect.bottom > clip.top &&
						rect.top < clip.bottom;
					// Scrolled out of this container's view is not clipping; outer clips are moot.
					if (
						!intersects ||
						(scrollsX && !(inside.left && inside.right)) ||
						(scrollsY && !(inside.top && inside.bottom))
					)
						break;
					// A border box cut on an axis the container cannot scroll is always a defect.
					const borderCut: string[] = [];
					let borderOver = 0;
					for (const [side, axisClips, scrolls, over] of [
						["left", clipsX, scrollsX, clip.left - rect.left],
						["right", clipsX, scrollsX, rect.right - clip.right],
						["top", clipsY, scrollsY, clip.top - rect.top],
						["bottom", clipsY, scrollsY, rect.bottom - clip.bottom],
					] as const) {
						if (axisClips && !scrolls && over > 0.5 && over < 48) {
							borderCut.push(side);
							borderOver = Math.max(borderOver, over);
						}
					}
					if (borderCut.length)
						findings.push({
							control,
							kind: "border",
							sides: borderCut.join(","),
							overshoot: Math.round(borderOver * 10) / 10,
							clipper: describe(node),
						});
					// A fully visible control whose ring or outline is cut.
					else if (inside.left && inside.right && inside.top && inside.bottom) {
						const ringCut: string[] = [];
						let ringOver = 0;
						// On a scrolling axis only the scroll extent clips for good;
						// any other edge is just the current scroll position.
						const atStart = (scrolls: boolean, offset: number) =>
							!scrolls || Math.abs(offset) <= 1;
						const atEnd = (scrolls: boolean, offset: number, max: number) =>
							!scrolls || Math.abs(offset) >= max - 1;
						for (const [side, axisClips, over, edge] of [
							[
								"left",
								clipsX,
								clip.left - (rect.left - reach.left),
								atStart(scrollsX, node.scrollLeft),
							],
							[
								"right",
								clipsX,
								rect.right + reach.right - clip.right,
								atEnd(
									scrollsX,
									node.scrollLeft,
									node.scrollWidth - node.clientWidth,
								),
							],
							[
								"top",
								clipsY,
								clip.top - (rect.top - reach.top),
								atStart(scrollsY, node.scrollTop),
							],
							[
								"bottom",
								clipsY,
								rect.bottom + reach.bottom - clip.bottom,
								atEnd(
									scrollsY,
									node.scrollTop,
									node.scrollHeight - node.clientHeight,
								),
							],
						] as const) {
							if (axisClips && over > 0.5) {
								if (!edge) scrolledAway = true;
								else {
									ringCut.push(side);
									ringOver = Math.max(ringOver, over);
								}
							}
						}
						if (ringCut.length)
							findings.push({
								control,
								kind: "ring",
								sides: ringCut.join(","),
								overshoot: Math.round(ringOver * 10) / 10,
								clipper: describe(node),
							});
					}
				}
				if (scrolledAway) break;
				if (css.position === "fixed") break;
				node = node.parentElement;
			}
			// Form fields stay inside the parent's content column.
			if (el.matches("input, textarea, select, [role=combobox]")) {
				const parent = el.parentElement;
				if (parent && getComputedStyle(parent).display !== "contents") {
					const box = parent.getBoundingClientRect();
					const css = getComputedStyle(parent);
					const left = box.left + parent.clientLeft + px(css.paddingLeft);
					const right =
						box.left +
						parent.clientLeft +
						parent.clientWidth -
						px(css.paddingRight);
					const over = Math.max(left - rect.left, rect.right - right);
					if (over > 0.5 && parent.scrollWidth <= parent.clientWidth + 1)
						findings.push({
							control,
							kind: "column",
							sides: left - rect.left > 0.5 ? "left" : "right",
							overshoot: Math.round(over * 10) / 10,
							clipper: describe(parent),
						});
				}
			}
			el.blur();
		}
		return findings;
	});
}

async function settle(page: Page) {
	// Live lanes keep sockets open, so wait for rendered content rather than network idle.
	await page
		.waitForFunction(
			() =>
				document.querySelector("main, [role=dialog]") &&
				!document.querySelector("[aria-busy=true], [data-slot=skeleton]"),
			undefined,
			{ timeout: 4000 },
		)
		.catch(() => {});
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(150);
	await page
		.waitForFunction(
			() => document.getAnimations().every((a) => a.playState !== "running"),
			undefined,
			{ timeout: 3000 },
		)
		.catch(() => {});
}

let browser: Browser | undefined;
const findings: Finding[] = [];
try {
	for (let i = 0; i < 150; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		if (i === 149) throw new Error("Fixture server did not start");
		await Bun.sleep(200);
	}
	browser = await chromium.launch({ headless: true });

	// Discover one URL per route pattern from the seeds and the links they render.
	const routes = new Map<string, string>();
	const narrowed = process.env.FOCUS_CLIP_ROUTES?.split(",").filter(Boolean);
	if (narrowed)
		for (const route of narrowed) routes.set(routePattern(route), route);
	else {
		const crawler = await browser.newPage({
			viewport: { width: 1280, height: 900 },
		});
		const queue = [...SEEDS];
		while (queue.length && routes.size < MAX_ROUTES) {
			const next = queue.shift()!;
			const pattern = routePattern(next);
			if (routes.has(pattern)) continue;
			routes.set(pattern, next);
			await crawler.goto(`${origin}${next}`, NAVIGATION);
			await settle(crawler);
			const hrefs = await crawler.$$eval("a[href^='/']", (links) =>
				links.map((link) => link.getAttribute("href")!),
			);
			for (const href of hrefs) {
				if (/^\/(auth|login|logout|cli|oauth|api|browser-tests)\b/.test(href))
					continue;
				if (!routes.has(routePattern(href))) queue.push(href);
			}
		}
		await crawler.close();
	}
	console.log(`Checking ${routes.size} routes`);

	const configs = [
		{ width: 1280, height: 900 },
		{ width: 390, height: 844 },
	].flatMap((viewport) =>
		(["light", "dark"] as const).map((theme) => ({ viewport, theme })),
	);
	await Promise.all(
		configs.map(async ({ viewport, theme }) => {
			const label = `${viewport.width}-${theme}`;
			const page = await browser.newPage({ viewport, colorScheme: theme });
			await page.addInitScript(
				(value) => localStorage.setItem("tedix-os-theme", value),
				theme,
			);
			for (const route of routes.values()) {
				await page.goto(`${origin}${route}`, NAVIGATION);
				await settle(page);
				// Keyboard modality, so `:focus-visible` rings paint like a real Tab.
				await page.keyboard.press("Shift");
				const record = (
					hits: Omit<Finding, "route" | "viewport">[],
					at: string,
				) => {
					for (const hit of hits)
						findings.push({ route: at, viewport: label, ...hit });
				};
				record(await audit(page), route);
				// Open disclosures (collapsibles, expandable rows) show their panels' controls.
				const disclosures = page.locator(
					"main button[aria-expanded='false']:not([aria-haspopup]):visible",
				);
				const closed = Math.min(await disclosures.count(), 6);
				if (closed) {
					for (let i = closed - 1; i >= 0; i--)
						await disclosures
							.nth(i)
							.click({ timeout: 2000 })
							.catch(() => {});
					await settle(page);
					await page.keyboard.press("Shift");
					record(await audit(page), `${route} › expanded`);
					await page.goto(`${origin}${route}`, NAVIGATION);
					await settle(page);
				}
				// Dialogs and sheets the route opens are part of its surface.
				const triggers = page.locator("main [aria-haspopup='dialog']:visible");
				const count = Math.min(await triggers.count(), 4);
				for (let i = 0; i < count; i++) {
					const trigger = triggers.nth(i);
					const name =
						(await trigger.getAttribute("aria-label")) ??
						(await trigger.innerText().catch(() => "")).trim().slice(0, 24);
					await trigger.click({ timeout: 2000 }).catch(() => {});
					const dialog = page.locator("[role=dialog]:visible").first();
					if (await dialog.isVisible().catch(() => false)) {
						await settle(page);
						await page.keyboard.press("Shift");
						record(await audit(page), `${route} › ${name}`);
					}
					await page.keyboard.press("Escape");
					await page
						.locator("[role=dialog]:visible")
						.first()
						.waitFor({ state: "hidden", timeout: 2000 })
						.catch(() => {});
				}
			}
			await page.close();
			console.log(`Audited ${label}`);
		}),
	);

	const unique = new Map<string, Finding & { seen: string[] }>();
	for (const finding of findings) {
		const key = `${finding.route}|${finding.control}|${finding.kind}`;
		const existing = unique.get(key);
		if (existing) {
			if (!existing.seen.includes(finding.viewport))
				existing.seen.push(finding.viewport);
		} else unique.set(key, { ...finding, seen: [finding.viewport] });
	}
	const report = [...unique.values()];
	if (process.env.FOCUS_CLIP_REPORT)
		await writeFile(
			process.env.FOCUS_CLIP_REPORT,
			JSON.stringify(report, null, 2),
		);
	const known = (hit: Finding) =>
		KNOWN_DEFECTS.findIndex(
			(defect) =>
				defect.control.test(hit.control) && defect.clipper.test(hit.clipper),
		);
	const open = report.filter((hit) => known(hit) < 0);
	const fixed = KNOWN_DEFECTS.filter(
		(_, index) => !report.some((hit) => known(hit) === index),
	);
	for (const hit of report)
		console.log(
			`${known(hit) < 0 ? "" : "known  "}${hit.kind.padEnd(6)} ${hit.route} :: ${hit.control} — ${hit.sides} ${hit.overshoot}px by ${hit.clipper} [${hit.seen.join(" ")}]`,
		);
	assert.equal(
		open.length,
		0,
		`${open.length} controls are clipped or leave their content column`,
	);
	// The list only shrinks: a defect that no longer reproduces must be removed.
	if (!narrowed)
		assert.deepEqual(
			fixed.map((defect) => defect.owner),
			[],
			"Remove known defects that no longer reproduce",
		);
	console.log(`PASS: no clipped controls across ${routes.size} routes`);
} finally {
	await browser?.close();
	if (server) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {}
	}
}
