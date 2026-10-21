import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	devices,
	webkit,
	type Browser,
	type Locator,
	type Page,
} from "playwright";
import type { OsOutputLibraryItem } from "@tedix/api-contract/schemas/os-workspaces";

// Standalone, local-only Documents regression. No shared fixture mutations.
const cwd = new URL("../", import.meta.url).pathname;
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	join(tmpdir(), "tedix-b8-outputs-iphone-readonly");
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
let browser: Browser | undefined;

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
		visualWidth: visualViewport?.width,
		visualHeight: visualViewport?.height,
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
						label: document.activeElement.getAttribute("aria-label"),
						visible: document.activeElement.matches(":focus-visible"),
						shadow: getComputedStyle(document.activeElement).boxShadow,
						outline: getComputedStyle(document.activeElement).outline,
					}
				: null,
	}));
	const boxes = [];
	for (const target of targets) {
		await target.scrollIntoViewIfNeeded();
		const box = await target.boundingBox();
		const name =
			(await target.getAttribute("aria-label")) ?? (await target.innerText());
		boxes.push({ name, box });
		if (!box || (phone && (box.width < 43.5 || box.height < 43.5)))
			failures.push(
				`${label}: target ${name} is ${JSON.stringify(box)}; requires 44x44`,
			);
		if (box && (box.x < -1 || box.x + box.width > geometry.clientWidth + 1))
			failures.push(`${label}: target ${name} is horizontally clipped`);
		if (
			!(await target.evaluate((node) => {
				const box = node.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.x + box.width / 2,
					box.y + box.height / 2,
				);
				return hit !== null && node.contains(hit);
			}))
		)
			failures.push(`${label}: target ${name} is covered at its center`);
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

try {
	for (let attempt = 0; ; attempt++) {
		if (server.exitCode !== null)
			throw new Error(
				`Documents fixture server exited early (${server.exitCode}); see server-error.log`,
			);
		if (attempt === 120)
			throw new Error("Documents fixture server did not become ready");
		try {
			if (
				(await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) }))
					.ok
			)
				break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await webkit.launch({ headless: true });
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
			const label = `${device.viewport.width}x${device.viewport.height}-${theme}`;
			const context = await browser.newContext({
				...device,
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			let page = await context.newPage();
			const consoleEntries: unknown[] = [];
			const forbidden: string[] = [];
			function observePage() {
				page.setDefaultTimeout(15_000);
				page.on("console", (entry) =>
					consoleEntries.push({ type: entry.type(), text: entry.text() }),
				);
				page.on("pageerror", (error) => {
					consoleEntries.push({ type: "pageerror", text: error.message });
					failures.push(`${label}: pageerror ${error.message}`);
				});
			}
			observePage();
			const response = await context.request.get(
				`${origin}/api/rpc/osWorkspaces/outputs/library?data=${encodeURIComponent(JSON.stringify({ json: { status: "active", limit: 200 } }))}`,
			);
			assert(response.ok(), "Actual fixture library must be readable");
			const original = (await response.json()).json as {
				items: OsOutputLibraryItem[];
				truncated: boolean;
			};
			const readable = original.items.find(
				(item) =>
					item.output.kind === "document" && item.preview.kind === "document",
			);
			assert(readable, "Fixture must contain an existing readable document");
			const revoked: OsOutputLibraryItem = {
				...readable,
				output: {
					...readable.output,
					id: crypto.randomUUID(),
					title: "Revoked source regression",
				},
				preview: { kind: "unavailable", reason: "source_access_unavailable" },
			};
			const long: OsOutputLibraryItem = {
				...readable,
				output: {
					...readable.output,
					id: crypto.randomUUID(),
					title: `Long title ${"unbroken".repeat(24)}`,
				},
			};
			const formats: OsOutputLibraryItem[] = [
				{
					...readable,
					output: {
						...readable.output,
						id: crypto.randomUUID(),
						kind: "sheet",
						title: "Regression sheet",
					},
					preview: {
						kind: "sheet",
						columns: ["Value"],
						rows: [[1]],
						rowCount: 1,
						columnCount: 1,
						sheetCount: 1,
					},
				},
				{
					...readable,
					output: {
						...readable.output,
						id: crypto.randomUUID(),
						kind: "presentation",
						title: "Regression slides",
					},
					preview: {
						kind: "presentation",
						title: "Regression slides",
						bullets: ["Read only"],
						slideCount: 1,
					},
				},
				{
					...readable,
					output: {
						...readable.output,
						id: crypto.randomUUID(),
						kind: "video",
						title: "Regression video",
					},
					preview: { kind: "video", mimeType: "video/mp4" },
				},
			];
			let library = {
				items: [readable, revoked, long, ...formats],
				truncated: false,
			};
			let mode: "ready" | "pending" | "error" = "ready";
			let release = () => {};
			let gate = Promise.resolve();
			let reads = 0;
			await context.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== origin) {
					await route.abort();
					return;
				}
				if (
					/\/api\/rpc\/.+\/(create|rename|archive|revise|save|export|send|share|setSheetRange|commit|publish)$/.test(
						url.pathname,
					)
				) {
					forbidden.push(url.pathname);
					await route.abort();
					return;
				}
				if (url.pathname === "/api/rpc/osWorkspaces/outputs/library") {
					reads++;
					if (mode === "pending") await gate;
					if (mode === "error") {
						await route.fulfill({
							status: 503,
							json: {
								json: {
									defined: false,
									code: "INTERNAL_SERVER_ERROR",
									message: "Regression library read failed",
								},
							},
						});
					} else await route.fulfill({ json: { json: library } });
					return;
				}
				await route.continue();
			});
			async function scenario(name: string, run: () => Promise<void>) {
				try {
					// A fresh document isolates loader/cache state and in-flight
					// workspace navigation from the next library-read scenario.
					if (name !== "browsing") {
						await page.close();
						page = await context.newPage();
						observePage();
						search = page.getByRole("searchbox", { name: "Search outputs" });
					}
					await run();
					console.log(`PASS ${label} ${name}`);
				} catch (error) {
					const message = `${label} ${name}: ${String(error)}`;
					failures.push(message);
					console.error(message);
					await page.screenshot({
						path: `${evidence}/${label}-${name}-failure.png`,
						fullPage: true,
					});
				}
			}
			let search = page.getByRole("searchbox", { name: "Search outputs" });
			const cards = () =>
				page.locator('li[role="button"][aria-label^="Open "]');
			const ready = async () => {
				await visible(search);
				await visible(cards().first());
			};
			await scenario("browsing", async () => {
				await page.goto(`${origin}/outputs`);
				await ready();
				assert(
					(await page.locator('[data-slot="output-grid-preview"]').count()) > 0,
				);
				if (phone) {
					const right = page.getByRole("button", {
						name: "Scroll Filter by type right",
						exact: true,
					});
					await visible(right);
					await inspect(page, `${label}-scroll-right`, phone, [right]);
					await right.click();
					const left = page.getByRole("button", {
						name: "Scroll Filter by type left",
						exact: true,
					});
					await visible(left);
					await inspect(page, `${label}-scroll-left`, phone, [left]);
					await left.click();
				}
				const tabs = page
					.getByRole("tablist", { name: "Filter by type" })
					.getByRole("tab");
				const targets = [
					search,
					page.getByRole("button", { name: "List view" }),
					page.getByRole("button", { name: "Grid view" }),
					page.getByRole("button", {
						name: phone ? "All sharing" : "Yours and shared",
						exact: true,
					}),
					...(await tabs.all()),
					cards().first(),
					page.getByRole("button", {
						name: `Actions for ${readable.output.title}`,
						exact: true,
					}),
				];
				const actual = await inspect(page, `${label}-grid`, phone, targets);
				assert.equal(actual.width, device.viewport.width);
				assert.equal(actual.height, device.viewport.height);
				assert.equal(actual.theme, "tedix");
				assert.equal(actual.mode, theme);
				assert.equal(actual.dark, theme === "dark");
				assert.equal(actual.coarse, phone);
				await keyboardFocus(page, search);
				await inspect(page, `${label}-search-focus`, phone);
				await search.fill("no-such-output-b8");
				await visible(page.getByText("No matching outputs", { exact: true }));
				assert.equal(await cards().count(), 0);
				await inspect(page, `${label}-no-matches`, phone, [search]);
				await search.fill("");
				await visible(cards().first());
				for (const [name, title] of [
					["Sheets", "Regression sheet"],
					["Slides", "Regression slides"],
					["Videos", "Regression video"],
					["Documents", readable.output.title],
				]) {
					await tabs.filter({ hasText: name }).click();
					await visible(cards().filter({ hasText: title }).first());
					assert.equal(
						await tabs.filter({ hasText: name }).getAttribute("aria-selected"),
						"true",
					);
					if (name !== "Documents") assert.equal(await cards().count(), 1);
				}
				await tabs.filter({ hasText: /^All/ }).click();
				await page.getByRole("button", { name: "List view" }).click();
				await page.waitForFunction(
					() => localStorage.getItem("tedix:outputs:layout:v1") === "list",
				);
				assert.equal(
					await page.locator('[data-slot="output-grid-preview"]').count(),
					0,
				);
				await inspect(page, `${label}-list`, phone, [search, cards().first()]);
				const inert = page.locator('li[aria-disabled="true"]', {
					hasText: "Revoked source regression",
				});
				await visible(inert);
				assert.equal(await inert.getAttribute("tabindex"), null);
				assert.equal(await inert.getAttribute("role"), null);
				const before = page.url();
				await inert.click({ position: { x: 25, y: 25 } });
				assert.equal(page.url(), before);
				await inert.dispatchEvent("keydown", { key: "Enter" });
				assert.equal(page.url(), before);
				await keyboardFocus(page, cards().first());
				await inspect(page, `${label}-card-focus`, phone);
				await cards().first().press("Enter");
				await page.waitForURL((url) =>
					readable.workspace?.status === "active"
						? url.pathname === `/workspace/${readable.workspace.id}` &&
							url.searchParams.get("workpiece") ===
								`output:${readable.output.id}`
						: url.pathname === `/outputs/${readable.output.id}`,
				);
				await visible(
					page.getByText(readable.output.title, { exact: true }).first(),
				);
				await search.waitFor({ state: "hidden" });
				assert.equal(readable.preview.kind, "document");
				if (readable.preview.kind === "document") {
					const content = readable.preview.lines.find(
						(line) => line.trim() && line !== readable.output.title,
					);
					assert(content, "Readable fixture must have document body text");
					await visible(page.getByText(content, { exact: true }).last());
				}
				await inspect(page, `${label}-opened`, phone);
			});
			await scenario("pending", async () => {
				mode = "pending";
				gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const pendingRequest = page.waitForRequest(
					(request) =>
						new URL(request.url()).pathname ===
						"/api/rpc/osWorkspaces/outputs/library",
				);
				await page.goto(`${origin}/outputs`);
				await pendingRequest;
				await visible(
					page.locator(
						'section[data-slot="page"][aria-busy="true"], main[aria-busy="true"]',
					),
				);
				assert.equal(
					await page.getByText("No outputs yet", { exact: true }).count(),
					0,
				);
				assert.equal(
					await page.getByText("No matching outputs", { exact: true }).count(),
					0,
				);
				await inspect(page, `${label}-pending`, phone);
				mode = "ready";
				release();
				await ready();
			});
			mode = "ready";
			release();
			await scenario("retry", async () => {
				mode = "error";
				await page.goto(`${origin}/outputs`);
				await visible(
					page.getByText("Documents are unavailable", { exact: true }),
				);
				assert.equal(
					await page.getByText("No outputs yet", { exact: true }).count(),
					0,
				);
				await inspect(page, `${label}-error`, phone, [
					page.getByRole("button", { name: "Try again", exact: true }),
				]);
				const previousReads = reads;
				mode = "pending";
				gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const retryRequest = page.waitForRequest(
					(request) =>
						new URL(request.url()).pathname ===
						"/api/rpc/osWorkspaces/outputs/library",
				);
				await page
					.getByRole("button", { name: "Try again", exact: true })
					.click();
				await retryRequest;
				// Query may reset its error while retrying; either pending treatment
				// must remain honest, with no empty-library claim during the read.
				await visible(
					page
						.locator('[data-slot="skeleton"]')
						.first()
						.or(
							page.getByRole("button", { name: "Trying again…", exact: true }),
						)
						.first(),
				);
				assert.equal(
					await page.getByText("No outputs yet", { exact: true }).count(),
					0,
				);
				assert.equal(
					await page.getByText("No matching outputs", { exact: true }).count(),
					0,
				);
				await inspect(page, `${label}-retry-pending`, phone);
				mode = "ready";
				release();
				await ready();
				assert(reads > previousReads);
				assert.equal(
					await page
						.getByText("Documents are unavailable", { exact: true })
						.count(),
					0,
				);
			});
			mode = "ready";
			release();
			await scenario("bounded", async () => {
				library = {
					items: Array.from({ length: 200 }, (_, index) => ({
						...readable,
						output: {
							...readable.output,
							id: crypto.randomUUID(),
							title: `Bounded output ${index + 1} ${"long".repeat(20)}`,
						},
					})),
					truncated: true,
				};
				await page.goto(`${origin}/outputs`);
				await ready();
				assert.equal(await cards().count(), 20);
				await visible(
					page.getByText("Showing 20 of 200 outputs", { exact: true }),
				);
				await visible(
					page.getByText("Showing the 200 most recently updated outputs.", {
						exact: true,
					}),
				);
				await inspect(page, `${label}-bounded`, phone, [
					page.getByRole("button", { name: "Show more", exact: true }),
				]);
				await page
					.getByRole("button", { name: "Show more", exact: true })
					.click();
				assert.equal(await cards().count(), 40);
				await search.fill("Bounded output 200 ");
				await visible(cards().first());
				assert.equal(await cards().count(), 1);
				await search.fill("");
				await visible(
					page.getByText("Showing 20 of 200 outputs", { exact: true }),
				);
			});
			assert.deepEqual(
				forbidden,
				[],
				"Browsing must not invoke write/export/provider actions",
			);
			await writeFile(
				`${evidence}/${label}-console.json`,
				JSON.stringify(consoleEntries, null, 2),
			);
			await context.close();
		}
	}
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify({ origin, measurements, failures }, null, 2),
	);
	await browser?.close();
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
	`Documents browser regressions; evidence: ${evidence}`,
);
