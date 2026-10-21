import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chromium,
	devices,
	webkit,
	type Browser,
	type BrowserContext,
	type BrowserType,
	type Locator,
	type Page,
} from "playwright";

// Standalone, local-only Templates browsing regression. Only contract reads
// are answered (with fictional inventory); every mutation and every request
// that leaves the local origin is blocked and reported.
const cwd = new URL("../", import.meta.url).pathname;
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	join(tmpdir(), "tedix-b11-templates-phone-browser");
await mkdir(evidence, { recursive: true });
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{
		cwd,
		stdout: Bun.file(`${evidence}/server.log`),
		stderr: Bun.file(`${evidence}/server-error.log`),
		detached: true,
	},
);
const failures: string[] = [];
const measurements: unknown[] = [];
const browsers: Browser[] = [];

const TEMPLATE_COUNT = 40;
const PAGE_SIZE = 15;
const LONG_NAME = `Long template ${"unbroken".repeat(18)}`;
const iso = "2026-10-01T09:00:00.000Z";

function template(index: number) {
	const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
	return {
		id,
		organizationId: "org_fictional",
		name:
			index === 0
				? LONG_NAME
				: `Quarterly review ${String(index + 1).padStart(2, "0")}`,
		description:
			index % 3 === 0 ? `Fictional starting point number ${index + 1}` : null,
		status: index % 4 === 0 ? "published" : "draft",
		currentRevisionId: null,
		lineage: null,
		createdByKind: "user",
		createdById: "user_fictional",
		createdAt: iso,
		updatedAt: iso,
		visibility: "org",
	};
}
const inventory = Array.from({ length: TEMPLATE_COUNT }, (_, i) => template(i));

async function visible(locator: Locator) {
	await locator.waitFor({ state: "visible", timeout: 15_000 });
}

async function inspect(
	page: Page,
	label: string,
	phone: boolean,
	targets: Locator[] = [],
) {
	await page.evaluate(() => document.fonts.ready);
	const geometry = await page.evaluate(() => ({
		width: innerWidth,
		height: innerHeight,
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: Math.max(
			document.documentElement.scrollWidth,
			document.body.scrollWidth,
		),
		theme: document.documentElement.dataset.theme,
		mode: document.documentElement.dataset.mode,
		dark: document.documentElement.classList.contains("dark"),
		coarse: matchMedia("(pointer: coarse)").matches,
		focus:
			document.activeElement instanceof HTMLElement
				? {
						tag: document.activeElement.tagName,
						label: document.activeElement.getAttribute("aria-label"),
						visible: document.activeElement.matches(":focus-visible"),
					}
				: null,
	}));
	const boxes = [];
	for (const target of targets) {
		await target.scrollIntoViewIfNeeded();
		const box = await target.boundingBox();
		const name =
			(await target.getAttribute("aria-label")) ??
			(await target.innerText()).slice(0, 40);
		boxes.push({ name, box });
		if (!box || (phone && (box.width < 43.5 || box.height < 43.5)))
			failures.push(
				`${label}: target ${name} is ${JSON.stringify(box)}; requires 44x44`,
			);
		if (box && (box.x < -1 || box.x + box.width > geometry.clientWidth + 1))
			failures.push(`${label}: target ${name} is horizontally clipped`);
	}
	if (geometry.scrollWidth > geometry.clientWidth + 1)
		failures.push(
			`${label}: page overflow ${geometry.scrollWidth} > ${geometry.clientWidth}`,
		);
	measurements.push({ label, geometry, targets: boxes });
	await page.screenshot({ path: `${evidence}/${label}.png`, fullPage: true });
	return geometry;
}

async function keyboardFocus(page: Page, target: Locator) {
	await target.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	assert(
		await target.evaluate((node) => node === document.activeElement),
		"Tab/Shift+Tab must return focus",
	);
	assert(
		await target.evaluate((node) => {
			const style = getComputedStyle(node);
			return (
				node.matches(":focus-visible") &&
				(style.boxShadow !== "none" ||
					(style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0))
			);
		}),
		"Keyboard focus must have a visible outline or ring",
	);
}

async function waitReady() {
	for (let attempt = 0; ; attempt++) {
		if (server.exitCode !== null)
			throw new Error(
				`Templates fixture server exited early (${server.exitCode}); see server-error.log`,
			);
		if (attempt === 120)
			throw new Error("Templates fixture server did not become ready");
		try {
			if (
				(await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }))
					.ok
			)
				return;
		} catch {}
		await Bun.sleep(250);
	}
}

async function run(engine: string, type: BrowserType) {
	const browser = await type.launch({ headless: true });
	browsers.push(browser);
	for (const device of [
		{ ...devices["iPhone 8"], viewport: { width: 375, height: 667 } },
		{ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
		{
			viewport: { width: 1280, height: 900 },
			isMobile: false,
			hasTouch: false,
		},
	]) {
		for (const theme of ["light", "dark"] as const) {
			const phone = device.isMobile === true;
			// Chromium cannot use WebKit's iPhone user agent; keep the viewport,
			// touch and theme parts and drop the engine-specific ones.
			const options =
				engine === "webkit"
					? device
					: {
							viewport: device.viewport,
							isMobile: device.isMobile,
							hasTouch: device.hasTouch,
							deviceScaleFactor: 2,
						};
			const label = `${engine}-${device.viewport.width}x${device.viewport.height}-${theme}`;
			const context: BrowserContext = await browser.newContext({
				...options,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			const consoleEntries: unknown[] = [];
			const forbidden: string[] = [];
			const external: string[] = [];
			let mode: "ready" | "pending" | "error" = "ready";
			let gate = Promise.resolve();
			let release = () => {};
			let listReads = 0;
			await context.route("**/*", async (route) => {
				const request = route.request();
				const url = new URL(request.url());
				if (url.origin !== origin) {
					external.push(request.url());
					await route.abort();
					return;
				}
				// The app issues reads as POST, so classify by verb, not HTTP method.
				// Shell background reads pass; any template or generic write is blocked.
				if (
					url.pathname.startsWith("/api/") &&
					(/\/blueprints\/(?!list$|get$|gallery$|preflight$)[^/]+$/.test(
						url.pathname,
					) ||
						/\/(create|import|instantiate|publish|export|revise|archive|delete|remove|update|send|share|apply|setVisibility)[A-Za-z]*$/.test(
							url.pathname,
						))
				) {
					forbidden.push(`${request.method()} ${url.pathname}`);
					await route.abort();
					return;
				}
				if (url.pathname === "/api/rpc/osWorkspaces/blueprints/list") {
					listReads++;
					if (mode === "pending") await gate;
					if (mode === "error") {
						await route.fulfill({
							status: 503,
							json: {
								json: {
									defined: false,
									code: "INTERNAL_SERVER_ERROR",
									message: "Fictional template read failed",
								},
							},
						});
						return;
					}
					await route.fulfill({
						json: { json: { items: inventory, truncated: true } },
					});
					return;
				}
				if (url.pathname === "/api/rpc/osWorkspaces/blueprints/get") {
					const input = JSON.parse(request.postData() ?? "{}") as {
						json?: { blueprintId?: string };
					};
					const blueprint = inventory.find(
						(item) => item.id === input.json?.blueprintId,
					);
					await route.fulfill(
						blueprint
							? { json: { json: { blueprint, currentRevision: null } } }
							: {
									status: 404,
									json: {
										json: {
											defined: false,
											code: "NOT_FOUND",
											message: "Fictional template not found",
										},
									},
								},
					);
					return;
				}
				await route.continue();
			});

			let page = await context.newPage();
			const observe = () => {
				page.setDefaultTimeout(15_000);
				page.on("console", (entry) =>
					consoleEntries.push({ type: entry.type(), text: entry.text() }),
				);
				page.on("pageerror", (error) => {
					consoleEntries.push({ type: "pageerror", text: error.message });
					failures.push(`${label}: pageerror ${error.message}`);
				});
			};
			observe();
			const search = () =>
				page.getByRole("searchbox", { name: "Search templates", exact: true });
			// The input sits inside a taller field; the field is the touch target.
			const searchField = () => search().locator("xpath=..");
			const rows = () => page.locator('[data-slot="blueprint-owned-list"] li');
			const text = (value: string) =>
				page.getByText(value, { exact: false }).first();

			async function scenario(name: string, body: () => Promise<void>) {
				try {
					if (name !== "browsing") {
						await page.close();
						page = await context.newPage();
						observe();
					}
					mode = "ready";
					await body();
					console.log(`PASS ${label} ${name}`);
				} catch (error) {
					const message = `${label} ${name}: ${String(error)}`;
					failures.push(message);
					console.error(message);
					await page
						.screenshot({
							path: `${evidence}/${label}-${name}-failure.png`,
							fullPage: true,
						})
						.catch(() => {});
				}
			}

			await scenario("browsing", async () => {
				await page.goto(`${origin}/blueprints`);
				await visible(search());
				await visible(rows().first());
				assert.equal(await rows().count(), PAGE_SIZE);
				await visible(text(`Showing ${PAGE_SIZE} of ${TEMPLATE_COUNT}`));
				await visible(text("more exist beyond this page"));
				const showMore = page.getByRole("button", { name: "Show more" });
				const actual = await inspect(page, `${label}-list`, phone, [
					searchField(),
					showMore,
					rows().first().getByRole("button"),
				]);
				assert.equal(actual.width, device.viewport.width);
				assert.equal(actual.height, device.viewport.height);
				assert.equal(actual.mode, theme);
				assert.equal(actual.dark, theme === "dark");
				assert.equal(actual.coarse, phone);
				await keyboardFocus(page, search());

				await search().fill("no-such-template-b11");
				await visible(text("No templates match"));
				assert.equal(await rows().count(), 0);
				await inspect(page, `${label}-no-match`, phone, [searchField()]);
				await search().fill("");
				await visible(rows().first());
				assert.equal(await rows().count(), PAGE_SIZE);

				await showMore.click();
				await page.waitForFunction(
					(count) =>
						document.querySelectorAll('[data-slot="blueprint-owned-list"] li')
							.length === count,
					PAGE_SIZE * 2,
				);
				await inspect(page, `${label}-show-more`, phone);

				await search().fill("Quarterly review 07");
				await visible(text("Showing 1 of 1 matching"));
				assert.equal(await rows().count(), 1);
				await rows().first().getByRole("button").click();
				const back = page.getByRole("button", { name: "All templates" });
				await visible(back);
				await visible(
					page.getByRole("heading", { name: "Quarterly review 07" }),
				);
				await inspect(page, `${label}-detail`, phone, [back]);
				await back.click();
				await visible(search());
				assert.equal(
					await search().inputValue(),
					"Quarterly review 07",
					"Search must be retained after returning to All templates",
				);
				assert.equal(await rows().count(), 1);
				await inspect(page, `${label}-returned`, phone, [searchField()]);

				await search().fill(LONG_NAME);
				await visible(rows().first());
				await inspect(page, `${label}-long-name`, phone, [
					rows().first().getByRole("button"),
				]);
			});

			await scenario("cold-delay", async () => {
				mode = "pending";
				gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				// The route loader holds the page on its pending view until the
				// list read settles, so the search box is not mounted yet.
				void page.goto(`${origin}/blueprints`);
				await page.waitForTimeout(1500);
				assert.equal(
					await page.getByText("No templates yet").count(),
					0,
					"A pending read must not claim there are no templates",
				);
				assert.equal(await rows().count(), 0);
				assert.equal(await search().count(), 0);
				await inspect(page, `${label}-pending`, phone);
				mode = "ready";
				release();
				await visible(search());
				await visible(rows().first());
			});

			await scenario("error-retry", async () => {
				mode = "error";
				await page.goto(`${origin}/blueprints`);
				await visible(text("Templates are unavailable"));
				assert.equal(
					await page.getByText("No templates yet").count(),
					0,
					"A failed read must not claim there are no templates",
				);
				const retry = page.getByRole("button", { name: "Try again" });
				await inspect(page, `${label}-error`, phone, [retry]);
				const before = listReads;
				mode = "ready";
				await retry.click();
				await visible(rows().first());
				assert(listReads > before, "Try again must re-read the list");
				assert.equal(
					await page.getByText("Templates are unavailable").count(),
					0,
				);
			});

			assert.deepEqual(
				forbidden,
				[],
				`${label}: browsing must not invoke mutations`,
			);
			measurements.push({
				label,
				blockedExternalRequests: [...new Set(external)],
			});
			await writeFile(
				`${evidence}/${label}-console.json`,
				JSON.stringify(consoleEntries, null, 2),
			);
			await context.close();
		}
	}
}

try {
	await waitReady();
	await run("webkit", webkit);
	await run("chromium", chromium);
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify({ origin, measurements, failures }, null, 2),
	);
	for (const browser of browsers) await browser.close();
	// This lane owns only this detached process group; never clear shared ports.
	if (server.exitCode === null) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			server.kill("SIGTERM");
		}
		await Promise.race([server.exited, Bun.sleep(3000)]);
		if (server.exitCode === null) {
			try {
				process.kill(-server.pid, "SIGKILL");
			} catch {
				server.kill("SIGKILL");
			}
		}
	}
}
assert.deepEqual(
	failures,
	[],
	`Templates browser regressions; evidence: ${evidence}`,
);
