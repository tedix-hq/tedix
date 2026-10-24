import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/browser-tests/slides-gadget.html");
const browser = await chromium.launch();
const evidence = process.env.TEDIX_SCREENSHOT_DIR;
if (evidence) await mkdir(evidence, { recursive: true });

async function fitsViewport(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
		`${label}: no sideways page scroll`,
	);
}

async function slideBox(page: Page, selector: string) {
	const box = await page.locator(selector).first().boundingBox();
	assert(box, `${selector} is rendered`);
	assert(box.width > 0 && box.height > 0, `${selector} has a size`);
	assert(
		Math.abs(box.width / box.height - 16 / 9) < 0.02,
		`${selector} keeps 16:9`,
	);
	return box;
}

try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}px ${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: width < 640 ? 812 : 820 },
				colorScheme: theme,
				hasTouch: width < 640,
				reducedMotion: "reduce",
			});
			await page.goto(
				`${server.origin}/browser-tests/slides-gadget.html?theme=${theme}`,
			);

			// View mode: the slide on its desk with the control pill under it.
			const controls = page.getByRole("group", { name: "Slide controls" });
			await controls.waitFor();
			const canvas = await slideBox(page, ".deck-read-canvas");
			const pill = (await controls.boundingBox())!;
			assert(pill.y >= canvas.y + canvas.height, `${label}: pill under slide`);
			assert(
				Math.abs(pill.x + pill.width / 2 - (canvas.x + canvas.width / 2)) < 2,
				`${label}: pill centred on the slide`,
			);
			await fitsViewport(page, `${label} view`);
			const status = controls.getByRole("status");
			// Read as a screen reader hears it: "Slide 2 of 3".
			const position = async () =>
				((await status.textContent()) ?? "")
					.replace("/", "")
					.replace(/\s+/g, " ")
					.replace(/^Slide /, "")
					.trim();
			assert.equal(await position(), "1 of 3");
			assert(
				await controls
					.getByRole("button", { name: "Previous slide" })
					.isDisabled(),
				`${label}: previous disabled on the first slide`,
			);
			await controls.getByRole("button", { name: "Next slide" }).click();
			assert.equal(await position(), "2 of 3");
			// Focus stays on Next; the arrow keys still turn the page from it.
			await page.keyboard.press("ArrowRight");
			assert.equal(await position(), "3 of 3");
			await page.keyboard.press("Home");
			assert.equal(await position(), "1 of 3");
			if (width < 640) {
				// A leftward swipe on the slide goes forward.
				const stage = page.locator(".deck-read-stage");
				const box = (await stage.boundingBox())!;
				const y = box.y + box.height / 2;
				await stage.dispatchEvent("pointerdown", {
					pointerType: "touch",
					pointerId: 7,
					clientX: box.x + box.width - 20,
					clientY: y,
				});
				await stage.dispatchEvent("pointerup", {
					pointerType: "touch",
					pointerId: 7,
					clientX: box.x + 20,
					clientY: y,
				});
				assert.equal(await position(), "2 of 3", `${label}: swipe`);
				await page.keyboard.press("Home");
			}
			if (evidence)
				await page.screenshot({
					path: `${evidence}/view-${width}-${theme}.png`,
				});

			// Present mode opens from the pill and leaves on Escape.
			await controls.getByRole("button", { name: "Present" }).click();
			const presenter = page.getByRole("dialog", { name: "Presentation mode" });
			await presenter.waitFor();
			assert.equal(
				await presenter
					.getByRole("progressbar", { name: "Presentation progress" })
					.getAttribute("aria-valuenow"),
				"1",
			);
			await page.keyboard.press("ArrowRight");
			assert.equal(
				await presenter.getByRole("progressbar").getAttribute("aria-valuenow"),
				"2",
			);
			await page.keyboard.press("Escape");
			await presenter.waitFor({ state: "detached" });

			// Edit mode: the pill's Edit opens the editor.
			await controls.getByRole("button", { name: "Edit slides" }).click();
			const editor = page.locator('[data-editor="presentation-canvas"]');
			await editor.waitFor();
			await slideBox(page, ".slides-editor-stage .slides-editor-canvas");
			const rail = page.locator(".slides-editor-thumbnails");
			assert(
				await rail.getByRole("button", { name: "Add slide" }).isVisible(),
				`${label}: Add slide sits in the rail`,
			);
			assert.equal(
				await rail.locator(".slide-list-number").first().innerText(),
				"01",
			);
			await fitsViewport(page, `${label} edit`);

			// Add slide offers every layout with a description.
			await rail.getByRole("button", { name: "New slide template" }).click();
			const layouts = page.locator("[data-slide-layout]");
			await layouts.first().waitFor();
			assert.equal(await layouts.count(), 5);
			assert.match(
				await layouts.nth(2).innerText(),
				/Two columns\s+Side-by-side comparison/,
			);
			await layouts.nth(2).click();
			assert.equal(
				await rail.locator("[data-slide-row]").count(),
				4,
				`${label}: a two-column slide was added`,
			);

			// With nothing selected, the inspector leads with the component
			// palette and says how to select a block.
			await page.getByRole("button", { name: "Inspector" }).click();
			await page
				.locator(".slides-editor-stage")
				.click({ position: { x: 4, y: 4 } });
			const inspector = page.locator(".slides-editor-inspector");
			const search = inspector.getByLabel("Add component", { exact: true });
			await search.waitFor();
			assert(
				await inspector.getByText("Nothing selected").isVisible(),
				`${label}: empty selection state`,
			);
			await search.fill("bullet");
			const rows = inspector.locator("[data-palette-component]");
			assert.equal(await rows.count(), 1);
			const before = await page
				.locator(".slides-editor-stage [data-slide-element]")
				.count();
			await rows.first().click();
			assert.equal(
				await page.locator(".slides-editor-stage [data-slide-element]").count(),
				before + 1,
				`${label}: palette inserts the element`,
			);
			assert(
				await inspector
					.locator("[data-inspector-element='bullet']")
					.isVisible(),
				`${label}: the new element is selected and inspected`,
			);
			await fitsViewport(page, `${label} inspector`);
			if (evidence)
				await page.screenshot({
					path: `${evidence}/edit-${width}-${theme}.png`,
				});
			console.log(`PASS slides gadget ${label}`);
			await page.close();
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
