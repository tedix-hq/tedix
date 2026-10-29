import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { continueProductSessionBroker } from "../../../packages/auth/src/product-session-broker";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/loading-screens.html");
const browser = await chromium.launch();
const screenshots = "/tmp/tedix-loading-screens";
await mkdir(screenshots, { recursive: true });

async function assertCentered(page: Page, width: number, height: number) {
	const bounds = await page
		.locator("main:not([aria-hidden])")
		.evaluate((main) => {
			const children = [...main.children].map((child) =>
				child.getBoundingClientRect(),
			);
			return {
				left: Math.min(...children.map((box) => box.left)),
				right: Math.max(...children.map((box) => box.right)),
				top: Math.min(...children.map((box) => box.top)),
				bottom: Math.max(...children.map((box) => box.bottom)),
				scrollWidth: document.documentElement.scrollWidth,
			};
		});
	assert(
		Math.abs((bounds.left + bounds.right) / 2 - width / 2) <= 2,
		"horizontally centered",
	);
	assert(
		Math.abs((bounds.top + bounds.bottom) / 2 - height / 2) <= 2,
		"vertically centered",
	);
	assert(
		bounds.top >= 24 && bounds.bottom <= height - 24,
		"comfortable vertical spacing",
	);
	assert(bounds.left >= 24 && bounds.right <= width - 24, "horizontal gutters");
	assert(bounds.scrollWidth <= width, "no horizontal overflow");
}

try {
	for (const [width, height] of [
		[375, 667],
		[1280, 900],
	] as const) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
			});
			for (const state of ["preparing", "finishing", "route"]) {
				await page.goto(
					`${server.origin}/browser-tests/loading-screens.html?state=${state}&theme=${theme}`,
				);
				await page.locator('main[aria-busy="true"]').waitFor();
				await page.evaluate(() => document.fonts.ready);
				await assertCentered(page, width, height);
				assert.equal(
					await page.getByRole("button", { name: "Sign in" }).count(),
					0,
					"hidden auth controls stay inaccessible",
				);
				await page.screenshot({
					path: `${screenshots}/${state}-${width}-${theme}.png`,
				});
				console.log(`PASS ${state} ${width}px ${theme}`);
			}
			await page.goto(
				`${server.origin}/browser-tests/loading-screens.html?state=section&theme=${theme}`,
			);
			const section = page.getByRole("region", { name: "Loading list" });
			await section.waitFor();
			assert(
				(await section.boundingBox())!.height < 300,
				"section skeleton stays in its container",
			);

			const response = continueProductSessionBroker({
				redirectPath: "/work",
				request: new Request(
					"https://acme.os.tedix.dev/auth/session-broker/continue",
				),
				startPath: "/auth/session-broker/start",
				surface: "os",
			});
			// Freeze only the immediate navigation so the real redirect document can be inspected.
			const html = (await response.text()).replace(
				/<meta http-equiv="refresh"[^>]*>/,
				"",
			);
			await page.setContent(html);
			await assertCentered(page, width, height);
			assert.equal(
				await page.getByRole("link", { name: "Continue" }).getAttribute("href"),
				"/auth/session-broker/start?redirect_to=%2Fwork",
			);
			await page.screenshot({
				path: `${screenshots}/broker-${width}-${theme}.png`,
			});
			console.log(`PASS broker redirect ${width}px ${theme}`);
			await page.close();

			for (const [path, label] of [
				["/account/onboarding", "Preparing your workspace…"],
				["/account/organizations", "Opening your Tedix OS workspace…"],
			]) {
				const account = await browser.newPage({
					viewport: { width, height },
					colorScheme: theme,
				});
				await account.addInitScript((mode) => {
					localStorage.setItem("tedix-os-theme", mode);
				}, theme);
				// Hold the membership read to exercise the actual route's pending branch.
				await account.route("**/api/rpc/organizations/listOsMine**", () => {});
				await account.goto(`${server.origin}${path}`);
				await account.getByText(label, { exact: true }).waitFor();
				await account.evaluate(() => document.fonts.ready);
				await assertCentered(account, width, height);
				await account.screenshot({
					path: `${screenshots}/${path.split("/").pop()}-${width}-${theme}.png`,
				});
				console.log(`PASS ${path} ${width}px ${theme}`);
				await account.close();
			}
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
