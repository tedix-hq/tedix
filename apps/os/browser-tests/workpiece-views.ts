import type { Page } from "playwright";

/*
 * The open item's views (App, Code, History, Connections…) are a row of tabs
 * on wide screens and one "View" menu in the item's row on a phone. These
 * helpers drive either form, so a spec can run at every width.
 */

/** The view tabs; hidden on a phone, where the view menu stands in. */
export function workpieceViewTabs(page: Page) {
	return page.getByRole("group", { name: "Active workpiece view" });
}

/** The phone's view menu button, named "View: <the view on screen>". */
export function workpieceViewMenu(page: Page) {
	return page.getByRole("button", { name: /^View: / });
}

/** Wait for either form of the view choice. */
export async function waitForWorkpieceViews(page: Page): Promise<void> {
	await workpieceViewTabs(page).or(workpieceViewMenu(page)).first().waitFor();
}

/** Show a view, from the tabs or from the phone's menu. */
export async function showWorkpieceView(
	page: Page,
	view: string | RegExp,
): Promise<void> {
	await waitForWorkpieceViews(page);
	const exact = typeof view === "string";
	const tabs = workpieceViewTabs(page);
	if (await tabs.isVisible()) {
		await tabs.getByRole("button", { name: view, exact }).click();
		return;
	}
	await workpieceViewMenu(page).click();
	const menu = page.getByRole("menu");
	await menu.getByRole("menuitemradio", { name: view, exact }).click();
	await menu.waitFor({ state: "hidden" });
}

/** The views on offer, in order, as their visible labels. */
export async function workpieceViewNames(page: Page): Promise<string[]> {
	await waitForWorkpieceViews(page);
	const tabs = workpieceViewTabs(page);
	if (await tabs.isVisible())
		return (await tabs.getByRole("button").allInnerTexts()).map(clean);
	await workpieceViewMenu(page).click();
	const menu = page.getByRole("menu");
	await menu.getByRole("menuitemradio").first().waitFor();
	const names = (await menu.getByRole("menuitemradio").allInnerTexts()).map(
		clean,
	);
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });
	return names;
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
