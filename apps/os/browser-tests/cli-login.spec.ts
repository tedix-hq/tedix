import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/cli-login.html");
const browser = await chromium.launch();
const started = performance.now();
try {
	for (const width of [320, 390, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 3000 },
				colorScheme: theme,
			});
			await page.addInitScript((mode) => {
				document.addEventListener("DOMContentLoaded", () => {
					document.documentElement.classList.toggle("dark", mode === "dark");
				});
			}, theme);
			await page.goto(
				`${server.origin}/browser-tests/cli-login.html?port=42123&state=fixture`,
			);
			await page
				.getByRole("button", { name: "Choose organizations", exact: true })
				.click();
			await page.setViewportSize({ width, height: 900 });
			const edit = page.getByRole("button", {
				name: "Edit permissions",
				exact: true,
			});
			const review = page.getByRole("button", { name: /^Review access for/ });
			for (const count of [0, 1, 2]) {
				if (count > 0)
					await page
						.getByRole("checkbox")
						.nth(count - 1)
						.check();
				assert.equal(await review.isEnabled(), count > 0);
				assert.equal(
					await review.textContent(),
					`Review access for ${count} ${count === 1 ? "organization" : "organizations"}`,
				);
				const boxes = await Promise.all([
					edit.boundingBox(),
					review.boundingBox(),
				]);
				const [editBox, reviewBox] = boxes;
				assert(editBox && reviewBox);
				for (const box of [editBox, reviewBox]) {
					assert(
						box.x >= 0 && box.x + box.width <= width,
						`footer action fits ${width}px`,
					);
					if (width < 640) assert(box.height >= 44);
				}
				for (const action of [edit, review]) {
					assert(
						await action.evaluate(
							(node) =>
								node.scrollWidth <= node.clientWidth &&
								node.scrollHeight <= node.clientHeight,
						),
					);
				}
				if (width < 640) {
					assert(
						reviewBox.y >= editBox.y + editBox.height,
						"phone actions stack",
					);
				} else {
					assert.equal(editBox.y, reviewBox.y);
				}
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
				);
			}
			await edit.click();
			await page.setViewportSize({ width, height: 3000 });
			await page
				.getByRole("button", { name: "Choose organizations", exact: true })
				.click();
			assert.equal(
				await review.textContent(),
				"Review access for 2 organizations",
			);
			await page.setViewportSize({ width, height: 900 });
			await page.screenshot({
				path: `/tmp/n70-cli-${width}-${theme}.png`,
				fullPage: true,
			});
			console.log(`PASS CLI footer ${width}px ${theme}`);
			await page.close();
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(`6 cases in ${((performance.now() - started) / 1000).toFixed(1)}s`);
