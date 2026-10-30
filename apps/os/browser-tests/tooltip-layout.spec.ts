import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { startFixtureServer } from "./fixture-server";

const fixture = "/browser-tests/tooltip-layout.html";
const evidence =
	process.env.TOOLTIP_LAYOUT_EVIDENCE_DIR ??
	new URL("../node_modules/.cache/tooltip-layout/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(fixture);
try {
	for (const engine of [chromium, webkit]) {
		const browser = await engine.launch({ headless: true });
		try {
			for (const width of [320, 1280])
				for (const theme of ["light", "dark"] as const) {
					const label = `${engine.name()}-${width}-${theme}`;
					const page = await browser.newPage({
						viewport: { width, height: 760 },
						colorScheme: theme,
					});
					const errors: string[] = [];
					page.setDefaultTimeout(15000);
					page.on("pageerror", (error) => errors.push(error.message));
					await page.goto(`${server.origin}${fixture}?theme=${theme}`);
					await page
						.getByRole("button", { name: "Long action", exact: true })
						.waitFor();
					await page.evaluate(() => document.fonts.ready);
					for (const name of [
						"Long action",
						"Long icon",
						"Long link",
						"Disabled action",
						"Explicit tooltip",
					]) {
						const control = page.getByRole("button", { name, exact: true });
						if (name === "Disabled action") await control.locator("..").hover();
						else if (name === "Long link") await control.hover();
						else await control.focus();
						const tip = page.getByRole("tooltip");
						await tip.waitFor();
						await page.waitForFunction(() => {
							const tooltip = document.querySelector('[role="tooltip"]');
							return tooltip && getComputedStyle(tooltip).opacity === "1";
						});
						if (name !== "Explicit tooltip") {
							const trigger =
								name === "Disabled action" ? control.locator("..") : control;
							const description = (
								await trigger.getAttribute("aria-describedby")
							)?.split(" ");
							assert(
								description?.includes((await tip.getAttribute("id"))!),
								`${label} ${name}: tooltip description is linked`,
							);
							if (name === "Long action")
								assert(
									description.includes("existing-description"),
									"existing description is preserved",
								);
						}
						if (name === "Long link")
							assert.equal(
								await control.getAttribute("href"),
								"#preview",
								"rendered anchor retains destination",
							);
						const box = await tip.evaluate((element) => {
							const bounds = element.getBoundingClientRect();
							return {
								width: bounds.width,
								left: bounds.left,
								right: bounds.right,
								height: bounds.height,
								scrollWidth: element.scrollWidth,
								clientWidth: element.clientWidth,
							};
						});
						assert(
							box.width <= Math.min(320, width - 16) + 1,
							`${label} ${name}: readable width`,
						);
						assert(
							box.left >= 0 && box.right <= width + 1,
							`${label} ${name}: inside viewport`,
						);
						assert(
							box.scrollWidth <= box.clientWidth + 1,
							`${label} ${name}: text wraps`,
						);
						assert(
							box.height > 40,
							`${label} ${name}: long content spans lines`,
						);
						if (name === "Long action") {
							await control.click();
							assert.equal(
								await page.getByLabel("Action count").innerText(),
								"1",
								"tooltip preserves click handler",
							);
						}
						await page.keyboard.press("Escape");
						await page.mouse.move(0, 0);
						await control.blur();
						await tip.waitFor({ state: "hidden" });
					}
					await page
						.getByRole("button", { name: "Approvals", exact: true })
						.focus();
					await page
						.getByRole("tooltip")
						.getByText("Requests waiting for your approval.", { exact: true })
						.waitFor();
					await page.waitForFunction(() => {
						const tooltip = document.querySelector('[role="tooltip"]');
						return tooltip && getComputedStyle(tooltip).opacity === "1";
					});
					await page.screenshot({ path: join(evidence, `${label}.png`) });
					assert.deepEqual(errors, [], `${label}: no page errors`);
					await page.close();
					console.log(`PASS tooltip layout ${label}`);
				}
		} finally {
			await browser.close();
		}
	}
} finally {
	await server.stop();
}
