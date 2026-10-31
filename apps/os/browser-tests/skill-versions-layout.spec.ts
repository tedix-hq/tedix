import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, type Locator } from "playwright";
import { startFixtureServer } from "./fixture-server";

const evidence =
	process.env.LAYOUT_EVIDENCE_DIR ??
	new URL("../node_modules/.cache/skill-versions-layout/", import.meta.url)
		.pathname;
await mkdir(evidence, { recursive: true });
const path = "/browser-tests/skill-versions-layout.html";
const server = await startFixtureServer(path);
async function bounds(locator: Locator) {
	const box = await locator.boundingBox();
	assert(box);
	return box;
}
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [320, 1280])
				for (const theme of ["light", "dark"]) {
					const label = `${engine.name()}-${width}-${theme}`;
					const page = await browser.newPage({
						viewport: { width, height: 1000 },
						reducedMotion: "reduce",
					});
					const errors: string[] = [];
					page.on("pageerror", (error) => errors.push(error.message));
					await page.goto(`${server.origin}${path}?theme=${theme}`);
					const versions = page.locator(
						'[aria-labelledby="skill-versions-title"]',
					);
					const drafts = page.locator("[data-skill-workflow-drafts]");
					await drafts
						.getByText("No improvements yet.", { exact: true })
						.waitFor();
					await page.evaluate(() => document.fonts.ready);
					const summary = await bounds(
						versions.getByText("Based on", { exact: false }),
					);
					const card = await bounds(drafts);
					const table = await bounds(versions.getByRole("table"));
					assert(
						card.y - summary.y - summary.height >= 11.5,
						`${label}: summary and drafts gap`,
					);
					assert(
						table.y - card.y - card.height >= 11.5,
						`${label}: drafts and history gap`,
					);
					const title = await bounds(
						drafts.getByRole("heading", { name: "Improvements", exact: true }),
					);
					assert(title.x - card.x >= 15, `${label}: card horizontal padding`);
					assert(title.y - card.y >= 15, `${label}: card vertical padding`);
					const create = await bounds(
						drafts.getByRole("button", { name: "New draft", exact: true }),
					);
					const description = await bounds(
						drafts.locator('[data-slot="card-description"]'),
					);
					if (width < 640) {
						assert(
							create.y - description.y - description.height >= 7.5,
							`${label}: mobile action follows its description`,
						);
					} else {
						assert(
							Math.abs(create.y - title.y) <= 1,
							`${label}: heading and action align`,
						);
					}
					const row = versions
						.getByRole("row")
						.filter({ has: page.getByText("Revision 2", { exact: true }) });
					const status = await bounds(
						row.locator("p").filter({ hasText: /^Observed/ }),
					);
					const actions = await bounds(
						row.locator('[data-slot="section-actions"]'),
					);
					assert(
						actions.y - status.y - status.height >= 11.5,
						`${label}: evidence and actions gap`,
					);
					const rollback = await bounds(
						row.getByRole("button", {
							name: "Roll back to revision 2",
							exact: true,
						}),
					);
					const details = row.getByRole("button", {
						name: "Technical evidence",
						exact: true,
					});
					const trigger = await bounds(details);
					assert(
						rollback.x + rollback.width <= width &&
							trigger.x + trigger.width <= width,
						`${label}: actions fit`,
					);
					assert(
						rollback.y + rollback.height <= trigger.y - 7.5 ||
							rollback.x + rollback.width <= trigger.x - 7.5,
						`${label}: actions are separated`,
					);
					const settings = page.getByRole("region", {
						name: "Section spacing example",
					});
					const first = await bounds(settings.locator("[data-layout-summary]"));
					const next = await bounds(settings.locator("[data-layout-next]"));
					assert(
						next.y - first.y - first.height >= 15.5,
						`${label}: margin resets and inline text retain section gap`,
					);
					await details.press("Enter");
					assert.equal(await details.getAttribute("aria-expanded"), "true");
					await row
						.getByText("Automation SHA-256:", { exact: false })
						.waitFor();
					const panelId = await details.getAttribute("aria-controls");
					assert(panelId);
					await page.waitForFunction((id) => {
						const panel = document.getElementById(id);
						return (
							panel &&
							getComputedStyle(panel).opacity === "1" &&
							panel.getBoundingClientRect().height > 48
						);
					}, panelId);
					assert.equal(
						await page.evaluate(
							() => document.documentElement.scrollWidth > innerWidth,
						),
						false,
						`${label}: no page overflow`,
					);
					await page.screenshot({
						path: `${evidence}/${label}.png`,
						fullPage: true,
					});
					await details.press("Space");
					assert.equal(await details.getAttribute("aria-expanded"), "false");
					assert.deepEqual(errors, [], `${label}: no page errors`);
					await page.close();
					console.log(`PASS versions layout ${label}`);
				}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
