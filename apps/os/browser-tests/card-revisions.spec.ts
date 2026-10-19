import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin =
	process.env.CARD_REVISIONS_TEST_ORIGIN ?? "http://127.0.0.1:3047";
const screenshotDirectory = process.env.CARD_REVISIONS_SCREENSHOT_DIR;
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: width === 390 ? 844 : 1000 },
				colorScheme: theme,
			});
			let version = 2;
			const original =
				"Hi Morgan,\n\nI would like to share a detailed overview of the use case and discuss the next steps.\n\nBest, Robin";
			const revised =
				"Hi Morgan,\n\nHere is the use case we discussed. Would a short call next week work?\n\nBest, Robin";
			const requestId = "44444444-4444-4444-8444-444444444444";
			const revisions = [original, revised].map((body, index) => ({
				id: `11111111-1111-4111-8111-11111111111${index}`,
				orgId: "org",
				requestId,
				revision: index + 1,
				body,
				cause: index ? "agent_rewrite" : "initial",
				actorType: "tedi",
				actorId: "author",
				actorSessionId: null,
				instruction: index ? "Make the introduction shorter and warmer." : null,
				responseId: null,
				createdAt: "2026-10-19T20:00:00.000Z",
			}));
			let pending: {
				responseId: string;
				instruction: string;
				requestedAt: string;
			} | null = null;
			await page.route("**/api/rpc/workInteractions/**", async (route) => {
				const endpoint = new URL(route.request().url()).pathname
					.split("/")
					.at(-1);
				const data =
					route.request().method() === "GET"
						? JSON.parse(
								new URL(route.request().url()).searchParams.get("data") ?? "{}",
							)
						: route.request().postDataJSON();
				const input = data?.json ?? data;
				let json: unknown;
				if (endpoint === "cardHistory")
					json = { revisions, pending, nextBeforeRevision: null };
				else if (endpoint === "get")
					json = {
						request: {
							id: requestId,
							version,
							metadata: { cardContent: revisions.at(-1)!.body },
						},
					};
				else if (endpoint === "requestCardChanges") {
					assert.equal(input.instruction, "Use a friendlier closing.");
					pending = {
						responseId: "22222222-2222-4222-8222-222222222222",
						instruction: input.instruction,
						requestedAt: new Date().toISOString(),
					};
					version++;
					json = { id: requestId, version };
				} else if (endpoint === "reviseCard") {
					assert.equal(input.restoreRevision, 1);
					version++;
					revisions.push({
						...revisions[0]!,
						id: "33333333-3333-4333-8333-333333333333",
						revision: 3,
						cause: "restore",
					});
					json = revisions.at(-1);
				} else return route.abort();
				await route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ json }),
				});
			});
			await page.goto(`${origin}/browser-tests/card-revisions.html`);
			await page.evaluate((mode) => {
				document.documentElement.classList.toggle("dark", mode === "dark");
				document.documentElement.dataset.theme = mode;
			}, theme);
			await page
				.getByRole("button", { name: "Ask for changes", exact: true })
				.waitFor();
			const credential = page.getByRole("region", {
				name: "Replace the Firecrawl key for the radar?",
			});
			assert.equal(await credential.locator("textarea").count(), 0);
			assert.equal(
				await credential
					.locator('a[href="/account/connections"]')
					.getAttribute("href"),
				"/account/connections",
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
			);
			await page.getByText("What changed", { exact: true }).click();
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/card-revisions-${width}-${theme}.png`,
					fullPage: true,
				});
			await page.getByText("Version history", { exact: true }).click();
			await page
				.getByRole("button", { name: "Restore version 1", exact: true })
				.click();
			await page.getByText("Version 3", { exact: true }).waitFor();
			await page
				.getByRole("button", { name: "Ask for changes", exact: true })
				.click();
			await page
				.getByRole("textbox", { name: "What should change?" })
				.fill("Use a friendlier closing.");
			await page
				.getByRole("button", { name: "Request changes", exact: true })
				.click();
			await page.getByRole("status").filter({ hasText: "Revising…" }).waitFor();
			await page.waitForFunction(() =>
				[...document.querySelectorAll("button")].some(
					(button) => button.textContent?.trim() === "Send" && button.disabled,
				),
			);
			assert(
				await page
					.getByRole("button", { name: "Send", exact: true })
					.isDisabled(),
			);
			if (screenshotDirectory)
				await page.screenshot({
					path: `${screenshotDirectory}/card-revisions-${width}-${theme}-revising.png`,
					fullPage: true,
				});
			await page.close();
		}
	console.log(
		"Card revisions: history, diff, restore, pending state, credential action and 1280/390 light/dark passed.",
	);
} finally {
	await browser.close();
}
