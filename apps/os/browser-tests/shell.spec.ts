import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
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
			{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
		);
const evidenceDir = process.env.SHELL_EVIDENCE_DIR;
let browser: Browser | undefined;
const rail = (page: Page) => page.locator('[data-sidebar="sidebar"]');
async function widthIs(page: Page, width: number) {
	await page.waitForFunction(
		(expected) =>
			Math.abs(
				(document
					.querySelector('[data-sidebar="sidebar"]')
					?.getBoundingClientRect().width ?? 0) - expected,
			) < 1,
		width,
	);
}
async function stateIs(page: Page, state: string) {
	await page.waitForFunction(
		(expected) =>
			document
				.querySelector('[data-sidebar="sidebar"]')
				?.getAttribute("data-state") === expected,
		state,
	);
}
async function capture(page: Page, name: string) {
	await page.waitForTimeout(300);
	if (evidenceDir)
		await page.screenshot({
			path: `${evidenceDir}/kumo-shell-2-${name}.png`,
			fullPage: true,
		});
}
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		if (i === 99) throw new Error("Shell fixture server did not start");
		await Bun.sleep(200);
	}
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		const page = await browser.newPage({
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
		await page.reload();
		await widthIs(page, 360);
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
	const coarse = await browser.newPage({
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
		const page = await browser.newPage({
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
			const page = await browser.newPage({
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
			await page.close();
		}
	}
	for (const theme of ["light", "dark"] as const) {
		for (const [plan, collapsed, destination, section] of [
			["enterprise", false, "/admin/billing", "Usage"],
			["growth", false, "/admin/billing?section=subscription", "Subscription"],
			["growth", true, "/admin/billing", "Usage"],
		] as const) {
			const page = await browser.newPage({
				viewport: { width: 1280, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript(
				({ theme, collapsed }) => {
					localStorage.setItem("tedix-os-theme", theme);
					localStorage.setItem(
						"tedix-os-sidebar-collapsed",
						collapsed ? "1" : "0",
					);
				},
				{ theme, collapsed },
			);
			await page.route("**/api/rpc/billing/getOverview**", async (route) => {
				const response = await route.fetch();
				const body = await response.json();
				body.json.snapshot.status = "past_due";
				body.json.snapshot.planKey = plan;
				await route.fulfill({ response, json: body });
			});
			let documentRequests = 0;
			page.on("request", (request) => {
				if (
					request.isNavigationRequest() &&
					request.resourceType() === "document" &&
					request.frame() === page.mainFrame()
				)
					documentRequests++;
			});
			await page.goto(`${origin}/team`);
			const link = collapsed
				? page.getByRole("link", { name: "Billing and usage", exact: true })
				: page.locator(`[data-sidebar="footer"] a[href="${destination}"]`);
			await link.waitFor();
			if (collapsed)
				assert.equal(await link.getAttribute("data-sidebar"), "menu-button");
			documentRequests = 0;
			await page.evaluate(
				() =>
					(document.documentElement.dataset.navigationProof =
						"billing-same-document"),
			);
			await link.click();
			await page.waitForURL(
				(url) => `${url.pathname}${url.search}` === destination,
			);
			const selected = page.getByRole("tab", { name: section, exact: true });
			await selected.waitFor();
			assert.equal(await selected.getAttribute("aria-selected"), "true");
			await page.getByRole("tabpanel").waitFor();
			assert.equal(
				await page.evaluate(
					() => document.documentElement.dataset.navigationProof,
				),
				"billing-same-document",
			);
			assert.equal(
				documentRequests,
				0,
				"Billing link performed document navigation",
			);
			if (section === "Subscription")
				await capture(page, `billing-subscription-1280-${theme}`);
			console.log(
				`PASS billing ${plan}/${collapsed ? "collapsed" : "expanded"}/${theme}: ${section}`,
			);
			await page.close();
		}
	}
	for (const theme of ["light", "dark"] as const) {
		const page = await browser.newPage({
			viewport: { width: 390, height: 900 },
			colorScheme: theme,
		});
		await page.addInitScript(
			(value) => localStorage.setItem("tedix-os-theme", value),
			theme,
		);
		await page.route("**/api/rpc/billing/getOverview**", async (route) => {
			const response = await route.fetch();
			const body = await response.json();
			body.json.snapshot.status = "past_due";
			await route.fulfill({ response, json: body });
		});
		await page.goto(`${origin}/admin/billing`);
		await page.getByRole("tab", { name: "Usage", exact: true }).waitFor();
		await page
			.getByRole("button", { name: "Toggle navigation", exact: true })
			.click();
		await stateIs(page, "expanded");
		await page.evaluate(
			() =>
				(document.documentElement.dataset.navigationProof =
					"mobile-billing-same-document"),
		);
		await page
			.locator(
				'[data-sidebar="footer"] a[href="/admin/billing?section=subscription"]',
			)
			.click();
		await page.waitForURL(
			(url) =>
				url.pathname === "/admin/billing" &&
				url.search === "?section=subscription",
		);
		await stateIs(page, "collapsed");
		assert.equal(
			await page
				.getByRole("tab", { name: "Subscription", exact: true })
				.getAttribute("aria-selected"),
			"true",
		);
		assert.equal(
			await page.evaluate(
				() => document.documentElement.dataset.navigationProof,
			),
			"mobile-billing-same-document",
		);
		await capture(page, `billing-subscription-390-${theme}`);
		await page.close();
	}
	console.log(
		"PASS: expanded Manage/Upgrade and collapsed billing row navigate client-side to Usage/Subscription; light/dark",
	);
	console.log(
		"PASS: resource titles, linked list ancestors, billing/workspace trails, truncation tooltip, phone last-two crumbs and client navigation; desktop/390 × light/dark",
	);
	console.log(
		"PASS: sidebar drag, keyboard bounds, reset, persistence, delayed hover/focus peek, Escape/leave, stable layout, coarse-pointer and mobile guards; light/dark",
	);
} finally {
	await browser?.close();
	if (server) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {
			server.kill();
		}
		await server.exited;
	}
}
