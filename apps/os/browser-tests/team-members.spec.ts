import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";

// The Team › Members mobile lane at a 390px phone viewport: rows carry the
// fixture's longest identities, so any un-clipped identity or fixed-width
// control shows up as horizontal overflow here.
const fixturePath = "/browser-tests/team-members.html";
const server = await startFixtureServer(fixturePath);
const fixture = `${server.origin}${fixturePath}`;

let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		const page = await browser.newPage({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
			colorScheme: theme,
		});
		await page.goto(`${fixture}?theme=${theme}`);
		const list = page.locator('ul[aria-label="Organization members"]');
		await list.locator("li").first().waitFor();
		const rows = list.locator("li");
		assert.equal(await rows.count(), 6, `${theme}: all fixture rows render`);

		const overflow = await page.evaluate(() => ({
			document: document.documentElement.scrollWidth - innerWidth,
			body: document.body.scrollWidth - innerWidth,
		}));
		assert(
			overflow.document <= 0 && overflow.body <= 0,
			`${theme}: no horizontal overflow at 390px ${JSON.stringify(overflow)}`,
		);

		const geometry = await page.evaluate(() => {
			const inside = (rect: DOMRect, left: number, right: number) =>
				rect.left >= left - 0.5 && rect.right <= right + 0.5;
			return [
				...document.querySelectorAll<HTMLElement>(
					'ul[aria-label="Organization members"] > li',
				),
			].map((row) => {
				const rowRect = row.getBoundingClientRect();
				const cells = [
					...row.querySelectorAll<HTMLElement>(
						'[data-slot="text"], [data-slot="badge"], button, [role="combobox"]',
					),
				];
				return {
					rowOverflow: row.scrollWidth - row.clientWidth,
					rowInViewport: inside(rowRect, 0, innerWidth),
					cellsInRow: cells.every((cell) =>
						inside(cell.getBoundingClientRect(), rowRect.left, rowRect.right),
					),
					textEllipsizes: cells
						.filter((cell) => cell.dataset.slot === "text")
						.every(
							(cell) => getComputedStyle(cell).textOverflow === "ellipsis",
						),
					clipped: cells
						.filter((cell) => cell.dataset.slot === "text")
						.some((cell) => cell.scrollWidth > cell.clientWidth),
				};
			});
		});
		geometry.forEach((row, index) => {
			const label = `${theme} row ${index}`;
			assert(row.rowInViewport, `${label}: row stays inside the viewport`);
			assert(
				row.rowOverflow <= 0,
				`${label}: row content does not overflow ${JSON.stringify(row)}`,
			);
			assert(row.cellsInRow, `${label}: cells stay inside the row`);
			assert(row.textEllipsizes, `${label}: identity text can ellipsize`);
			// Rows 0-4 carry the fixture's long identities; the plain owner row
			// fits untruncated.
			if (index < 5)
				assert(row.clipped, `${label}: long identity ellipsizes in place`);
		});

		// Every row still offers its controls at phone width: the actions menu
		// on all six rows and the role select on the manageable ones (the self
		// and owner rows show a badge instead).
		const actions = list.getByRole("button", { name: /^Actions for / });
		assert.equal(await actions.count(), 6, `${theme}: every row keeps actions`);
		const roleControls = list.locator('[aria-label^="Role for "]');
		assert.equal(
			await roleControls.count(),
			4,
			`${theme}: manageable rows keep the role control`,
		);
		await page.close();
	}
	console.log(
		"PASS: members rows keep long identities and controls inside a 390px viewport, light and dark",
	);
} finally {
	await browser?.close();
	await server.stop();
}
