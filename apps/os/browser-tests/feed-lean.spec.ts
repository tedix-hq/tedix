import { startFixtureServer } from "./fixture-server";
import { webkit, type Browser } from "playwright";

const server = await startFixtureServer();
const { origin } = server;
let browser: Browser | undefined;
try {
	browser = await webkit.launch();
	for (const [width, height] of [
		[375, 667],
		[390, 844],
		[1280, 900],
	]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height },
				colorScheme: theme,
			});
			await page.goto(
				`${origin}/browser-tests/feed-deck-polish.html?shell&surface=feed&theme=${theme}`,
			);
			const row = page.locator("[data-focus-row]").first();
			await row.waitFor();
			await page.evaluate(async () => {
				await document.fonts.ready;
				await Promise.all(
					document
						.getAnimations()
						.map((animation) => animation.finished.catch(() => {})),
				);
			});
			const metadata = await row.locator(".ft-byline").evaluate((node) => ({
				size: parseFloat(getComputedStyle(node.firstElementChild!).fontSize),
				clipped: Array.from(node.children).some(
					(child) => child.scrollWidth > child.clientWidth + 1,
				),
			}));
			if (metadata.size > 13 || metadata.clipped)
				throw new Error(`Unreadable byline: ${JSON.stringify(metadata)}`);
			const source = row.locator(".ft-post-link");
			const before = await row.boundingBox();
			await source.focus();
			const focus = await row.evaluate((node) => ({
				shadow: getComputedStyle(node).boxShadow,
				outline: getComputedStyle(node).outlineStyle,
				padding: parseFloat(getComputedStyle(node.parentElement!).paddingLeft),
				border: getComputedStyle(node.parentElement!).borderTopWidth,
			}));
			const after = await row.boundingBox();
			if (
				focus.shadow === "none" ||
				focus.outline !== "none" ||
				focus.padding < 2 ||
				focus.border !== "1px" ||
				JSON.stringify(before) !== JSON.stringify(after)
			)
				throw new Error(
					`Feed focus changed geometry or lost its border: ${JSON.stringify(focus)}`,
				);
			// Source attribution stays one tap away, behind More.
			await row.getByRole("button", { name: "More", exact: true }).click();
			const provenance = row
				.getByRole("region", { name: "Receipt" })
				.locator('[aria-label="Source provenance"]');
			if (
				(await provenance.getByText(/Submitted by/).count()) !== 1 ||
				(await provenance.locator("a").getAttribute("href")) === null
			)
				throw new Error("Feed lost its source or actor attribution");
			await row.getByRole("button", { name: "Less", exact: true }).click();
			const lines = await row
				.locator(".ft-detail")
				.evaluateAll((nodes) =>
					nodes.map((node) => node.getBoundingClientRect().height),
				);
			if (lines.some((height) => height > 24))
				throw new Error(`Activity body exceeds one line: ${lines}`);
			const inlineActions = await row
				.locator(".focus-actions button")
				.evaluateAll(
					(nodes) =>
						nodes.filter(
							(node) =>
								getComputedStyle(node).display !== "none" &&
								node.getBoundingClientRect().width > 0,
						).length,
				);
			if (inlineActions !== (width > 640 ? 3 : 0))
				throw new Error("Feed exposed too many inline actions");
			await row
				.getByRole("button", { name: "More actions", exact: true })
				.click();
			await page
				.getByRole("menuitem", { name: "Comment", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: /Handled without you:/ }).click();
			const handled = page.locator(".focus-handled .ft-sentence").first();
			await handled.evaluate((node) => {
				node.textContent =
					"A completed supplier update with a long explanation that must remain readable on a narrow phone instead of disappearing behind an ellipsis. ".repeat(
						3,
					);
			});
			if (
				await handled.evaluate(
					(node) =>
						node.scrollWidth > node.clientWidth + 1 ||
						node.scrollHeight > node.clientHeight + 1,
				)
			)
				throw new Error("Handled update text is clipped");
			await page.getByRole("button", { name: /Handled without you:/ }).click();
			if (
				await page.evaluate(
					() => document.documentElement.scrollWidth > innerWidth,
				)
			)
				throw new Error(`Feed overflows at ${width}/${theme}`);
			if (process.env.TEDIX_SCREENSHOT_DIR)
				await page.screenshot({
					path: `${process.env.TEDIX_SCREENSHOT_DIR}/after-${width}-${theme}.png`,
				});
			// Long attachment copy stays in a small fixed-height preview.
			await row.locator(".fd-story-body").evaluate((node) => {
				const preview = document.createElement("a");
				preview.className = "fd-preview";
				preview.href = "/work";
				const copy = document.createElement("span");
				copy.className = "fd-preview-copy";
				for (const name of ["title", "summary"]) {
					const text = document.createElement("span");
					text.className = `fd-preview-${name}`;
					text.textContent =
						"A supplier delivery report with complete inspection notes and a very long reference ".repeat(
							6,
						) + "reference_".repeat(30);
					copy.append(text);
				}
				preview.append(copy);
				node.append(preview);
			});
			const preview = row.locator(".fd-preview").last();
			const compact = await preview.evaluate((node) => ({
				height: node.getBoundingClientRect().height,
				overflow: node.scrollWidth > node.clientWidth + 1,
				truncated: Array.from(
					node.querySelectorAll(".fd-preview-title, .fd-preview-summary"),
				).every((child) => getComputedStyle(child).textOverflow === "ellipsis"),
			}));
			if (compact.height > 64 || compact.overflow || !compact.truncated)
				throw new Error(
					`Attachment preview is not compact: ${JSON.stringify(compact)}`,
				);
			await page.close();
			console.log(
				`Activity WebKit ${width}x${height} ${theme}: metadata, one-line body, focus, overflow, handled text and compact previews passed`,
			);
		}
	}
} finally {
	await browser?.close();
	await server.stop();
}
