import { webkit, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = process.env.FEED_LEAN_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.FEED_LEAN_ORIGIN
	? undefined
	: Bun.spawn(
			[
				"../../node_modules/.bin/vp",
				"dev",
				"--port",
				String(port),
				"--strictPort",
				"--host",
				"127.0.0.1",
			],
			{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
		);
let browser: Browser | undefined;
try {
	for (let i = 0; i < 100; i++) {
		if (server && server.exitCode !== null)
			throw new Error("Feed fixture server exited");
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(200);
	}
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
			const provenance = row.locator('[aria-label="Source provenance"]');
			if (
				(await provenance.getByText(/Submitted by/).count()) !== 1 ||
				(await provenance.locator("a").getAttribute("href")) === null
			)
				throw new Error("Feed lost its source or actor attribution");
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
			if (inlineActions !== (width > 640 ? 2 : 0))
				throw new Error("Feed exposed too many inline actions");
			await row
				.getByRole("button", { name: "More actions", exact: true })
				.click();
			await page
				.getByRole("menuitem", { name: "Comment", exact: true })
				.waitFor();
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: /Handled without you:/ }).click();
			const handled = page.locator(".focus-handled-row .ft-sentence").first();
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
			// Exercise long attachment copy with the same markup as RichPreview.
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
			const preview = row.locator(".fd-preview");
			const readable = await preview.evaluate((node) => ({
				clipped: Array.from(
					node.querySelectorAll(".fd-preview-title, .fd-preview-summary"),
				).some(
					(child) =>
						child.scrollHeight > child.clientHeight + 1 ||
						child.scrollWidth > child.clientWidth + 1,
				),
				inset: getComputedStyle(node).paddingLeft,
			}));
			if (readable.clipped || readable.inset !== "0px")
				throw new Error(
					`Attachment copy clipped or misaligned: ${JSON.stringify(readable)}`,
				);
			await page.close();
			console.log(
				`Feed WebKit ${width}x${height} ${theme}: metadata, focus, overflow, handled text and previews passed`,
			);
		}
	}
} finally {
	await browser?.close();
	if (server) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await server.exited;
	}
}
