/**
 * Real-browser smoke check for the landing navbar: disclosure mobile menu,
 * language pickers and theme persistence, in light and dark, at desktop and
 * mobile widths. Targets a deployed or locally served base URL.
 *
 *   bun browser-tests/nav-accessibility.spec.ts [base-url]
 *
 * Env:
 *   LANDING_BASE / CHECK_BASE   base URL (default https://tedix.dev)
 *   CHECK_SHOTS_DIR             optional directory for painted screenshots
 *
 * Sandboxed lanes may deny Chromium its Mach-port rendezvous (macOS
 * mach-register) and give the browser no DNS while the Bun process has
 * network. Launch falls back to --single-process over a DevTools WebSocket and
 * page requests fall back to fetch()-proxied route fulfilment, so the check
 * still exercises the real deployed bytes.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
} from "playwright";

const BASE = (
	process.env.LANDING_BASE ??
	process.env.CHECK_BASE ??
	process.argv[2] ??
	"https://tedix.dev"
).replace(/\/$/, "");
const SHOTS = process.env.CHECK_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const results: { name: string; pass: boolean; extra: string }[] = [];
const check = (name: string, pass: boolean, extra = "") => {
	results.push({ name, pass, extra });
	console.log(
		`${pass ? "PASS" : "FAIL"} ${name}${extra ? ` :: ${extra}` : ""}`,
	);
};

// --- launch: normal multi-process first, single-process + ws fallback ----
async function waitForWs(proc: ChildProcess, ms: number) {
	let ws = "";
	proc.stderr?.on("data", (d: Buffer) => {
		const s = d.toString();
		const m = s.match(/DevTools listening on (ws:\/\/\S+)/);
		if (m) ws = m[1];
		else if (s.includes("FATAL") || s.includes("ERROR"))
			console.log("[nav-check] chrome:", s.trim().slice(0, 180));
	});
	const until = Date.now() + ms;
	while (!ws && Date.now() < until)
		await new Promise((r) => setTimeout(r, 400));
	return ws;
}

// Newest installed Chromium executable: the pinned revision playwright wants,
// else the highest chromium_headless_shell-/chromium- build in the browser
// cache (lanes may carry a different revision than the package expects).
function resolveExecutable(): string {
	const wanted = chromium.executablePath();
	// --single-process only works reliably through the headless-shell build;
	// the full "Chrome for Testing" app never opens its DevTools endpoint.
	if (wanted.includes("headless") && existsSync(wanted)) return wanted;
	const roots = [
		process.env.PLAYWRIGHT_BROWSERS_PATH,
		join(homedir(), "Library/Caches/ms-playwright"),
		join(homedir(), ".cache/ms-playwright"),
	].filter((p): p is string => !!p && existsSync(p));
	// Headless shell is preferred: under --single-process it is the binary that
	// reliably brings up the DevTools endpoint.
	const candidates: { rev: number; shell: number; path: string }[] = [];
	for (const root of roots)
		for (const dir of readdirSync(root)) {
			const m = dir.match(/^chromium(?:_headless_shell)?-(\d+)$/);
			if (!m) continue;
			for (const [shell, rel] of [
				[1, "chrome-headless-shell-mac-arm64/chrome-headless-shell"],
				[1, "chrome-headless-shell-mac/chrome-headless-shell"],
				[1, "chrome-linux/headless_shell"],
				[
					0,
					"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
				],
				[
					0,
					"chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
				],
				[0, "chrome-linux/chrome"],
			] as const) {
				const p = join(root, dir, rel);
				if (existsSync(p))
					candidates.push({ rev: Number(m[1]), shell, path: p });
			}
		}
	candidates.sort((a, b) => b.rev - a.rev || b.shell - a.shell);
	if (candidates[0]) return candidates[0].path;
	return wanted;
}

async function launchBrowser(): Promise<{
	browser: Browser;
	proc?: ChildProcess;
}> {
	try {
		return {
			browser: await chromium.launch({ headless: true, timeout: 30000 }),
		};
	} catch {
		console.log(
			"[nav-check] normal launch failed; retrying --single-process + DevTools ws",
		);
	}
	const exe = process.env.CHECK_CHROMIUM ?? resolveExecutable();
	console.log(`[nav-check] executable ${exe}`);
	for (let attempt = 1; attempt <= 6; attempt++) {
		const port = 19000 + Math.floor(Math.random() * 3000);
		const proc = spawn(
			exe,
			[
				"--headless",
				"--no-sandbox",
				"--single-process",
				"--disable-gpu",
				"--no-zygote",
				`--remote-debugging-port=${port}`,
				`--user-data-dir=/tmp/claude/nav-check-${port}-${Date.now()}`,
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const ws = await waitForWs(proc, 20000);
		if (ws) {
			return { browser: await chromium.connectOverCDP(ws), proc };
		}
		proc.kill("SIGKILL");
		console.log(`[nav-check] spawn attempt ${attempt}: no devtools endpoint`);
	}
	throw new Error("chromium launch failed in both modes");
}

// --- request proxy: fulfill through Bun fetch when the browser has no DNS ---
const HOP = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);
async function wireFetchProxy(page: Page) {
	await page.route("**/*", async (route) => {
		const url = route.request().url();
		if (!url.startsWith(BASE)) return route.abort();
		try {
			const res = await fetch(url, { headers: route.request().headers() });
			const headers: Record<string, string> = {};
			res.headers.forEach((v, k) => {
				if (!HOP.has(k.toLowerCase())) headers[k] = v;
			});
			await route.fulfill({
				status: res.status,
				headers,
				body: Buffer.from(await res.arrayBuffer()),
			});
		} catch {
			await route.abort();
		}
	});
}

const proxiedPages = new WeakSet<Page>();
let proxyNeeded = false;
async function goto(page: Page, path: string) {
	if (proxyNeeded && !proxiedPages.has(page)) {
		await wireFetchProxy(page);
		proxiedPages.add(page);
	}
	try {
		await page.goto(BASE + path, {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});
	} catch (err) {
		if (proxyNeeded) throw err;
		console.log(
			"[nav-check] direct navigation failed; proxying requests through fetch()",
		);
		proxyNeeded = true;
		await wireFetchProxy(page);
		proxiedPages.add(page);
		await page.goto(BASE + path, {
			waitUntil: "domcontentloaded",
			timeout: 30000,
		});
	}
}

// --- page state helpers --------------------------------------------------
const htmlState = (page: Page) =>
	page.evaluate(() => ({
		dark: document.documentElement.classList.contains("dark"),
		mode: document.documentElement.dataset.mode,
		stored: localStorage.getItem("theme"),
		overflow: document.body.style.overflow,
		bg: getComputedStyle(document.body).backgroundColor,
	}));
const menuState = (page: Page) =>
	page.evaluate(() => {
		const btn = document.querySelector("[data-menu-btn]");
		const menu = document.querySelector<HTMLElement>("[data-mobile-menu]");
		return {
			expanded: btn?.getAttribute("aria-expanded"),
			open: menu?.dataset.open,
			inert: menu?.hasAttribute("inert"),
			focusIsBtn: document.activeElement === btn,
		};
	});
const focusEl = (page: Page, selector: string) =>
	page.evaluate((s) => {
		const el = document.querySelector<HTMLElement>(s);
		el?.focus();
		return document.activeElement === el;
	}, selector);
const shot = async (page: Page, name: string) => {
	if (!SHOTS) return;
	await page
		.screenshot({ path: join(SHOTS, name), timeout: 20000 })
		.catch(() => console.log(`shot ${name} failed`));
};

// --- run -----------------------------------------------------------------
const { browser, proc } = await launchBrowser();
process.on("exit", () => proc?.kill("SIGKILL"));
// --single-process exposes only the default browser context.
const ctx: BrowserContext =
	browser.contexts()[0] ?? (await browser.newContext());
console.log(`[nav-check] chromium ${browser.version()} on ${BASE}`);

try {
	// ---------------- desktop 1440x900, light and dark -------------------
	{
		const page = await ctx.newPage();
		await page.setViewportSize({ width: 1440, height: 900 });
		await goto(page, "/");
		await page.waitForSelector("[data-menu-btn]", { state: "attached" });
		await page.waitForTimeout(800);

		check(
			"desktop: page loads",
			(await page.title()).length > 0,
			await page.title(),
		);
		check(
			"desktop: hamburger hidden at lg",
			!(await page.locator("[data-menu-btn]").isVisible()),
		);
		check(
			"desktop: nav links visible",
			await page
				.locator("nav[data-navbar] div.hidden.lg\\:flex a")
				.first()
				.isVisible(),
		);
		const st0 = await htmlState(page);
		check(
			"desktop: initial theme applied",
			["light", "dark"].includes(st0.mode ?? ""),
			st0.mode,
		);

		// Language picker: keyboard open + Escape close + focus restore
		await focusEl(
			page,
			"nav[data-navbar] details[data-language-menu] > summary",
		);
		await page.keyboard.press("Enter");
		check(
			"desktop: language disclosure opens via keyboard",
			await page
				.locator("nav[data-navbar] details[data-language-menu]")
				.evaluate((d: HTMLDetailsElement) => d.open),
		);
		const deLink = page
			.locator('nav[data-navbar] details[data-language-menu] a[href*="/de"]')
			.first();
		check(
			"desktop: language links reachable",
			await deLink.isVisible(),
			(await deLink.getAttribute("href")) ?? "",
		);
		await page.evaluate(() => {
			const links = document.querySelectorAll<HTMLElement>(
				"nav[data-navbar] details[data-language-menu] a",
			);
			links[links.length - 1]?.focus();
		});
		await page.keyboard.press("Escape");
		await page.waitForTimeout(150);
		check(
			"desktop: Escape closes language disclosure",
			!(await page
				.locator("nav[data-navbar] details[data-language-menu]")
				.evaluate((d: HTMLDetailsElement) => d.open)),
		);
		check(
			"desktop: focus returns to language summary",
			await page.evaluate(
				() =>
					document.activeElement ===
					document.querySelector(
						"nav[data-navbar] details[data-language-menu] > summary",
					),
			),
		);

		// Theme toggle: light -> dark -> light, painted repaint
		const before = await htmlState(page);
		await page.locator("nav[data-navbar] [data-theme-toggle]").click();
		await page.waitForTimeout(250);
		const after = await htmlState(page);
		check(
			"desktop: theme toggle flips dark class",
			after.dark !== before.dark,
			`${before.mode} -> ${after.mode}`,
		);
		check(
			"desktop: theme stored in localStorage",
			after.stored === after.mode,
			after.stored ?? "",
		);
		check(
			"desktop: toggle aria-pressed syncs",
			(await page
				.locator("nav[data-navbar] [data-theme-toggle]")
				.getAttribute("aria-pressed")) === String(after.dark),
		);
		check(
			"desktop: painted background changes",
			after.bg !== before.bg,
			`${before.bg} -> ${after.bg}`,
		);
		await shot(page, "desktop-dark.png");
		await page.locator("nav[data-navbar] [data-theme-toggle]").click();
		await page.waitForTimeout(250);
		const back = await htmlState(page);
		check("desktop: theme toggles back", back.dark === before.dark);
		await shot(page, "desktop-light.png");

		// Persistence across routes
		if (!back.dark) {
			await page.locator("nav[data-navbar] [data-theme-toggle]").click();
			await page.waitForTimeout(250);
		}
		await goto(page, "/de/");
		await page.waitForSelector("[data-menu-btn]", { state: "attached" });
		const deState = await htmlState(page);
		check(
			"desktop: dark persists across routes",
			deState.dark === true && deState.stored === "dark",
			`mode=${deState.mode} stored=${deState.stored}`,
		);
		check(
			"desktop: theme-aware nav rendered on /de/",
			await page.locator("[data-navbar]").isVisible(),
		);
		await page.close();
	}

	// ---------------- mobile 390x844 touch, light and dark ---------------
	{
		const page = await ctx.newPage();
		await goto(page, "/");
		await page.evaluate(() => localStorage.clear());
		const session = await ctx.newCDPSession(page);
		await session.send("Emulation.setDeviceMetricsOverride", {
			width: 390,
			height: 844,
			deviceScaleFactor: 3,
			mobile: true,
		});
		await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForSelector("[data-menu-btn]", { state: "attached" });
		await page.waitForTimeout(800);

		const tap = async (selector: string) => {
			const box = await page.locator(selector).boundingBox();
			assert(box, `${selector} has no box`);
			const x = box.x + box.width / 2;
			const y = box.y + box.height / 2;
			await session.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x, y }],
			});
			await session.send("Input.dispatchTouchEvent", {
				type: "touchEnd",
				touchPoints: [],
			});
		};

		check(
			"mobile: hamburger visible",
			await page.locator("[data-menu-btn]").isVisible(),
		);
		const ms0 = await menuState(page);
		check(
			"mobile: menu starts closed+inert",
			ms0.open === "false" && ms0.inert === true && ms0.expanded === "false",
		);
		check(
			"mobile: desktop-only controls hidden",
			!(await page.locator("nav[data-navbar] [data-theme-toggle]").isVisible()),
		);

		await tap("[data-menu-btn]");
		await page.waitForTimeout(300);
		const ms1 = await menuState(page);
		check(
			"mobile: tap opens menu",
			ms1.open === "true" && !ms1.inert && ms1.expanded === "true",
		);
		check(
			"mobile: controls not hidden while open",
			(await page.locator("[data-menu-btn]").isVisible()) &&
				(await page.locator('nav[data-navbar] a[href*="github"]').isVisible()),
		);

		const scrollBefore = await page.evaluate(() => window.scrollY);
		await session.send("Input.synthesizeScrollGesture", {
			x: 195,
			y: 600,
			yDistance: -400,
		});
		await page.waitForTimeout(200);
		const scrollAfter = await page.evaluate(() => window.scrollY);
		check(
			"mobile: page still scrolls with menu open",
			scrollAfter !== scrollBefore,
			`scrollY ${scrollBefore} -> ${scrollAfter}`,
		);
		await shot(page, "mobile-light-menu.png");

		// Escape closes + focus returns to the trigger
		await focusEl(page, "[data-mobile-menu] a[href]");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(250);
		const ms2 = await menuState(page);
		check(
			"mobile: Escape closes menu",
			ms2.open === "false" && ms2.inert === true && ms2.expanded === "false",
		);
		check("mobile: focus returns to hamburger", ms2.focusIsBtn);

		// Keyboard reopen, then outside pointerdown dismisses
		await page.keyboard.press("Enter");
		await page.waitForTimeout(250);
		check(
			"mobile: Enter reopens menu",
			(await menuState(page)).open === "true",
		);
		await page.mouse.click(10, 830);
		await page.waitForTimeout(250);
		check(
			"mobile: outside press closes menu",
			(await menuState(page)).open === "false",
		);

		// Layered Escape: inner language disclosure first, then the menu
		await tap("[data-menu-btn]");
		await page.waitForTimeout(250);
		const mobLang = page.locator(
			"[data-mobile-menu] details[data-language-menu]",
		);
		await focusEl(
			page,
			"[data-mobile-menu] details[data-language-menu] > summary",
		);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(150);
		check(
			"mobile: language disclosure opens in menu",
			await mobLang.evaluate((d: HTMLDetailsElement) => d.open),
		);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(150);
		check(
			"mobile: Escape closes inner disclosure first",
			!(await mobLang.evaluate((d: HTMLDetailsElement) => d.open)) &&
				(await menuState(page)).open === "true",
		);
		check(
			"mobile: focus returns to inner summary",
			await page.evaluate(
				() =>
					document.activeElement ===
					document.querySelector(
						"[data-mobile-menu] details[data-language-menu] > summary",
					),
			),
		);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(250);
		check(
			"mobile: second Escape closes menu",
			(await menuState(page)).open === "false",
		);

		// In-menu theme toggle paints dark
		const mBefore = await htmlState(page);
		await tap("[data-menu-btn]");
		await page.waitForTimeout(250);
		await page.locator("[data-mobile-menu] [data-theme-toggle]").click();
		await page.waitForTimeout(250);
		const mAfter = await htmlState(page);
		check(
			"mobile: in-menu theme toggle works",
			mAfter.dark !== mBefore.dark && mAfter.stored === mAfter.mode,
			`${mBefore.mode} -> ${mAfter.mode}`,
		);
		check(
			"mobile: painted background changes",
			mAfter.bg !== mBefore.bg,
			`${mBefore.bg} -> ${mAfter.bg}`,
		);
		await shot(page, "mobile-dark-menu.png");

		// Link activation closes the menu and restores scroll
		await page
			.locator('[data-mobile-menu] a[href^="/apps"]')
			.first()
			.click()
			.catch(() => page.locator("[data-mobile-menu] a[href]").first().click());
		await page.waitForTimeout(1200);
		check(
			"mobile: link press closes menu",
			(await menuState(page)).open === "false",
			`url=${page.url()}`,
		);
		check(
			"mobile: body overflow restored",
			(await htmlState(page)).overflow === "",
		);

		// Menu re-initializes after navigation; breakpoint dismisses
		await tap("[data-menu-btn]");
		await page.waitForTimeout(250);
		check(
			"mobile: menu re-opens after navigation",
			(await menuState(page)).open === "true",
		);
		await page.setViewportSize({ width: 1280, height: 900 });
		await session.send("Emulation.setDeviceMetricsOverride", {
			width: 1280,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await page.waitForTimeout(350);
		const ms5 = await menuState(page);
		check(
			"mobile->desktop: menu auto-closes at lg",
			ms5.open === "false" && ms5.inert === true,
		);
		check(
			"mobile->desktop: overflow still clean",
			(await htmlState(page)).overflow === "",
		);
		const mFinal = await htmlState(page);
		check(
			"mobile: dark persisted across nav+resize",
			mFinal.dark === true && mFinal.stored === "dark",
		);
		await page.close();
	}
} finally {
	await browser.close();
	proc?.kill("SIGKILL");
}

const failed = results.filter((r) => !r.pass);
console.log(
	`\n${results.length - failed.length}/${results.length} checks passed`,
);
if (failed.length) {
	console.log("FAILED:", failed.map((f) => f.name).join(" | "));
	process.exit(1);
}
