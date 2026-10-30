import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";
import { initial } from "./slides-gadget-content";
import { renderOsOutputHtml } from "../../api/src/lib/os-output-html";
import { buildOsOutputOfficeExport } from "../../api/src/lib/os-output-office";
import { unzipSync, strFromU8 } from "fflate";

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
	const pptx = await buildOsOutputOfficeExport(
		"pptx",
		initial,
		"Typography parity",
	);
	const parts = unzipSync(pptx);
	const slideXml = strFromU8(parts["ppt/slides/slide1.xml"]!);
	const themeXml = strFromU8(parts["ppt/theme/theme1.xml"]!);
	assert.match(themeXml, /<a:majorFont><a:latin typeface="Space Grotesk"/);
	assert.match(themeXml, /<a:minorFont><a:latin typeface="DM Sans"/);
	assert.match(
		slideXml,
		/spc="-240"[^>]*>.*?<a:latin typeface="Space Grotesk Light"/,
	);
	assert.match(
		slideXml,
		/spc="112"[^>]*>.*?<a:latin typeface="DM Mono Medium"/,
	);
	assert.match(slideXml, /<a:latin typeface="DM Sans"/);
	const printPage = await browser.newPage({
		viewport: { width: 1200, height: 675 },
	});
	await printPage.setContent(
		renderOsOutputHtml(
			{ kind: "presentation", title: "Typography parity" },
			{ content: initial, revision: 1, createdAt: "2026-01-01T00:00:00Z" },
		),
	);
	const printHeading = printPage
		.locator(".canvas-slide")
		.first()
		.locator(":scope > div")
		.nth(1);
	const printStyle = await printHeading.evaluate((node) => {
		const css = getComputedStyle(node);
		return {
			family: css.fontFamily,
			weight: css.fontWeight,
			spacing: css.letterSpacing,
		};
	});
	assert.match(printStyle.family, /Space Grotesk/);
	assert.equal(printStyle.weight, "300");
	assert.equal(printStyle.spacing, "-3px");
	await printPage.evaluate(async () => {
		document.body.getBoundingClientRect();
		await document.fonts.ready;
		if ([...document.fonts].some((font) => font.status === "error"))
			throw new Error("Export font failed");
	});
	const pdf = await printPage.pdf({
		printBackground: true,
		preferCSSPageSize: true,
	});
	assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
	for (const font of ["SpaceGrotesk-Light", "DMSans", "DMMono-Medium"])
		assert(pdf.includes(Buffer.from(font)), `PDF embeds ${font}`);
	if (evidence) {
		await writeFile(`${evidence}/themed.pptx`, pptx);
		await writeFile(`${evidence}/themed.pdf`, pdf);
		await printPage.screenshot({ path: `${evidence}/print.png` });
	}
	await printPage.close();
	console.log("PASS same themed deck PDF and PPTX typography");
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
			const typography = await page
				.locator('.deck-read-canvas [data-slide-element="title"]')
				.evaluate((node) => {
					const css = getComputedStyle(node);
					return {
						family: css.fontFamily,
						weight: css.fontWeight,
						spacing: parseFloat(css.letterSpacing),
						width: node.closest(".deck-read-canvas")!.getBoundingClientRect()
							.width,
					};
				});
			assert.match(typography.family, /Space Grotesk/);
			assert.equal(typography.weight, "300");
			assert(
				Math.abs(typography.spacing - (-3 * typography.width) / 1200) < 0.02,
				`${label}: scaled negative letter spacing`,
			);
			assert.match(
				await page
					.locator('.deck-read-canvas [data-slide-element="footer"]')
					.evaluate((node) => getComputedStyle(node).fontFamily),
				/DM Sans/,
			);
			assert.match(
				await page
					.locator('.deck-read-canvas [data-slide-element="eyebrow"]')
					.evaluate((node) => getComputedStyle(node).fontFamily),
				/DM Mono/,
			);

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

			// A keyboard user reaches an element and moves it with the arrows,
			// instead of the arrows changing slides.
			const element = page
				.locator(".slides-editor-stage [data-slide-element]")
				.first();
			await element.focus();
			// Measure once the stage has stopped resizing at this width.
			let startBox = (await element.boundingBox())!;
			for (let settled = 0; settled < 3;) {
				await page.waitForTimeout(50);
				const box = (await element.boundingBox())!;
				settled =
					box.x === startBox.x && box.width === startBox.width
						? settled + 1
						: 0;
				startBox = box;
			}
			assert.equal(
				await element.getAttribute("data-selected"),
				"true",
				`${label}: keyboard focus selects the element`,
			);
			const handle = await element.elementHandle();
			const settlesAt = (compare: "right" | "start") =>
				page.waitForFunction(
					([node, x, mode]) => {
						const left = (node as HTMLElement).getBoundingClientRect().x;
						return mode === "right" ? left > x + 0.5 : Math.abs(left - x) < 0.5;
					},
					[handle, startBox.x, compare] as const,
					{ timeout: 5_000 },
				);
			await page.keyboard.press("Shift+ArrowRight");
			await settlesAt("right");
			assert.equal(
				(await element.boundingBox())!.y,
				startBox.y,
				`${label}: Shift+Right moves the focused element only sideways`,
			);
			await page.keyboard.press("Shift+ArrowLeft");
			await settlesAt("start");
			assert.equal(
				await rail
					.locator('[aria-current="true"] .slide-list-number')
					.first()
					.innerText(),
				"01",
				`${label}: arrows did not change slides`,
			);
			await page.keyboard.press("Escape");

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
			await inspector
				.getByRole("combobox", { name: "Deck heading font", exact: true })
				.click();
			await page.getByRole("option", { name: "Inter", exact: true }).click();
			assert.match(
				await page
					.locator('.slides-editor-stage [data-element="title"]')
					.first()
					.evaluate((node) => getComputedStyle(node).fontFamily),
				/Inter/,
			);
			await inspector
				.getByRole("combobox", { name: "Deck heading font", exact: true })
				.click();
			await page
				.getByRole("option", { name: "Space Grotesk", exact: true })
				.click();
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
