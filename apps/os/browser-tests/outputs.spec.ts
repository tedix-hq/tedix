import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { startFixtureServer } from "./fixture-server";
import { webkit, type Browser, type Locator, type Page } from "playwright";

async function checkCardKeyboard(page: Page, card: Locator) {
	assert.equal(await card.getAttribute("role"), null);
	assert.equal(await card.getAttribute("tabindex"), null);
	assert.equal(
		await card.locator("button button, [role=button] button").count(),
		0,
	);
	const open = card.getByRole("button", { name: /^Open / });
	const actions = card.getByRole("button", { name: /^More actions for / });
	assert.equal(
		await card.getByRole("button").count(),
		2,
		"one action row: Open, then ⋯",
	);
	assert.equal((await open.innerText()).trim(), "Open");
	assert.equal(
		(await actions.innerText()).trim(),
		"",
		"⋯ is an icon-only button",
	);
	const cardBox = (await card.boundingBox())!;
	const boxes = [];
	for (const [control, label] of [
		[open, "Open"],
		[actions, "More actions"],
	] as const) {
		const box = (await control.boundingBox())!;
		assert(
			box.x >= cardBox.x + 2 &&
				box.x + box.width <= cardBox.x + cardBox.width - 2,
			`${label} and its focus ring stay inside the card content`,
		);
		if (page.viewportSize()!.width < 640)
			assert(
				box.height >= 44 && box.width >= 44,
				`${label} has a touch target`,
			);
		boxes.push(box);
	}
	assert(
		boxes.every(
			(box) =>
				Math.abs(
					box.y + box.height / 2 - (boxes[0]!.y + boxes[0]!.height / 2),
				) < 1,
		),
		"actions share one row",
	);
	assert(
		boxes[0]!.x + boxes[0]!.width <= boxes[1]!.x,
		"actions do not overlap",
	);
	assert(
		await card.evaluate((el) => el.scrollWidth <= el.clientWidth),
		"card has no horizontal overflow",
	);
	const libraryUrl = page.url();
	const titleBox = (await card.locator("strong").boundingBox())!;
	await card.click({
		position: {
			x: titleBox.x + titleBox.width / 2 - cardBox.x,
			y: titleBox.y + titleBox.height / 2 - cardBox.y,
		},
	});
	await page.waitForURL((url) => url.href !== libraryUrl);
	await page.goBack();
	await open.waitFor();
	// A pointer click on ⋯ opens the menu, and Share… opens the dialog: the
	// old Share button sat under Open's card-wide layer and opened the output.
	await actions.click();
	await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
	await page.getByRole("heading", { name: "Share this file" }).waitFor();
	assert.equal(page.url(), libraryUrl, "Share does not open the output");
	await page.keyboard.press("Escape");
	await page.getByRole("dialog").waitFor({ state: "hidden" });
	for (const key of ["Enter", "Space"]) {
		await open.focus();
		await page.keyboard.press("Tab");
		await page.keyboard.press("Shift+Tab");
		const focus = await open.evaluate((el) => {
			const css = getComputedStyle(el);
			const width = Number.parseFloat(css.outlineWidth);
			const reach = Math.max(0, width + Number.parseFloat(css.outlineOffset));
			const rect = el.getBoundingClientRect();
			const parent = el.parentElement!;
			const clip = parent.getBoundingClientRect();
			const left = clip.left + parent.clientLeft;
			const top = clip.top + parent.clientTop;
			return {
				style: css.outlineStyle,
				width,
				overshoot: Math.max(
					left - (rect.left - reach),
					rect.right + reach - (left + parent.clientWidth),
					top - (rect.top - reach),
					rect.bottom + reach - (top + parent.clientHeight),
				),
			};
		});
		assert.equal(focus.style, "solid");
		assert(focus.width >= 2, "Open has a visible focus outline");
		assert(focus.overshoot <= 0.5, "Open focus stays inside the card");
		await page.keyboard.press("Tab");
		assert(
			await actions.evaluate((el) => el === document.activeElement),
			"Tab moves from Open to ⋯",
		);
		await actions.press(key);
		await page
			.getByRole("menuitem", { name: "Open standalone", exact: true })
			.waitFor();
		assert.equal(page.url(), libraryUrl, "⋯ does not open the output");
		await page.keyboard.press("Escape");
		await open.press(key);
		await page.waitForURL((url) => url.href !== libraryUrl);
		await page.goBack();
		await open.waitFor();
	}
}

/** Archive… from ⋯, find it under Archived, Restore it, and see it back. */
async function checkArchiveAndRestore(page: Page, card: Locator) {
	const title = (await card.locator("strong").innerText()).trim();
	const library = page.locator(".outputs-library");
	const items = library.locator(".output-library-items > li");
	const named = (scope: Locator) =>
		scope.filter({ has: page.locator("strong", { hasText: title }) });
	await card.getByRole("button", { name: /^More actions for / }).click();
	await page.getByRole("menuitem", { name: "Archive…", exact: true }).click();
	const confirm = page.getByRole("alertdialog").or(page.getByRole("dialog"));
	await confirm.getByRole("button", { name: "Archive", exact: true }).click();
	await confirm.waitFor({ state: "hidden" });
	await named(items).waitFor({ state: "detached" });
	const tabs = library.getByRole("tablist", { name: "Filter by type" });
	await tabs.getByRole("tab", { name: /^Archived/ }).click();
	const archived = named(items).first();
	await archived.waitFor();
	assert.equal(
		await archived.getByRole("button", { name: /^Open / }).count(),
		1,
		"an archived output still opens",
	);
	await archived.getByRole("button", { name: /^More actions for / }).click();
	assert.equal(
		await page.getByRole("menuitem", { name: "Share…", exact: true }).count(),
		0,
		"an archived output is not shared",
	);
	await page.getByRole("menuitem", { name: "Restore", exact: true }).click();
	await named(items).waitFor({ state: "detached" });
	await tabs.getByRole("tab", { name: /^All/ }).click();
	await named(items).first().waitFor();
}

const server = await startFixtureServer("/outputs");
const { origin } = server;
const evidenceDir = process.env.OUTPUTS_EVIDENCE_DIR;
let browser: Browser | undefined;
try {
	if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
	browser = await webkit.launch();
	for (const [width, height] of [
		[375, 667],
		[390, 844],
		[1280, 900],
	] as const) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
				hasTouch: width < 640,
			});
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.goto(`${origin}/outputs`);
			const library = page.locator(".outputs-library");
			const card = library
				.locator(".output-grid-card:not([data-workspace-app])")
				.first();
			await card.waitFor();
			const title = card.locator("strong");
			assert.equal(
				await title.evaluate((el) => getComputedStyle(el).webkitLineClamp),
				"none",
				"title is never clamped",
			);
			const provenance = card
				.locator(".output-card-footer > span > span")
				.filter({ hasText: /Shared by|Created by/ })
				.last();
			assert.notEqual(
				await provenance.evaluate((el) => getComputedStyle(el).textOverflow),
				"ellipsis",
				"provenance stays readable",
			);
			assert(
				await card.locator("time").isVisible(),
				"updated time is visible in grid",
			);
			const search = library.getByRole("searchbox", { name: "Search outputs" });
			assert(await search.isVisible(), "output search is visible");
			const scope = library.getByRole("button", {
				name: width < 640 ? "All sharing" : "Yours and shared",
				exact: true,
			});
			if (width < 640) {
				assert.equal(
					Math.round(
						(await library
							.locator('[data-kumo-component="SearchInput"]')
							.boundingBox())!.y,
					),
					Math.round((await scope.boundingBox())!.y),
					"search and sharing use one row",
				);
			}
			await page.keyboard.press("Tab");
			await card.locator(".output-card-open").focus();
			assert.equal(
				await card.evaluate((el) => getComputedStyle(el).borderTopWidth),
				"1px",
			);
			assert.equal(
				await library
					.locator(".output-library-items")
					.evaluate((el) => getComputedStyle(el).paddingTop),
				"2px",
				"list leaves room for focus",
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-grid-${width}-${theme}.png`,
				});
			await checkCardKeyboard(page, card);
			await checkArchiveAndRestore(page, card);
			await library
				.getByRole("button", { name: "List view", exact: true })
				.click();
			const row = library
				.locator(".output-list-row:not([data-workspace-app])")
				.first();
			await row.waitFor();
			assert.equal(
				await row
					.locator("strong")
					.evaluate((el) => getComputedStyle(el).textOverflow),
				"clip",
				"list titles wrap",
			);
			if (width < 640)
				assert(
					await row.locator("time").first().isVisible(),
					"phone list shows updated time",
				);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-list-${width}-${theme}.png`,
				});
			await checkCardKeyboard(page, row);
			await row.getByRole("button", { name: /^More actions for/ }).click();
			await page
				.getByRole("menuitem", { name: "Open standalone", exact: true })
				.click();
			const actions = page.locator(".output-detail-actions");
			await actions.waitFor();
			const edit = actions.getByRole("button", { name: "Edit", exact: true });
			const share = actions.getByRole("button", { name: "Share", exact: true });
			const overflow = actions.getByRole("button", {
				name: "Output actions",
				exact: true,
			});
			const editBox = (await edit.boundingBox())!;
			const shareBox = (await share.boundingBox())!;
			assert.equal(editBox.y, shareBox.y, "primary and secondary align");
			assert.equal(editBox.height, shareBox.height, "action heights match");
			assert(
				editBox.x >= 0 && editBox.x + editBox.width <= width,
				"Edit is fully inside the viewport",
			);
			if (width < 640) {
				assert.equal(
					await actions.getByRole("button").filter({ visible: true }).count(),
					3,
					"phone has Edit, Share and overflow",
				);
				assert.equal(
					(await overflow.boundingBox())!.y,
					editBox.y,
					"overflow stays on the same row",
				);
			}
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-detail-${width}-${theme}.png`,
				});
			await overflow.click();
			await page
				.getByRole("menuitem", { name: "Document (.docx)", exact: true })
				.waitFor();
			if (width < 640)
				await page
					.getByRole("menuitem", { name: "Open in workspace", exact: true })
					.waitFor();
			await page.keyboard.press("Escape");
			await share.click();
			await page.getByRole("heading", { name: "Share this file" }).waitFor();
			// An owner edits a link's note in place; its permanent address stays.
			const shareDialog = page.getByRole("dialog");
			const current = shareDialog.locator("[data-share-link-current]");
			const create = shareDialog.getByRole("button", {
				name: "Create link",
				exact: true,
			});
			await current.or(create).first().waitFor();
			if ((await current.count()) === 0) await create.click();
			const address = current.locator("[data-share-url]");
			await address.waitFor();
			const url = (await address.textContent()) ?? "";
			// The id is the address; a readable title suffix may follow it.
			assert.match(
				url,
				/\/s\/[A-Za-z0-9]{22}(\/[a-z0-9-]+)?$/,
				"the link is permanent",
			);
			await shareDialog.getByRole("button", { name: "Link options" }).click();
			await page.getByRole("menuitem", { name: "Edit settings" }).click();
			const linkNote = `Board pack ${width} ${theme}`;
			await shareDialog.getByLabel("Share note").fill(linkNote);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"link settings fit without horizontal overflow",
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-link-settings-${width}-${theme}.png`,
				});
			await shareDialog
				.getByRole("button", { name: "Save", exact: true })
				.click();
			await shareDialog.getByText(linkNote, { exact: false }).waitFor();
			assert.equal(
				await address.textContent(),
				url,
				"editing settings keeps the same address",
			);
			await page.keyboard.press("Escape");
			await page.getByRole("dialog").waitFor({ state: "hidden" });
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"no horizontal document overflow",
			);
			assert(
				await page
					.locator('[data-slot="page"]')
					.evaluate((el) => el.scrollWidth <= el.clientWidth),
				"no clipped page content",
			);

			await edit.click();
			const editorTitle = page.locator(".output-workshop-identity h1");
			await page.locator('[data-editor="document-rich-text"]').waitFor();
			assert(
				await editorTitle.evaluate((el) => el.scrollWidth <= el.clientWidth),
				"editor title stays readable without horizontal clipping",
			);
			const editorActions = page.locator(".output-workshop-actions");
			if (width < 640) {
				const titleBox = (await editorTitle.boundingBox())!;
				const actionsBox = (await editorActions.boundingBox())!;
				assert(
					titleBox.y + titleBox.height <= actionsBox.y,
					"phone editor gives the title its own row",
				);
				const saveBox = (await page
					.getByRole("button", { name: "Save", exact: true })
					.boundingBox())!;
				const cancelBox = (await page
					.getByRole("button", { name: "Cancel", exact: true })
					.boundingBox())!;
				assert(
					saveBox.height >= 44 && cancelBox.height >= 44,
					"phone save and cancel have touch-sized targets",
				);
				assert(
					Math.abs(saveBox.width - cancelBox.width) <= 1,
					"phone save and cancel share the footer width",
				);
			}
			assert(
				await page
					.getByRole("button", { name: "Save", exact: true })
					.isVisible(),
			);
			if (evidenceDir)
				await page.screenshot({
					path: `${evidenceDir}/after-editor-${width}-${theme}.png`,
				});
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await page.close();
			console.log(`Outputs WebKit passed: ${width}x${height} ${theme}`);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
