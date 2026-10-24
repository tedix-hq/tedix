import assert from "node:assert/strict";
import { runShellSpec } from "./shell-harness";
import { assertLeanTopbar } from "./topbar.spec";

await runShellSpec(
	async ({
		origin,
		evidenceDir,
		newPage,
		rail,
		stateIs,
		capture,
		pageErrors,
	}) => {
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
							await title.evaluate(
								(node) => node.scrollWidth > node.clientWidth,
							),
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
		console.log(
			"PASS: resource titles, linked list ancestors, billing/workspace trails, truncation tooltip, phone last-two crumbs and client navigation; desktop/390 × light/dark",
		);
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
				const pinned = sidebar.locator('[aria-label="Pinned workspaces"]');
				await pinned
					.getByRole("button", { name: "Reddit opportunities", exact: true })
					.waitFor();
				assert.deepEqual(
					await sidebar
						.locator('[data-sidebar="group-label"]')
						.allTextContents(),
					["Pinned workspaces"],
				);
				await sidebar
					.getByRole("button", { name: "Recent workspaces", exact: true })
					.waitFor();
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
						(document.documentElement.dataset.navigationProof =
							"same-document"),
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
					await settings
						.getByRole("link", { name: label, exact: true })
						.click();
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
		assert.deepEqual(
			pageErrors,
			[],
			"Shell pages must not raise browser errors",
		);
		await assertLeanTopbar(origin, evidenceDir);
		console.log(
			"PASS: nine sidebar links, avatar-only footer, account menu, settings rail, retained URLs and titles; desktop/390 × light/dark",
		);
	},
);
