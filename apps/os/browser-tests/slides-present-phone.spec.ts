import assert from "node:assert/strict";
import { startEditorTabs } from "./doc-editor-tabs";

// On a phone held upright, Present shows only the slide and its controls: the
// page header, tabs and bottom bar are gone. System Back and the editor's
// own Exit both return to the editor on the same page.
const slide = (id: string, text: string) => ({
	id,
	name: id,
	layout: "blank",
	background: "#ffffff",
	elements: [
		{
			id: `${id}-title`,
			type: "title",
			x: 80,
			y: 80,
			width: 900,
			height: 90,
			text,
			style: { fontSize: 46, fontFamily: "Georgia", color: "#123456" },
		},
	],
});
const shots = process.env.SLIDES_PRESENT_SHOTS;
for (const phone of [
	{ width: 375, height: 812 },
	{ width: 390, height: 844 },
]) {
	const tabs = await startEditorTabs({
		kind: "presentation",
		ready: ".slides-stage .slides-element",
		phone,
		content: {
			kind: "presentation",
			slides: [],
			deck: {
				width: 1200,
				height: 675,
				activeSlideId: "one",
				slides: [slide("one", "First slide"), slide("two", "Second slide")],
			},
		},
	});
	try {
		const { page, frame } = await tabs.open();
		const label = `${phone.width}x${phone.height}`;
		const url = page.url();
		const shell = page.locator("[data-app-runtime-frame]").first();
		const presenter = frame.locator("#presenter");
		// Every point of the screen belongs to the app's frame, nothing else.
		const coversScreen = () =>
			page.evaluate(({ width, height }) => {
				const root = document.querySelector("[data-app-runtime-frame]")!;
				const box = root.getBoundingClientRect();
				const points = [
					[2, 2],
					[width / 2, 2],
					[width - 2, height / 2],
					[width / 2, height - 2],
					[2, height - 2],
				];
				return {
					box: [box.x, box.y, box.width, box.height].map(Math.round),
					covered: points.every(([x, y]) =>
						root.contains(document.elementFromPoint(x!, y!)),
					),
				};
			}, phone);
		assert.equal((await coversScreen()).covered, false, `${label}: editor`);
		if (shots) await page.screenshot({ path: `${shots}/${label}-editor.png` });

		await frame.locator("#present").tap();
		await presenter.waitFor();
		await page.waitForFunction(() =>
			document.querySelector("[data-app-runtime-frame][data-presenting]"),
		);
		const shown = await coversScreen();
		assert.deepEqual(
			shown,
			{ box: [0, 0, phone.width, phone.height], covered: true },
			`${label}: the show covers the screen`,
		);
		const stage = await frame.locator(".slides-present-stage").boundingBox();
		assert.equal(
			Math.round(stage!.width),
			phone.width,
			`${label}: slide width`,
		);
		await frame.locator("#next").tap();
		assert.equal(await frame.locator("#position").textContent(), "2 / 2");
		if (shots) await page.screenshot({ path: `${shots}/${label}-present.png` });

		// System Back ends the show and stays in the editor.
		await page.goBack();
		await presenter.waitFor({ state: "hidden" });
		await page.waitForFunction(
			() =>
				!document.querySelector("[data-app-runtime-frame][data-presenting]"),
		);
		assert.equal(page.url(), url, `${label}: Back stays on the editor`);
		assert.equal((await coversScreen()).covered, false);
		await frame.locator(".slides-stage .slides-element").first().waitFor();
		if (shots) await page.screenshot({ path: `${shots}/${label}-back.png` });

		// Exit in the editor does the same and leaves no extra Back step.
		await frame.locator("#present").tap();
		await page.waitForFunction(() =>
			document.querySelector("[data-app-runtime-frame][data-presenting]"),
		);
		await frame.locator("#exit").tap();
		await page.waitForFunction(
			() =>
				!document.querySelector("[data-app-runtime-frame][data-presenting]"),
		);
		assert.equal(await presenter.isHidden(), true);
		await page.waitForFunction(() => !history.state?.tedixPresent);
		assert.equal(page.url(), url);
		assert.equal(await shell.getAttribute("data-presenting"), null);
		console.log(
			`Slides present on a ${label} phone: full screen, Back and Exit return`,
		);
	} finally {
		await tabs.stop();
	}
}
