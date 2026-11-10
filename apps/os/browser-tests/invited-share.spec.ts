import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const publicId = "PricePilotOpportunity1";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-invited-share");
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer("/");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const context = await browser.newContext({
				viewport: { width, height: 812 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await page.route("**/*", (route) =>
				new URL(route.request().url()).origin === server.origin
					? route.continue()
					: route.abort("blockedbyclient"),
			);
			await page.route("**/api/os-shared/open", (route) =>
				route.fulfill({
					json: { access: "invited", needsEmailCode: true, needsSignIn: false },
				}),
			);
			await page.route("**/api/os-shared/email/request", (route) =>
				route.fulfill({
					json: { message: "If this email is invited, we sent a code" },
				}),
			);
			await page.route("**/api/os-shared/email/verify", async (route) => {
				if (route.request().postDataJSON().code !== "123456") {
					await route.fulfill({ json: { error: "Code invalid or expired" } });
					return;
				}
				const response = await page.request.post(
					`${server.origin}/api/os-shared/open`,
					{ data: { id: publicId } },
				);
				await route.fulfill({
					json: { ...(await response.json()), access: "invited" },
				});
			});
			await page.route("**/api/os-shared/app/open", async (route) => {
				const response = await route.fetch();
				await route.fulfill({
					json: {
						...(await response.json()),
						verifiedEmail: "guest@example.test",
					},
				});
			});
			await page.goto(`${server.origin}/s/${publicId}`);
			await page.getByRole("heading", { name: "Enter your email" }).waitFor();
			await page
				.getByRole("textbox", { name: "Email", exact: true })
				.fill("guest@example.test");
			await page
				.getByRole("button", { name: "Send code", exact: true })
				.click();
			await page
				.getByText("If this email is invited, we sent a code", { exact: true })
				.waitFor();
			await page.getByRole("textbox", { name: "6-digit code" }).fill("000000");
			await page.getByRole("button", { name: "Open shared link" }).click();
			await page
				.getByText(
					"Code invalid or expired. Check the code or request a new one.",
					{ exact: true },
				)
				.waitFor();
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth + 1,
				),
			);
			await page.screenshot({
				path: join(evidence, `${width}-${theme}-email.png`),
			});
			await page.getByRole("textbox", { name: "6-digit code" }).fill("123456");
			await page.getByRole("button", { name: "Open shared link" }).click();
			await page
				.locator("[data-guest-app]")
				.getByRole("heading", { name: "Opportunity cards" })
				.waitFor();
			assert.equal(
				await page.getByRole("textbox", { name: "Your name" }).count(),
				0,
			);
			assert(
				await page.evaluate(
					(id) => sessionStorage.getItem(`tedix.os.share.${id}`),
					publicId,
				),
			);
			await page.screenshot({
				path: join(evidence, `${width}-${theme}-opened.png`),
			});
			await context.close();
		}
	}
	console.log(
		"Invited share email form passed at 375/1280 in light/dark; verified guests bypass the name prompt.",
	);
} finally {
	await browser?.close();
	await server.stop();
}
