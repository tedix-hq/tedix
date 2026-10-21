import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { assertLeanTopbar } from "./topbar.spec";

const cwd = new URL("../", import.meta.url).pathname;
const evidenceDir = process.env.SHELL_EVIDENCE_DIR;
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
const events: string[] = [];
function record(event: string, detail: unknown) {
	const line = JSON.stringify({ at: new Date().toISOString(), event, detail });
	events.push(line);
	if (events.length > 200) events.shift();
	if (evidenceDir)
		appendFileSync(`${evidenceDir}/lifecycle.jsonl`, `${line}\n`);
}
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = process.env.SHELL_TEST_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.SHELL_TEST_ORIGIN
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
			{ cwd, stdout: "pipe", stderr: "pipe", detached: true },
		);
record("server", { origin, pid: server?.pid, owned: Boolean(server) });
async function readOutput(stream: ReadableStream<Uint8Array>, name: string) {
	const decoder = new TextDecoder();
	for await (const chunk of stream) {
		const text = decoder.decode(chunk, { stream: true });
		record(name, text);
		(name === "stdout" ? process.stdout : process.stderr).write(text);
	}
}
const output = server
	? Promise.all([
			readOutput(server.stdout, "stdout"),
			readOutput(server.stderr, "stderr"),
		])
	: Promise.resolve();
let stopping = false;
const stop = new AbortController();
const serverExited = server?.exited.then((code) => {
	record("server-exit", {
		pid: server.pid,
		code,
		signal: server.signalCode,
		stopping,
	});
	if (!stopping)
		throw new Error(`Shell fixture server ${server.pid} exited: ${code}`);
});
let browser: Browser | undefined;
const pageErrors: string[] = [];
async function sidebarState(page: Page) {
	return page.evaluate(() => ({
		url: location.href,
		readyState: document.readyState,
		viewport: { width: innerWidth, height: innerHeight },
		mode: document.documentElement.dataset.mode,
		sidebars: Array.from(
			document.querySelectorAll('[data-sidebar="sidebar"]'),
		).map((node) => ({
			state: node.getAttribute("data-state"),
			rect: node.getBoundingClientRect().toJSON(),
		})),
	}));
}
async function newPage(options?: Parameters<Browser["newPage"]>[0]) {
	assert(browser);
	const page = await browser.newPage(options);
	page.on("pageerror", (error) => {
		pageErrors.push(error.stack ?? String(error));
		record("page-error", {
			url: page.url(),
			error: error.stack ?? String(error),
		});
	});
	page.on("console", (message) => {
		if (["error", "warning"].includes(message.type()))
			record("console", {
				url: page.url(),
				type: message.type(),
				text: message.text(),
			});
	});
	page.on("requestfailed", (request) =>
		record("request-failed", {
			url: request.url(),
			local: new URL(request.url()).origin === origin,
			method: request.method(),
			failure: request.failure(),
		}),
	);
	page.on("response", (response) => {
		if (response.status() >= 400 && new URL(response.url()).origin === origin)
			record("http-error", { url: response.url(), status: response.status() });
	});
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame()) record("navigation", { url: frame.url() });
	});
	return page;
}
const rail = (page: Page) => page.locator('[data-sidebar="sidebar"]');
async function widthIs(page: Page, width: number) {
	record("wait-width", { url: page.url(), width });
	await page.waitForFunction(
		(expected) =>
			Math.abs(
				(document
					.querySelector('[data-sidebar="sidebar"]')
					?.getBoundingClientRect().width ?? 0) - expected,
			) < 1,
		width,
	);
	record("sidebar", await sidebarState(page));
}
async function stateIs(page: Page, state: string) {
	record("wait-state", { url: page.url(), state });
	await page.waitForFunction(
		(expected) =>
			document
				.querySelector('[data-sidebar="sidebar"]')
				?.getAttribute("data-state") === expected,
		state,
	);
	record("sidebar", await sidebarState(page));
}
async function capture(page: Page, name: string) {
	await page.waitForTimeout(300);
	if (evidenceDir)
		await page.screenshot({
			path: `${evidenceDir}/plain-labels-${name}.png`,
			fullPage: true,
		});
}
async function runShell() {
	const deadline = Date.now() + 20_000;
	const readinessUrl = `${origin}/skills?section=triggers`;
	for (let i = 0; i < 100; i++) {
		stop.signal.throwIfAborted();
		try {
			const response = await fetch(readinessUrl, {
				signal: AbortSignal.any([
					stop.signal,
					AbortSignal.timeout(Math.max(1, deadline - Date.now())),
				]),
			});
			record("readiness", { url: readinessUrl, status: response.status });
			if (response.ok && (await response.text()).includes("/src/main.tsx"))
				break;
		} catch (error) {
			record("readiness-error", String(error));
		}
		if (i === 99 || Date.now() >= deadline)
			throw new Error(
				"Shell fixture server did not serve the SPA entry within 20000ms",
			);
		await Bun.sleep(200);
	}
	stop.signal.throwIfAborted();
	browser = await chromium.launch({ headless: true });
	stop.signal.throwIfAborted();
	const preferencesPage = await newPage({
		timezoneId: "America/New_York",
	});
	let releasePreferences!: () => void;
	const preferencesReady = new Promise<void>((resolve) => {
		releasePreferences = resolve;
	});
	await preferencesPage.route(
		"**/api/rpc/userSettings/getPreferences**",
		async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			body.json.preferences.locale = "en-US";
			body.json.preferences.timezone = "Europe/Berlin";
			await preferencesReady;
			await route.fulfill({ response, json: body });
		},
	);
	const instant = "2099-08-14T01:40:00Z";
	await preferencesPage.route(
		"**/api/rpc/skills/listWorkflowSchedules**",
		async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			body.json.schedules[0].nextFireAt = instant;
			await route.fulfill({ response, json: body });
		},
	);
	await preferencesPage.goto(`${origin}/skills?section=triggers`);
	const nextFire = preferencesPage
		.locator(`time[datetime="${instant}"]`)
		.first();
	await nextFire.waitFor();
	assert.match(await nextFire.innerText(), /Aug 13, 2099, 9:40\s?PM/);
	const mountedTimestamp = await nextFire.elementHandle();
	releasePreferences();
	await preferencesPage.waitForFunction(() =>
		document
			.querySelector('time[datetime="2099-08-14T01:40:00Z"]')
			?.textContent?.includes("Europe/Berlin"),
	);
	assert.match(await nextFire.innerText(), /Aug 14, 2099, 3:40\s?AM/);
	assert.equal(
		await mountedTimestamp?.evaluate((node) => node.isConnected),
		true,
	);
	assert.match((await nextFire.getAttribute("title")) ?? "", /Europe\/Berlin/);
	await preferencesPage.close();
	console.log(
		"PASS: direct-link timestamps update after delayed timezone preferences without remount",
	);
	for (const theme of ["light", "dark"] as const) {
		const page = await newPage({
			viewport: { width: 1280, height: 900 },
			colorScheme: theme,
		});
		await page.addInitScript(
			(value) => localStorage.setItem("tedix-os-theme", value),
			theme,
		);
		await page.goto(`${origin}/team`);
		await rail(page).waitFor();
		await page.evaluate((value) => {
			document.documentElement.classList.toggle("dark", value === "dark");
			document.documentElement.dataset.theme = "tedix";
			document.documentElement.dataset.mode = value;
		}, theme);
		await widthIs(page, 260);
		let handle = page.getByRole("separator", { name: "Resize sidebar" });
		const bounds = await handle.boundingBox();
		assert(bounds);
		await page.mouse.move(bounds.x + bounds.width / 2, 350);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width / 2 + 100, 350, {
			steps: 10,
		});
		await page.mouse.up();
		await widthIs(page, 360);
		assert.equal(await handle.getAttribute("aria-valuenow"), "360");
		assert.equal(
			await page.evaluate(() => localStorage.getItem("tedix-os-sidebar-width")),
			"360",
		);
		await capture(page, `resize-360-1280-${theme}`);
		record("reload-start", await sidebarState(page));
		await page.reload();
		await widthIs(page, 360);
		record("reload-ready", await sidebarState(page));
		handle = page.getByRole("separator", { name: "Resize sidebar" });
		await handle.focus();
		await page.keyboard.press("Home");
		await widthIs(page, 220);
		await page.keyboard.press("ArrowLeft");
		await widthIs(page, 220);
		await capture(page, `resize-220-1280-${theme}`);
		await page.keyboard.press("ArrowRight");
		await widthIs(page, 230);
		await handle.dblclick({ position: { x: 4, y: 350 } });
		await widthIs(page, 260);
		assert.equal(
			await page.evaluate(() => localStorage.getItem("tedix-os-sidebar-width")),
			"260",
		);
		await page
			.getByRole("button", { name: "Collapse sidebar", exact: true })
			.click();
		await page.mouse.move(600, 400);
		await widthIs(page, 56);
		await page.waitForTimeout(300);
		const contentX = await page
			.locator(".os-main")
			.evaluate((node) => node.getBoundingClientRect().x);
		await page.mouse.move(25, 220);
		await page.waitForTimeout(50);
		assert.equal(
			await page
				.locator('[data-sidebar="content-container"]')
				.evaluate((node) => node.getBoundingClientRect().width),
			56,
			"Peek must wait for intent",
		);
		await stateIs(page, "peeking");
		await page.waitForTimeout(450);
		assert.equal(
			await page
				.locator(".os-main")
				.evaluate((node) => node.getBoundingClientRect().x),
			contentX,
			"Peek shifted layout",
		);
		await widthIs(page, 56);
		assert.equal(
			await page
				.locator('[data-sidebar="content-container"]')
				.evaluate((node) => node.getBoundingClientRect().width),
			260,
		);
		await capture(page, `peek-open-1280-${theme}`);
		await page.keyboard.press("Escape");
		await stateIs(page, "collapsed");
		await page.mouse.move(600, 400);
		await page.mouse.move(25, 220);
		await stateIs(page, "peeking");
		await page.mouse.move(600, 400);
		await stateIs(page, "collapsed");
		await page.locator('[data-sidebar="menu-button"][href="/outputs"]').focus();
		await stateIs(page, "peeking");
		await page.keyboard.press("Escape");
		await stateIs(page, "collapsed");
		assert.equal(
			await page.evaluate(() =>
				localStorage.getItem("tedix-os-sidebar-collapsed"),
			),
			"1",
		);
		await page.setViewportSize({ width: 390, height: 900 });
		await page
			.getByRole("button", { name: "Toggle navigation", exact: true })
			.click();
		await stateIs(page, "expanded");
		assert.equal(
			await page.getByRole("separator", { name: "Resize sidebar" }).count(),
			0,
		);
		await capture(page, `sidebar-390-${theme}`);
		await page.keyboard.press("Escape");
		await stateIs(page, "collapsed");
		assert.equal(
			await page.evaluate(() =>
				localStorage.getItem("tedix-os-sidebar-collapsed"),
			),
			"1",
		);
		await page.close();
	}
	const coarse = await newPage({
		viewport: { width: 1280, height: 900 },
		hasTouch: true,
	});
	await coarse.addInitScript(() =>
		localStorage.setItem("tedix-os-sidebar-collapsed", "1"),
	);
	await coarse.goto(`${origin}/team`);
	await widthIs(coarse, 56);
	await coarse.mouse.move(25, 220);
	await coarse.waitForTimeout(350);
	assert.equal(await rail(coarse).getAttribute("data-state"), "collapsed");
	await coarse.locator('[data-sidebar="menu-button"][href="/outputs"]').focus();
	await coarse.waitForTimeout(350);
	assert.equal(await rail(coarse).getAttribute("data-state"), "collapsed");
	await coarse.close();
	for (const storedWidth of ["invalid", "9999", "blocked"]) {
		const page = await newPage({
			viewport: { width: 1280, height: 900 },
		});
		await page.addInitScript((value) => {
			if (value === "blocked") {
				const getItem = Storage.prototype.getItem;
				const setItem = Storage.prototype.setItem;
				Storage.prototype.getItem = function (key) {
					if (key.startsWith("tedix-os-sidebar"))
						throw new DOMException("Storage blocked", "SecurityError");
					return getItem.call(this, key);
				};
				Storage.prototype.setItem = function (key, next) {
					if (key.startsWith("tedix-os-sidebar"))
						throw new DOMException("Storage blocked", "SecurityError");
					setItem.call(this, key, next);
				};
			} else localStorage.setItem("tedix-os-sidebar-width", value);
		}, storedWidth);
		await page.goto(`${origin}/team`);
		await widthIs(page, 260);
		await page.getByRole("separator", { name: "Resize sidebar" }).focus();
		await page.keyboard.press("ArrowRight");
		await widthIs(page, 270);
		await page.close();
	}
	for (const theme of ["light", "dark"] as const) {
		for (const width of [1280, 390]) {
			const page = await newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(value) => localStorage.setItem("tedix-os-theme", value),
				theme,
			);
			const longTitle =
				"Booth video 1 script and storyboard — production notes and scene-by-scene direction";
			await page.route(
				"**/api/rpc/osWorkspaces/outputs/get**",
				async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					body.json.output.title = longTitle;
					await route.fulfill({ response, json: body });
				},
			);
			for (const [name, path, parent, expected] of [
				[
					"outputs",
					"/outputs/00000040-0000-4000-8000-000000000001",
					"/outputs",
					longTitle,
				],
				[
					"skill",
					"/skills/00000020-0000-4000-8000-000000000001",
					"/skills",
					null,
				],
				[
					"app",
					"/apps/00000080-0000-4000-8000-000000000001",
					"/gateways",
					null,
				],
				["billing", "/admin/billing", "/admin", "Billing"],
				[
					"workspace",
					"/workspace/00000030-0000-4000-8000-000000000001",
					"/workspaces",
					null,
				],
			] as const) {
				await page.goto(`${origin}${path}`);
				const trail = page.getByRole("navigation", {
					name: "breadcrumb",
					exact: true,
				});
				await trail.waitFor();
				const current = trail.locator('[aria-current="page"]:visible');
				if (expected)
					await page.waitForFunction(
						(value) =>
							Array.from(
								document.querySelectorAll(
									'nav[aria-label="breadcrumb"] [aria-current="page"]',
								),
							).some((node) => node.textContent === value),
						expected,
					);
				else {
					await page.waitForFunction(() =>
						Array.from(
							document.querySelectorAll(
								'nav[aria-label="breadcrumb"] [aria-current="page"]',
							),
						).some(
							(node) =>
								node.textContent &&
								node.textContent !== "Skill" &&
								node.textContent !== "App",
						),
					);
					assert.equal(
						(await current.textContent())?.trim(),
						(
							await page
								.getByRole("heading", { level: 1 })
								.first()
								.textContent()
						)?.trim(),
					);
				}
				const parentHref =
					width === 390 && name === "workspace" ? path : parent;
				assert.equal(
					await trail.locator(`a[href="${parentHref}"]:visible`).count(),
					1,
				);
				assert.equal(await trail.locator('a[href="#"]').count(), 0);
				if (width === 390) {
					assert.equal(
						(await trail.locator('[aria-current="page"]:visible').count()) +
							(await trail.locator("a:visible").count()),
						2,
					);
					assert.equal(
						await page.evaluate(
							() => document.documentElement.scrollWidth > innerWidth,
						),
						false,
						`${name} overflows phone`,
					);
				}
				if (name === "outputs" && width === 390) {
					const title = current.locator("[tabindex='0']");
					assert(
						await title.evaluate((node) => node.scrollWidth > node.clientWidth),
						"Long title was not truncated",
					);
					await title.focus();
					await page.getByRole("tooltip").waitFor();
					assert.equal(
						await page.getByRole("tooltip").textContent(),
						longTitle,
					);
					await page.keyboard.press("Escape");
					await title.evaluate((node) => (node as HTMLElement).blur());
				}
				await capture(page, `breadcrumbs-${name}-${width}-${theme}`);
				await page.evaluate(
					() =>
						(document.documentElement.dataset.navigationProof =
							"same-document"),
				);
				await trail.locator(`a[href="${parentHref}"]:visible`).click();
				await page.waitForURL((url) => url.pathname === parentHref);
				assert.equal(
					await page.evaluate(
						() => document.documentElement.dataset.navigationProof,
					),
					"same-document",
					"Breadcrumb reloaded document",
				);
			}
			await page.unrouteAll({ behavior: "wait" });
			await page.close();
		}
	}
	for (const theme of ["light", "dark"] as const) {
		for (const width of [1280, 390]) {
			const page = await newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				(value) => localStorage.setItem("tedix-os-theme", value),
				theme,
			);
			await page.goto(`${origin}/team`);
			if (width === 390)
				await capture(page, `sidebar-collapsed-${width}-${theme}`);
			if (width === 390)
				await page
					.getByRole("button", { name: "Toggle navigation", exact: true })
					.click();
			const sidebar = rail(page);
			await sidebar.waitFor();
			await sidebar.getByText("36", { exact: true }).waitFor();
			assert.deepEqual(await sidebar.locator("a").allTextContents(), [
				"Work36",
				"Chat",
				"Workspaces",
				"Documents",
				"Team",
				"Skills",
				"Connections",
				"Websites",
				"Memory",
			]);
			assert.equal(
				await sidebar.locator('[data-sidebar="group-label"]').count(),
				0,
			);
			assert.equal(
				await sidebar.locator('[data-sidebar="footer"] a').count(),
				0,
			);
			await capture(page, `sidebar-expanded-${width}-${theme}`);
			if (width === 1280) {
				await page
					.getByRole("button", { name: "Collapse sidebar", exact: true })
					.click();
				await stateIs(page, "collapsed");
				await capture(page, `sidebar-collapsed-${width}-${theme}`);
			}
			await page
				.getByRole("button", { name: "Account menu", exact: true })
				.click();
			const menu = page.getByRole("menu");
			await menu.waitFor();
			const labels = await menu.getByRole("menuitem").allTextContents();
			assert(labels[0]?.startsWith("Usage"));
			assert.deepEqual(labels.slice(1), [
				"Billing",
				"Settings",
				"Personal settings",
				"Install apps",
				"Sign out",
			]);
			await capture(page, `avatar-menu-${width}-${theme}`);
			await page.evaluate(
				() =>
					(document.documentElement.dataset.navigationProof = "same-document"),
			);
			await menu
				.getByRole("menuitem", { name: "Billing", exact: true })
				.click();
			await page.waitForURL((url) => url.pathname === "/admin/billing");
			assert.equal(
				await page.evaluate(
					() => document.documentElement.dataset.navigationProof,
				),
				"same-document",
			);
			if (width === 390) await stateIs(page, "collapsed");
			const settings = page.getByRole("navigation", {
				name: "Settings sections",
				exact: true,
			});
			await settings.waitFor();
			for (const label of [
				"Templates",
				"Website chat",
				"Activity log",
				"Usage & billing",
				"Usage",
				"Billing",
			])
				assert.equal(
					await settings
						.getByRole("link", { name: label, exact: true })
						.count(),
					1,
				);
			await capture(page, `settings-rail-${width}-${theme}`);
			await capture(page, `breadcrumb-${width}-${theme}`);
			for (const [label, path, heading] of [
				["Usage", "/compute", "Usage"],
				["Billing", "/admin/billing", "Billing"],
				["Templates", "/blueprints", "Templates"],
				["Website chat", "/widget", "Website chat"],
				["Activity log", "/audit", "Activity log"],
			]) {
				await settings.getByRole("link", { name: label, exact: true }).click();
				await page.waitForURL((url) => url.pathname === path);
				await page
					.getByRole("heading", { name: heading, exact: true, level: 1 })
					.waitFor();
				assert.equal(
					await settings
						.getByRole("link", { name: label, exact: true })
						.getAttribute("aria-current"),
					"page",
				);
				await page.waitForFunction(
					(label) => document.title.includes(label),
					label,
				);
			}
			await page.close();
		}
	}
	assert.deepEqual(pageErrors, [], "Shell pages must not raise browser errors");
	await assertLeanTopbar(origin, evidenceDir);
	console.log(
		"PASS: nine sidebar links, avatar-only footer, account menu, settings rail, retained URLs and titles; desktop/390 × light/dark",
	);

	console.log(
		"PASS: resource titles, linked list ancestors, billing/workspace trails, truncation tooltip, phone last-two crumbs and client navigation; desktop/390 × light/dark",
	);
	console.log(
		"PASS: sidebar drag, keyboard bounds, reset, persistence, delayed hover/focus peek, Escape/leave, stable layout, coarse-pointer and mobile guards; light/dark",
	);
}
const running = runShell();
try {
	await Promise.race([
		running,
		...(serverExited ? [serverExited] : []),
		output.then(() => new Promise<never>(() => {})),
	]);
} catch (error) {
	stop.abort(error);
	record("failure", String(error));
	let failurePage = 0;
	for (const context of browser?.contexts() ?? []) {
		for (const page of context.pages()) {
			try {
				record("failure-sidebar", await sidebarState(page));
				if (evidenceDir)
					await page.screenshot({
						path: `${evidenceDir}/failure-${failurePage++}.png`,
						timeout: 1000,
					});
			} catch (diagnosticError) {
				record("diagnostic-error", {
					url: page.url(),
					error: String(diagnosticError),
				});
			}
		}
	}
	console.error(events.join("\n"));
	throw error;
} finally {
	stopping = true;
	stop.abort();
	try {
		const closingBrowser = browser;
		await closingBrowser?.close();
		// An exit can win the race while Chromium is still launching.
		await Promise.allSettled([running]);
		if (browser !== closingBrowser) await browser?.close();
	} finally {
		if (server) {
			try {
				process.kill(-server.pid, "SIGTERM");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			await server.exited;
			await output;
		}
	}
}
