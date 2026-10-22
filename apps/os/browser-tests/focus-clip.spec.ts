/**
 * Clipped-control check. Crawls every fixture route (plus the dialogs each
 * route opens) at 1280 and 390, light and dark, focuses every control, and
 * fails when a control's border box or focus ring is cut by an overflow
 * ancestor, or when a form field sticks out of its parent's content column.
 *
 * Run: `bun browser-tests/focus-clip.spec.ts`. Set FOCUS_CLIP_TEST_ORIGIN to
 * reuse a running fixture server, FOCUS_CLIP_ROUTES to a comma list to narrow
 * the crawl, FOCUS_CLIP_REPORT to write the findings as JSON.
 * FOCUS_CLIP_SCREENSHOTS saves Work loading/error images to an existing directory.
 * `--shard i/n` audits only every n-th viewport/theme config.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";
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

// `--shard i/n` (the CI matrix) audits every n-th viewport/theme config.
const shardFlag = process.argv.indexOf("--shard");
const [shard, shardCount] =
	shardFlag < 0
		? [1, 1]
		: (process.argv[shardFlag + 1] ?? "").split("/").map(Number);
assert(
	Number.isInteger(shard) &&
		Number.isInteger(shardCount) &&
		shard! >= 1 &&
		shard! <= shardCount!,
	`Invalid --shard ${process.argv[shardFlag + 1]}`,
);
const configs = [
	{ width: 1280, height: 900 },
	{ width: 390, height: 844 },
]
	.flatMap((viewport) =>
		(["light", "dark"] as const).map((theme) => ({ viewport, theme })),
	)
	.filter((_, index) => index % shardCount! === shard! - 1);
// Readiness budgets assume about two cores per page beside the dev server.
const pages = Math.max(1, Math.floor(availableParallelism() / 2));
const CRAWL_PAGES = Math.min(3, pages);
const PAGES_PER_CONFIG = Math.max(
	1,
	Math.min(2, Math.floor(pages / configs.length)),
);

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
			{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
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

// Normal route crawls miss transient loading and failed first reads.
async function auditWorkText(page: Page, label: string) {
	const endpoint = "**/api/rpc/osWorkspaces/gadgets/workApps";
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(endpoint, async (route) => {
		await pending;
		await route.fulfill({
			status: 400,
			json: {
				json: {
					code: "BAD_REQUEST",
					message: "Fixture read failed",
					defined: false,
					status: 400,
				},
			},
		});
	});
	try {
		await page.goto(`${origin}/work`, NAVIGATION);
		for (const state of ["loading", "error"] as const) {
			if (state === "error") release();
			const text = page.getByText(
				state === "loading"
					? "Loading your Work apps…"
					: "Your Work apps could not be loaded.",
				{ exact: true },
			);
			await text.waitFor({ timeout: 60_000 });
			await page.evaluate(() => document.fonts.ready);
			if (process.env.FOCUS_CLIP_SCREENSHOTS)
				await page.screenshot({
					path: `${process.env.FOCUS_CLIP_SCREENSHOTS}/work-${state}-${label}.png`,
				});
			const cuts = await text.evaluate((element) => {
				const range = document.createRange();
				range.selectNodeContents(element);
				const rects = [...range.getClientRects()];
				const clips = [
					{
						left: 0,
						right: innerWidth,
						top: 0,
						bottom: innerHeight,
						x: true,
						y: true,
						name: "viewport",
					},
				];
				for (
					let parent = element.parentElement;
					parent;
					parent = parent.parentElement
				) {
					const css = getComputedStyle(parent);
					const box = parent.getBoundingClientRect();
					clips.push({
						left: box.left + parent.clientLeft,
						right: box.left + parent.clientLeft + parent.clientWidth,
						top: box.top + parent.clientTop,
						bottom: box.top + parent.clientTop + parent.clientHeight,
						x: css.overflowX !== "visible",
						y: css.overflowY !== "visible",
						name: parent.className,
					});
				}
				return clips.flatMap((clip) =>
					rects
						.filter(
							(rect) =>
								(clip.x &&
									(rect.left < clip.left - 0.5 ||
										rect.right > clip.right + 0.5)) ||
								(clip.y &&
									(rect.top < clip.top - 0.5 ||
										rect.bottom > clip.bottom + 0.5)),
						)
						.map((rect) => ({ clip, text: rect.toJSON() })),
				);
			});
			console.log(`Work ${state} ${label}: ${JSON.stringify(cuts)}`);
			assert.deepEqual(cuts, [], `Work ${state} text clipped at ${label}`);
		}
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
}

type ReadinessPhase = "route" | "content" | "animations";

// Runs in the page: only the rendered route and open dialogs own loading state.
function readiness({
	phase,
	diagnostic = false,
}: {
	phase: ReadinessPhase;
	diagnostic?: boolean;
}) {
	const visible = (element: Element) => element.checkVisibility();
	const main = document.querySelector("main");
	const regions = [
		...document.querySelectorAll("main, [role=dialog], [role=alertdialog]"),
	].filter(visible);
	const live = (element: Element) => {
		const stream = element.closest(
			"[data-slot=streaming-bubble][data-streaming=true], [data-slot=streaming-phase], [data-slot=running-indicator]",
		);
		return (
			!!stream?.textContent?.trim() &&
			!stream.querySelector("[data-slot=skeleton]")
		);
	};
	const busy = regions
		.flatMap((region) => [
			region,
			...region.querySelectorAll("[aria-busy=true], [data-slot=skeleton]"),
		])
		.filter(
			(element) =>
				element.matches("[aria-busy=true], [data-slot=skeleton]") &&
				visible(element) &&
				!live(element),
		);
	const pending = busy.filter((element) =>
		element.matches(
			"main, main > [aria-busy=true], [data-slot=page][aria-busy=true]",
		),
	);
	const animations = document.getAnimations().filter((animation) => {
		if (animation.playState !== "running") return false;
		// Scroll/view timelines describe a static scroll position, not unfinished motion.
		if (animation.timeline !== document.timeline) return false;
		const target =
			animation.effect instanceof KeyframeEffect
				? animation.effect.target
				: null;
		return !(
			target instanceof Element &&
			live(target) &&
			animation.effect?.getComputedTiming().iterations === Infinity
		);
	});
	const blocked = phase === "route" ? pending : busy;
	const ready =
		!!main &&
		visible(main) &&
		!!main.textContent?.trim() &&
		blocked.length === 0 &&
		(phase !== "animations" || animations.length === 0);
	return diagnostic
		? {
				phase,
				ready,
				busy: blocked.map((element) => element.outerHTML.slice(0, 350)),
				animations: animations.map((animation) => ({
					timing: animation.effect?.getComputedTiming(),
					target:
						animation.effect instanceof KeyframeEffect &&
						animation.effect.target instanceof Element
							? animation.effect.target.outerHTML.slice(0, 250)
							: null,
				})),
			}
		: ready;
}

async function settle(page: Page) {
	// Loader boundaries and the mounted component have separate ready signals.
	for (const phase of ["route", "content", "animations"] as const) {
		if (phase === "animations") await page.evaluate(() => document.fonts.ready);
		try {
			await page.waitForFunction(
				readiness,
				{ phase },
				{ timeout: phase === "animations" ? 3000 : 4000 },
			);
		} catch (cause) {
			throw new Error(
				`Readiness failed at ${page.url()}: ${JSON.stringify(await page.evaluate(readiness, { phase, diagnostic: true }))}`,
				{ cause },
			);
		}
	}
}

async function auditRoute(page: Page, route: string, label: string) {
	try {
		const routeStarted = performance.now();
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
				// Focus can reveal a sibling hover toolbar over the pointer.
				await disclosures.nth(i).press("Space", { timeout: 2000 });
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
				(await trigger.innerText()).trim().slice(0, 24);
			if (!(await trigger.isEnabled())) {
				console.log(`Disabled dialog trigger ${label} ${route} ${name}`);
				continue;
			}
			await trigger.press("Enter", { timeout: 2000 });
			const dialog = page
				.locator("[role=dialog]:visible, [role=alertdialog]:visible")
				.first();
			await dialog.waitFor({ state: "visible", timeout: 2000 });
			await settle(page);
			await page.keyboard.press("Shift");
			record(await audit(page), `${route} › ${name}`);
			console.log(
				`Dialog ${label} ${route} › ${name}: ${await dialog.getAttribute("role")}`,
			);
			if ((await dialog.getAttribute("role")) === "alertdialog")
				await dialog
					.getByRole("button", { name: "Cancel", exact: true })
					.press("Enter", { timeout: 2000 });
			else await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden", timeout: 2000 });
		}
		console.log(
			`Route ${label} ${route}: ${Math.round(performance.now() - routeStarted)} ms`,
		);
	} catch (cause) {
		throw new Error(`Audit failed for ${label} ${route}`, {
			cause,
		});
	}
}

let browser: Browser | undefined;
const findings: Finding[] = [];
try {
	await waitForFixtureServer(origin, { server });
	browser = await chromium.launch({ headless: true });

	// Discover one URL per route pattern from the seeds and the links they render.
	const routes = new Map<string, string>();
	const narrowed = process.env.FOCUS_CLIP_ROUTES?.split(",").filter(Boolean);
	if (narrowed)
		for (const route of narrowed) routes.set(routePattern(route), route);
	else {
		const crawlers = await Promise.all(
			Array.from({ length: CRAWL_PAGES }, () =>
				browser!.newPage({ viewport: { width: 1280, height: 900 } }),
			),
		);
		const queue = [...SEEDS];
		try {
			while (queue.length && routes.size < MAX_ROUTES) {
				const batch: string[] = [];
				while (
					queue.length &&
					batch.length < crawlers.length &&
					routes.size < MAX_ROUTES
				) {
					const next = queue.shift()!;
					const pattern = routePattern(next);
					if (routes.has(pattern)) continue;
					routes.set(pattern, next);
					batch.push(next);
				}
				const results = await Promise.all(
					batch.map(async (route, index) => {
						const started = performance.now();
						const crawler = crawlers[index]!;
						await crawler.goto(`${origin}${route}`, NAVIGATION);
						await settle(crawler);
						const hrefs = await crawler.$$eval("a[href^='/']", (links) =>
							links.map((link) => link.getAttribute("href")!),
						);
						console.log(
							`Crawl ${route}: ${Math.round(performance.now() - started)} ms`,
						);
						return hrefs;
					}),
				);
				// Consume links in queue order, independent of which page finished first.
				for (const hrefs of results)
					for (const href of hrefs) {
						if (
							/^\/(auth|login|logout|cli|oauth|api|browser-tests)\b/.test(href)
						)
							continue;
						if (!routes.has(routePattern(href))) queue.push(href);
					}
			}
		} finally {
			await Promise.all(crawlers.map((page) => page.close()));
		}
	}
	console.log(
		`Checking ${routes.size} routes`,
		JSON.stringify([...routes.values()]),
	);

	await Promise.all(
		configs.map(async ({ viewport, theme }) => {
			const configStarted = performance.now();
			const label = `${viewport.width}-${theme}`;
			await Promise.all(
				Array.from({ length: PAGES_PER_CONFIG }, async (_, worker) => {
					const page = await browser!.newPage({ viewport, colorScheme: theme });
					try {
						await page.addInitScript(
							(value) => localStorage.setItem("tedix-os-theme", value),
							theme,
						);
						if (worker === 0) await auditWorkText(page, label);
						for (const [index, route] of [...routes.values()].entries()) {
							if (index % PAGES_PER_CONFIG !== worker) continue;
							await auditRoute(page, route, label);
						}
					} finally {
						await page.close();
					}
				}),
			);
			console.log(
				`Audited ${label}: ${Math.round(performance.now() - configStarted)} ms`,
			);
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
