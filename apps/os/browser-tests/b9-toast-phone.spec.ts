import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { webkit, type Browser, type Page } from "playwright";

// Real-adapter harness for the shared OS toast outlet: WebKit at two phone
// sizes and a desktop size, light and dark, against the app's real CSS.
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = String(probe.port!);
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const fixture = `${origin}/browser-tests/b9-toast-phone.html`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		port,
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{
		cwd: new URL("../", import.meta.url).pathname,
		stdout: "inherit",
		stderr: "inherit",
		detached: true,
	},
);

const toastSelector = "[data-os-toast-outlet] [role=dialog]";

async function settle(page: Page) {
	await page.waitForFunction(() =>
		document.getAnimations().every((a) => a.playState !== "running"),
	);
}

async function raise(page: Page, name: string, expected: number) {
	await page.getByRole("button", { name, exact: true }).click();
	await page.waitForFunction(
		([selector, count]) =>
			document.querySelectorAll(selector as string).length === count,
		[toastSelector, expected] as const,
	);
	await settle(page);
}

async function measure(page: Page) {
	return page.evaluate((selector) => {
		const roots = document.querySelectorAll<HTMLElement>(selector);
		const root = roots[roots.length - 1]!;
		const close = root.querySelector<HTMLElement>("[data-kumo-part=close]")!;
		const title = root.querySelector<HTMLElement>("[data-toast-title]")!;
		const column = title.parentElement!;
		const description = column.querySelector<HTMLElement>("p");
		const box = (el: Element) => {
			const r = el.getBoundingClientRect();
			return {
				x: Math.round(r.x * 10) / 10,
				y: Math.round(r.y * 10) / 10,
				width: Math.round(r.width * 10) / 10,
				height: Math.round(r.height * 10) / 10,
			};
		};
		const c = close.getBoundingClientRect();
		// Real hit testing: edge midpoints, rounded corners (inset past their
		// radius) and the centre of the measured rectangle must all land on the
		// close control itself, not on text or the toast surface.
		const midX = c.left + c.width / 2;
		const midY = c.top + c.height / 2;
		const corners = [
			[midX, c.top + 1],
			[midX, c.bottom - 1],
			[c.left + 1, midY],
			[c.right - 1, midY],
			[c.left + 4, c.top + 4],
			[c.right - 4, c.top + 4],
			[c.left + 4, c.bottom - 4],
			[c.right - 4, c.bottom - 4],
			[midX, midY],
		].map(
			([x, y]) =>
				document.elementFromPoint(x!, y!)?.closest("[data-kumo-part=close]") ===
				close,
		);
		return {
			viewport: { width: innerWidth, height: innerHeight },
			root: box(root),
			close: box(close),
			icon: box(close.querySelector("svg")!),
			title: box(title),
			titleLines: Math.round(
				title.getBoundingClientRect().height /
					parseFloat(getComputedStyle(title).lineHeight),
			),
			description: description ? box(description) : null,
			column: box(column),
			columnOverflow: column.scrollWidth - column.clientWidth,
			hitCorners: corners,
			titleColor: getComputedStyle(title).color,
			surface: getComputedStyle(root).backgroundColor,
		};
	}, toastSelector);
}

type Measurement = Awaited<ReturnType<typeof measure>>;

function assertLayout(m: Measurement, phone: boolean, label: string) {
	const detail = `${label} ${JSON.stringify(m)}`;
	const minimum = phone ? 44 : 20;
	assert(
		m.close.width >= minimum && m.close.height >= minimum,
		`close hit area >= ${minimum}px: ${detail}`,
	);
	assert(m.icon.width <= 16, `close glyph stays small: ${detail}`);
	assert(m.hitCorners.every(Boolean), `close owns its hit area: ${detail}`);
	const inside = (
		inner: { x: number; y: number; width: number; height: number },
		outer: { x: number; y: number; width: number; height: number },
	) =>
		inner.x >= outer.x - 0.5 &&
		inner.y >= outer.y - 0.5 &&
		inner.x + inner.width <= outer.x + outer.width + 0.5 &&
		inner.y + inner.height <= outer.y + outer.height + 0.5;
	assert(
		inside(m.root, { x: 0, y: 0, ...m.viewport }),
		`toast stays in viewport: ${detail}`,
	);
	assert(inside(m.close, m.root), `close stays inside toast: ${detail}`);
	assert(inside(m.title, m.root), `title stays inside toast: ${detail}`);
	if (m.description)
		assert(
			inside(m.description, m.root),
			`description stays inside toast: ${detail}`,
		);
	assert(m.columnOverflow <= 0, `text wraps without overflow: ${detail}`);
	if (phone)
		for (const text of [m.title, m.description])
			if (text)
				assert(
					text.x + text.width <= m.close.x + 0.5,
					`text clears the close hit area: ${detail}`,
				);
}

async function focusClose(page: Page) {
	// Base UI's documented landmark hotkey moves focus to the toast region;
	// Tab then reaches the frontmost toast and its close control.
	await page.keyboard.press("F6");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	const focused = await page.evaluate(() => {
		const el = document.activeElement;
		return {
			isClose: el?.matches("[data-kumo-part=close]") ?? false,
			name: el?.getAttribute("aria-label"),
			focusVisible: el?.matches(":focus-visible") ?? false,
		};
	});
	assert(focused.isClose, `keyboard reaches close ${JSON.stringify(focused)}`);
	assert.equal(focused.name, "Close");
	assert(focused.focusVisible, "keyboard focus on close is visible");
}

async function expectCount(page: Page, count: number) {
	await page.waitForFunction(
		([selector, n]) =>
			document.querySelectorAll(selector as string).length === n,
		[toastSelector, count] as const,
		{ timeout: 3000 },
	);
}

let browser: Browser | undefined;
const report: Record<string, unknown>[] = [];
try {
	await waitForFixtureServer(fixture, { server });
	browser = await webkit.launch({ headless: true });
	const titleColors = new Map<string, string>();
	let lifetimeChecked = false;
	for (const theme of ["light", "dark"] as const) {
		for (const size of [
			{ width: 375, height: 667, phone: true },
			{ width: 390, height: 844, phone: true },
			{ width: 1280, height: 800, phone: false },
		]) {
			const label = `${size.width}x${size.height} ${theme}`;
			const context = await browser.newContext({
				viewport: { width: size.width, height: size.height },
				isMobile: size.phone,
				hasTouch: size.phone,
				colorScheme: theme,
			});
			const page = await context.newPage();
			await page.goto(`${fixture}?theme=${theme}`);

			// Error: long title + long description with an unbroken URL.
			await raise(page, "Raise error", 1);
			const error = await measure(page);
			assertLayout(error, size.phone, `${label} error`);
			assert(error.titleLines >= 2, `${label} long title wraps`);
			titleColors.set(`${label}`, error.titleColor);
			await focusClose(page);
			await page.keyboard.press("Enter");
			await expectCount(page, 0);

			// Success: Escape on the focused toast dismisses it.
			await raise(page, "Raise success", 1);
			const success = await measure(page);
			assertLayout(success, size.phone, `${label} success`);
			await page.keyboard.press("F6");
			await page.keyboard.press("Tab");
			await page.keyboard.press("Escape");
			await expectCount(page, 0);

			// Loading: same id twice stays one toast; close via keyboard.
			await raise(page, "Raise loading", 1);
			await page.getByRole("button", { name: "Raise loading" }).click();
			await settle(page);
			await expectCount(page, 1);
			const loading = await measure(page);
			assertLayout(loading, size.phone, `${label} loading`);
			if (!lifetimeChecked) {
				// Kumo's default timeout is 5 s; success must expire, loading not.
				await raise(page, "Raise success", 2);
				await page.waitForTimeout(6500);
				await expectCount(page, 1);
				assert(
					(await page.locator(toastSelector).innerText()).includes(
						"Creating workspace",
					),
					"loading toast persists past the default timeout",
				);
				lifetimeChecked = true;
			}
			await focusClose(page);
			await page.keyboard.press("Enter");
			await expectCount(page, 0);

			// Programmatic dismissal by notification id still works.
			await raise(page, "Raise loading", 1);
			await page.getByRole("button", { name: "Finish loading" }).click();
			await expectCount(page, 0);

			const announcer = await page
				.locator("[data-os-toast-outlet] [role=region]")
				.evaluate((el) => ({
					live: el.getAttribute("aria-live"),
					label: el.getAttribute("aria-label"),
				}));
			assert.deepEqual(announcer, { live: "polite", label: "Notifications" });

			report.push({
				label,
				error: {
					close: error.close,
					icon: error.icon,
					root: error.root,
					titleLines: error.titleLines,
					column: error.column,
				},
				success: { close: success.close, root: success.root },
				loading: { close: loading.close, root: loading.root },
			});
			await context.close();
		}
	}
	for (const size of ["375x667", "390x844", "1280x800"])
		assert.notEqual(
			titleColors.get(`${size} light`),
			titleColors.get(`${size} dark`),
			`${size} dark theme restyles the toast`,
		);
	for (const row of report) console.log(JSON.stringify(row));
	console.log("b9 toast phone: ok");
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
}
