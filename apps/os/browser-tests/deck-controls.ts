import type { Page } from "playwright";

export async function openExamples(page: Page) {
	await page.locator(".fd-app-toolbar").waitFor();
	await page.getByRole("button", { name: "Try examples", exact: true }).click();
}

/** Wait for font metrics, finite animations, and the resulting layout frames. */
export async function settleAnimations(page: Page, selector?: string) {
	await page.evaluate(async (rootSelector) => {
		await document.fonts.ready;
		const root = rootSelector ? document.querySelector(rootSelector) : document;
		if (!root) throw new Error(`settleAnimations: no ${rootSelector}`);
		const animations =
			root === document
				? document.getAnimations()
				: (root as Element).getAnimations({ subtree: true });
		await Promise.all(
			animations
				.filter((animation) =>
					Number.isFinite(animation.effect?.getComputedTiming().endTime),
				)
				.map((animation) => animation.finished.catch(() => {})),
		);
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		);
	}, selector ?? null);
}
