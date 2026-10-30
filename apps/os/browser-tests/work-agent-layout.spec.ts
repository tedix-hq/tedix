import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const fixture = "/browser-tests/work-agent-layout.html";
const server = await startFixtureServer(fixture);
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"]) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				reducedMotion: "reduce",
			});
			try {
				await page.goto(`${server.origin}${fixture}?theme=${theme}`);
				const details = page.getByRole("button", {
					name: "Result and execution details",
					exact: true,
				});
				await details.waitFor();
				await page.evaluate(() => document.fonts.ready);
				const totalsGap = await page
					.getByLabel("Today’s delegation totals")
					.evaluate((node) => {
						const rows = [...node.children].map((child) =>
							child.getBoundingClientRect(),
						);
						return rows[1].top - rows[0].bottom;
					});
				assert(
					totalsGap >= 3,
					`${label}: totals have a visible row gap (${totalsGap})`,
				);
				const lesson = page.getByText(
					"What we learned: Separate the summary from the detailed result.",
					{ exact: true },
				);
				const summaryGap = await lesson.evaluate(
					(node) =>
						node.getBoundingClientRect().top -
						node.previousElementSibling!.getBoundingClientRect().bottom,
				);
				assert(
					summaryGap >= 7,
					`${label}: lesson sits below usage (${summaryGap})`,
				);
				await details.click();
				const result = page.getByText(
					"Asked: Inspect the agent board at phone and desktop widths.",
					{ exact: true },
				);
				await result.waitFor();
				const rowGaps = await result.evaluate((node) => {
					const rows = [...node.parentElement!.children].map((child) =>
						child.getBoundingClientRect(),
					);
					return rows
						.slice(1)
						.map((row, index) => row.top - rows[index].bottom);
				});
				assert(
					rowGaps.length >= 5 && rowGaps.every((gap) => gap >= 7),
					`${label}: execution rows stay separate (${rowGaps})`,
				);
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					`${label}: no page overflow`,
				);
				await details.click();
				assert.equal(
					await details.getAttribute("aria-expanded"),
					"false",
					`${label}: details close`,
				);
				console.log(`agent board layout ${label}: ok`);
			} finally {
				await page.close();
			}
		}
} finally {
	await browser.close();
	await server.stop();
}
