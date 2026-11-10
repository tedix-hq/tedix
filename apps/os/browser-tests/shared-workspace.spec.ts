import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Signed-out app-first navigation, guest identification, and file reading.
const PUBLIC_ID = "PricePilotWorkspace001";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-shared-workspace");
await mkdir(evidence, { recursive: true });

const server = await startFixtureServer("/");
let browser: Browser | undefined;

async function fits(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: no horizontal page overflow`,
	);
}

try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}/${theme}`;
			const phone = width < 820;
			const context = await browser.newContext({
				viewport: { width, height: phone ? 812 : 800 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await page.route("**/*", (route) =>
				new URL(route.request().url()).origin === server.origin
					? route.continue()
					: route.abort("blockedbyclient"),
			);

			await page.goto(`${server.origin}/s/${PUBLIC_ID}`);
			const contents = page.locator("[data-shared-workspace]");
			await contents.waitFor();
			const name = page.getByRole("textbox", { name: "Your name" });
			await name.waitFor();
			assert.match(await page.locator("form").innerText(), /Opportunity cards/);
			assert(
				(await page.locator("form").innerText()).includes(
					(await page.locator("[data-share-owner]").innerText()).trim(),
				),
			);
			await page.getByRole("button", { name: /Back to/ }).waitFor();
			await name.fill("Maya");
			const contrast = await page
				.getByRole("button", { name: "Open app", exact: true })
				.evaluate((button) => {
					const style = getComputedStyle(button);
					const canvas = document.createElement("canvas");
					canvas.width = canvas.height = 1;
					const ctx = canvas.getContext("2d")!;
					const luminance = (color: string) => {
						ctx.clearRect(0, 0, 1, 1);
						ctx.fillStyle = color;
						ctx.fillRect(0, 0, 1, 1);
						const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data)
							.slice(0, 3)
							.map((v) => v / 255)
							.map((v) =>
								v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
							);
						return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
					};
					const fg = luminance(style.color),
						bg = luminance(style.backgroundColor);
					return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
				});
			assert(
				contrast >= 4.5,
				`${label}: name prompt button contrast ${contrast}`,
			);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-name.png` });
			await page.getByRole("button", { name: "Open app", exact: true }).click();
			await page.locator("[data-guest-app]").waitFor();
			await page
				.frameLocator('iframe[title="Opportunity cards"]')
				.frameLocator("iframe")
				.getByRole("heading", { name: /opportunities for Maya/ })
				.waitFor();
			assert.equal(await page.locator("html").getAttribute("data-mode"), theme);
			assert.match(
				(await page.locator("[data-shared-by]").textContent()) ?? "",
				/Shared by/,
			);
			assert.equal(await page.locator("[data-share-owner]").count(), 1);
			assert.equal(
				await page.getByText("Latest version", { exact: true }).count(),
				0,
			);
			await fits(page, `${label} initial app`);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-app.png` });
			if (phone) await page.locator("[data-shared-back]").click();
			assert.match(
				(await page.locator("[data-shared-left-out]").textContent()) ?? "",
				/1 file isn't shown because it holds data from connected accounts/,
			);
			assert.deepEqual(
				await page
					.getByRole("navigation", { name: "In this workspace" })
					.locator("section")
					.evaluateAll((sections) =>
						sections.map((section) => section.getAttribute("aria-label")),
					),
				["Apps", "Files"],
			);
			const files = page.locator("[data-shared-file]");
			assert((await files.count()) > 0, `${label}: files are listed`);
			const runnable = page.getByRole("button", {
				name: "Open Opportunity cards",
			});
			await runnable.waitFor();
			const others = await page
				.locator("[data-shared-app]")
				.filter({ hasText: "Needs a Tedix sign-in to open" })
				.count();
			assert.equal(
				await page.locator("[data-shared-app] button:enabled").count(),
				1,
				`${label}: only the guest-ready app opens (${others} need sign-in)`,
			);
			await fits(page, `${label} list`);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-list.png` });

			// A file opens in the reader.
			await files.first().click();
			await page.locator("[data-shared-output]").waitFor();
			assert.equal(
				await page
					.getByRole("navigation", { name: "In this workspace" })
					.isVisible(),
				!phone,
				`${label}: the list stays beside the reader on a wide screen only`,
			);
			await fits(page, `${label} reader`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-reader.png`,
			});
			if (phone) {
				await page.locator("[data-shared-back]").click();
				await runnable.waitFor();
			}

			await runnable.click();
			await page.locator("[data-guest-app]").waitFor();
			assert.equal(
				await page.getByRole("textbox", { name: "Your name" }).count(),
				0,
			);
			await fits(page, `${label} reopened app`);
			await context.close();
		}
	}
	// A read-only declaration skips identification, and the owner-selected
	// app wins even when another runnable app precedes it in the list.
	const context = await browser.newContext({
		viewport: { width: 375, height: 812 },
	});
	const page = await context.newPage();
	await page.route("**/api/os-shared/open", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		const app = body.resource.gadgets.find(
			(item: { opensWithoutSignIn?: boolean }) => item.opensWithoutSignIn,
		);
		app.revision.manifest.navigation = { workspaceDefault: true };
		body.resource.gadgets.unshift({
			...app,
			id: "another-app",
			name: "Another app",
			revision: {
				...app.revision,
				manifest: { ...app.revision.manifest, navigation: {} },
			},
		});
		await route.fulfill({ response, json: body });
	});
	await page.route("**/api/os-shared/app/open", async (route) => {
		assert.equal(route.request().postDataJSON().guestName, undefined);
		const response = await route.fetch();
		const body = await response.json();
		body.app.recordsGuestInput = false;
		await route.fulfill({ response, json: body });
	});
	await page.goto(`${server.origin}/s/${PUBLIC_ID}`);
	await page.locator("[data-guest-app]").waitFor();
	assert.equal(
		await page.getByRole("textbox", { name: "Your name" }).count(),
		0,
	);
	await fits(page, "read-only app");
	await context.close();

	console.log(`shared workspace: ok (screenshots in ${evidence})`);
} finally {
	await browser?.close();
	await server.stop();
}
