import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, type Locator, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.LAYOUT_EVIDENCE_DIR ??
	new URL("../node_modules/.cache/skill-settings-layout/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const path = "/browser-tests/skill-settings-layout.html";
const server = await startFixtureServer(path);

async function bounds(locator: Locator) {
	const box = await locator.boundingBox();
	assert(box);
	return box;
}

/** Nothing reaches past the viewport: the page, or any control on it. */
async function assertFits(page: Page, width: number, label: string) {
	assert.equal(
		await page.evaluate(
			() => document.documentElement.scrollWidth > innerWidth,
		),
		false,
		`${label}: no page overflow`,
	);
	for (const control of await page.locator("button:visible, a:visible").all()) {
		const box = await bounds(control);
		assert(
			box.x >= 0 && box.x + box.width <= width + 0.5,
			`${label}: "${await control.innerText()}" fits`,
		);
	}
}

try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [375, 1280])
				for (const theme of ["light", "dark"]) {
					const label = `${engine.name()}-${width}-${theme}`;
					const page = await browser.newPage({
						viewport: { width, height: 1000 },
						reducedMotion: "reduce",
					});
					const errors: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));

					// Settings: schedule, owner, connections, inputs.
					await page.goto(`${server.origin}${path}?theme=${theme}`);
					const row = page.locator("[data-schedule-row]");
					await row.waitFor();
					await page.evaluate(() => document.fonts.ready);
					assert.deepEqual(
						await page.locator("h2").allInnerTexts(),
						["Schedule", "Owner", "Connections and tools", "Inputs"],
						`${label}: settings sections in order`,
					);
					assert.equal(
						await row.locator("[data-schedule-cadence]").innerText(),
						"Every day at 9:00 AM",
						`${label}: schedule in local time`,
					);
					assert.match(
						await row.innerText(),
						/Runs as Miles · starts with Period: last_7_days/,
						`${label}: who runs it and with what`,
					);
					assert.deepEqual(
						await page
							.locator("[data-skill-connection]")
							.evaluateAll((items) =>
								items.map((item) => [
									item.querySelector("strong")?.textContent,
									item.getAttribute("data-skill-connection"),
								]),
							),
						[
							["Sheets", "no_app"],
							["Storefront", "ready"],
							["Support inbox", "setup_needed"],
						],
						`${label}: connections with their status`,
					);
					assert.deepEqual(
						await page.locator("[data-skill-input] strong").allInnerTexts(),
						["Period", "Include refunds"],
						`${label}: inputs by label`,
					);
					// Stored expressions, ids and call names stay behind a disclosure.
					assert.doesNotMatch(
						await page.locator("body").innerText(),
						/0 8 \* \* \*|UTC|fictional-|list_orders|includeRefunds|Cron/,
						`${label}: no raw schedule, ids or code in view`,
					);
					await assertFits(page, width, `${label} settings`);
					const details = row.getByRole("button", {
						name: "Technical details",
						exact: true,
					});
					await details.press("Enter");
					await row
						.getByText("Stored schedule (UTC): 0 8 * * *", { exact: true })
						.waitFor();
					await assertFits(page, width, `${label} settings details`);
					await page.screenshot({
						path: `${evidence}/${label}-settings.png`,
						fullPage: true,
					});

					// The time is changed as a local time, and the dialog can be left.
					await row
						.getByRole("button", { name: "Change time", exact: true })
						.click();
					const dialog = page.getByRole("dialog", { name: "Change schedule" });
					await dialog.waitFor();
					assert.equal(
						await dialog.getByLabel("Time", { exact: true }).inputValue(),
						"09:00",
						`${label}: dialog starts at the local time`,
					);
					assert.doesNotMatch(await dialog.innerText(), /UTC/);
					const sheet = await bounds(dialog);
					assert(
						sheet.x >= 0 && sheet.x + sheet.width <= width,
						`${label}: dialog fits`,
					);
					await page.screenshot({ path: `${evidence}/${label}-dialog.png` });
					await dialog
						.getByRole("button", { name: "Cancel", exact: true })
						.click();
					await dialog.waitFor({ state: "hidden" });

					// Source: files, steps and the stored input definition.
					await page.goto(`${server.origin}${path}?theme=${theme}&tab=source`);
					await page
						.getByRole("heading", { name: "Workflow anatomy", exact: true })
						.waitFor();
					await page.evaluate(() => document.fonts.ready);
					assert.deepEqual(
						await page.locator("h2").allInnerTexts(),
						["Instructions and files", "Workflow anatomy", "Input definition"],
						`${label}: source sections in order`,
					);
					const anatomy = page.locator(
						'[aria-labelledby="skill-anatomy-title"]',
					);
					// A step named by a variable is called by what it does.
					await anatomy
						.getByText("Write report in sheets", { exact: true })
						.waitFor();
					assert.doesNotMatch(
						await anatomy.locator("ol").innerText(),
						/^label$/m,
						`${label}: no code expression as a step name`,
					);
					await page
						.locator('[aria-labelledby="skill-input-definition-title"]')
						.getByText('"includeRefunds"', { exact: false })
						.waitFor();
					await assertFits(page, width, `${label} source`);
					await page.screenshot({
						path: `${evidence}/${label}-source.png`,
						fullPage: true,
					});
					assert.deepEqual(errors, [], `${label}: no page errors`);
					await page.close();
					console.log(`PASS skill settings and source layout ${label}`);
				}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
