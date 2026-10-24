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
 * `--shard i/n` splits viewport/theme configs and, above four shards, routes.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { chromium, type Browser, type Page } from "playwright";
import {
	findingKey,
	findingRoute,
	routePattern,
	type FocusClipHit,
} from "./focus-clip-findings";
import {
	controlSelector,
	describeControl,
	focusClipAudit,
} from "./focus-clip-page";
import { focusClipShard, focusClipRoutes } from "./focus-clip-shards";

type Finding = FocusClipHit & {
	// The stable route pattern plus the concrete URL it was seen at.
	route: string;
	url: string;
	viewport: string;
};

const shardFlag = process.argv.indexOf("--shard");
const { configs, partition, partitions } = focusClipShard(
	shardFlag < 0 ? "1/1" : (process.argv[shardFlag + 1] ?? ""),
);
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
	"/sites",
	"/install",
];
/*
 * Open defects in surfaces another lane owns, listed so this check guards
 * everything else meanwhile. Each entry names the rule that causes it; delete
 * the entry with the fix (the run fails while a listed defect is gone).
 */
const KNOWN_DEFECTS: { owner: string; control: RegExp; clipper: RegExp }[] = [];
// A cold dev server compiles each route chunk on first visit.
const NAVIGATION = { waitUntil: "domcontentloaded", timeout: 120_000 } as const;
const MAX_ROUTES = 90;

async function audit(page: Page) {
	// Focus styles are read synchronously, so they must not be mid-transition.
	await page.addStyleTag({
		content:
			"*, *::before, *::after { transition: none !important; animation: none !important; }",
	});
	// The helpers are serialized into the page, where each sees only the
	// others declared alongside it in this source.
	return page.evaluate<FocusClipHit[]>(`(() => {
${describeControl}
${controlSelector}
${focusClipAudit}
return focusClipAudit();
})()`);
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
		const record = (hits: FocusClipHit[], at: string) => {
			for (const hit of hits)
				findings.push({
					route: findingRoute(at, origin),
					url: at,
					viewport: label,
					...hit,
				});
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
		for (const route of narrowed)
			routes.set(routePattern(route, origin), route);
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
					const pattern = routePattern(next, origin);
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
						if (!routes.has(routePattern(href, origin))) queue.push(href);
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
						if (worker === 0 && partition === 0)
							await auditWorkText(page, label);
						const assigned = focusClipRoutes(routes, partition, partitions);
						for (const [index, route] of assigned.entries()) {
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
		const key = findingKey(finding);
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
			`${known(hit) < 0 ? "" : "known  "}${hit.kind.padEnd(6)} ${hit.route} :: ${hit.control} ‹${hit.selector}› — ${hit.sides} ${hit.overshoot}px by ${hit.clipper}${hit.clipperSelector ? ` ‹${hit.clipperSelector}›` : ""} [${hit.seen.join(" ")}]`,
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
