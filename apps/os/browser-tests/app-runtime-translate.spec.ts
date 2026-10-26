import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/** The host side of the runtime translate bridge: post to the frame, read its status. */
async function translate(page: Page, target: string | null) {
	await page.evaluate((target) => {
		const frame = document.querySelector<HTMLIFrameElement>(
			'iframe[title="Rating app"]',
		);
		frame?.contentWindow?.postMessage(
			{
				jsonrpc: "2.0",
				method: "tedix/translate",
				params: { source: "de", target, glossary: { Weiter: "Next" } },
			},
			location.origin,
		);
	}, target);
}

const server = await startFixtureServer("/browser-tests/app-runtime.html");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 812 } });
		await page.addInitScript(() => {
			const seen: unknown[] = [];
			Object.assign(window, { translationStatus: seen });
			window.addEventListener("message", (event) => {
				if (event.data?.method === "tedix/translation")
					seen.push(event.data.params);
			});
		});
		await page.goto(
			`${server.origin}/browser-tests/app-runtime.html?translate`,
		);
		const guest = page
			.frameLocator('iframe[title="Rating app"]')
			.frameLocator("iframe");
		await guest.getByRole("heading", { name: "Karte 1" }).waitFor();

		await translate(page, "en");
		await guest.getByRole("heading", { name: "[en] Karte 1" }).waitFor();
		assert.equal(await guest.getByText("r/Finanzen").count(), 1);
		await guest.getByRole("button", { name: "Next", exact: true }).click();
		await guest.getByRole("heading", { name: "[en] Karte 2" }).waitFor();
		assert.deepEqual(
			await page.evaluate(
				() =>
					(window as unknown as { translationStatus: unknown[] })
						.translationStatus,
			),
			[
				{ state: "translating", language: "en" },
				{ state: "translated", language: "en" },
			],
		);

		await translate(page, null);
		await guest
			.getByRole("heading", { name: "Karte 2", exact: true })
			.waitFor();
		await guest.getByRole("button", { name: "Weiter", exact: true }).click();
		await guest
			.getByRole("heading", { name: "Karte 3", exact: true })
			.waitFor();
		const overflow = await guest
			.locator("body")
			.evaluate(
				(body) => body.scrollWidth > document.documentElement.clientWidth,
			);
		assert.equal(overflow, false);
		await page.close();
	}
	console.log("Runtime app host translation passed at 375px and 1280px");
} finally {
	await browser.close();
	await server.stop();
}
