import assert from "node:assert/strict";
import { runShellSpec } from "./shell-harness";

await runShellSpec(
	async ({
		origin,
		newPage,
		rail,
		widthIs,
		stateIs,
		capture,
		record,
		sidebarState,
		pageErrors,
	}) => {
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
		assert.match(
			(await nextFire.getAttribute("title")) ?? "",
			/Europe\/Berlin/,
		);
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
				await page.evaluate(() =>
					localStorage.getItem("tedix-os-sidebar-width"),
				),
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
				await page.evaluate(() =>
					localStorage.getItem("tedix-os-sidebar-width"),
				),
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
			const collapsedWidth = await page
				.locator('[data-sidebar="content-container"]')
				.evaluate((node) => node.getBoundingClientRect().width);
			assert.ok(
				Math.abs(collapsedWidth - 56) <= 1,
				`Peek must wait for intent (width: ${collapsedWidth})`,
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
			await page
				.locator('[data-sidebar="menu-button"][href="/outputs"]')
				.focus();
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
		await coarse
			.locator('[data-sidebar="menu-button"][href="/outputs"]')
			.focus();
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
		assert.deepEqual(
			pageErrors,
			[],
			"Shell pages must not raise browser errors",
		);
		console.log(
			"PASS: sidebar drag, keyboard bounds, reset, persistence, delayed hover/focus peek, Escape/leave, stable layout, coarse-pointer and mobile guards; light/dark",
		);
	},
);
