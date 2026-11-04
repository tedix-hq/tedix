import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

/** A Codex-style question reads as plain English and saves after a stale refusal. */
const server = await startFixtureServer("/browser-tests/decision-plain.html");
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [390, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 844 } });
		try {
			await page.goto(
				`${server.origin}/browser-tests/decision-plain.html?stale`,
			);
			const card = page.getByRole("region", {
				name: "Give the research team read access to the pilot share?",
			});
			await card.waitFor();
			const visible = await card.innerText();
			assert.doesNotMatch(
				visible,
				/cbf08453|57e61f8a|894b5978|E151103|\.local|external_agent|shares\.update|% sure|Tedix recommends/,
				`${width}: no raw identifiers or jargon on the card`,
			);
			assert.match(visible, /3 days overdue/, `${width}: relative due date`);
			assert.match(
				visible,
				/Give access:?\s*Codex opens the research folder/,
				`${width}: the primary option says what happens`,
			);
			await card.getByRole("button", { name: "Context", exact: true }).click();
			await card
				.getByRole("link", { name: "Open Work record", exact: true })
				.waitFor();
			await card.getByLabel("Your answer").fill("Only the research folder.");
			await card
				.getByRole("button", { name: "Send answer", exact: true })
				.click();
			await card.getByText("Something changed since this was asked").waitFor();
			assert.doesNotMatch(
				await card.locator(".fd-stale").innerText(),
				/47464594|https?:/,
				`${width}: the newer note is shown without IDs or raw links`,
			);
			await card
				.getByRole("button", {
					name: "Save with the latest version",
					exact: true,
				})
				.click();
			await page.waitForFunction(
				() => document.documentElement.dataset.saved === "2",
			);
			const saved = await page.evaluate(
				() => (window as unknown as { saved: unknown[] }).saved,
			);
			assert.deepEqual(saved, [
				{
					attempts: 2,
					action: "answer",
					signal: "answer",
					body: "Only the research folder.",
					reviewedChangesThrough: "2026-11-04T09:20:00.000Z",
				},
			]);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				`${width}: no horizontal overflow`,
			);
			console.log(`Plain decision card ${width}px passed`);
		} finally {
			await page.close();
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
