import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
// Parallel worktrees must not share the browser fixture's listener.
const probe = createServer();
await new Promise<void>((resolve, reject) => {
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", resolve);
});
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve, reject) => {
	probe.close((error) => (error ? reject(error) : resolve()));
});
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		port,
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			ready = (await fetch(`${origin}/browser-tests/dialogs.html`)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "Vite must serve the real CSS browser fixture");
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
	]) {
		const page = await browser.newPage({ viewport });
		await page.goto(`${origin}/browser-tests/dialogs.html`);
		await page.getByRole("button", { name: "Get help", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await dialog.waitFor();
		await page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== "running"),
		);
		assert(
			await page
				.getByRole("textbox", { name: "Summary", exact: true })
				.evaluate((el) => el === document.activeElement),
			"Summary receives focus",
		);
		const textarea = page.getByRole("textbox", {
			name: "What did you expect?",
			exact: true,
		});
		const initialHeight = await textarea.evaluate((el) => {
			const css = getComputedStyle(el);
			const height = el.getBoundingClientRect().height;
			return {
				height,
				minimum:
					2 * parseFloat(css.lineHeight) +
					parseFloat(css.paddingTop) +
					parseFloat(css.paddingBottom),
			};
		});
		assert(
			initialHeight.height >= initialHeight.minimum &&
				initialHeight.height <= 120,
			"empty textarea starts at two to three compact rows",
		);
		const columns = await page
			.locator(".support-report-fields")
			.evaluate(
				(el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
			);
		assert.equal(
			columns,
			viewport.width >= 900 ? 2 : 1,
			"responsive columns use real app CSS",
		);
		const checkChrome = async () => {
			for (const name of ["Preview report", "File support request"]) {
				const box = await page
					.getByRole("button", { name, exact: true })
					.boundingBox();
				assert(
					box &&
						box.y >= 0 &&
						box.y + box.height <= viewport.height &&
						box.x >= 0 &&
						box.x + box.width <= viewport.width,
					`${name} must stay in viewport ${JSON.stringify({ viewport, box })}`,
				);
			}
			const header = await dialog
				.locator('[data-slot="dialog-header"]')
				.boundingBox();
			assert(
				header && header.y >= 0 && header.y + header.height < viewport.height,
				"heading stays visible",
			);
		};
		await checkChrome();
		for (const name of [
			"What did you expect?",
			"What happened?",
			"Steps to reproduce",
		]) {
			await page
				.getByRole("textbox", { name, exact: true })
				.fill("A line of report detail.\n".repeat(20));
		}
		assert(
			(await textarea.evaluate((el) => el.getBoundingClientRect().height)) >
				initialHeight.height + 100,
			"textarea grows with a long report",
		);
		await page
			.getByRole("textbox", { name: "Summary", exact: true })
			.fill("A layout problem");

		await checkChrome();
		await page
			.getByRole("button", { name: "Preview report", exact: true })
			.click();
		const scroller = dialog.locator('[data-slot="dialog-body"]');
		assert(
			await scroller.evaluate((el) => el.scrollHeight > el.clientHeight),
			"long report scrolls internally",
		);
		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await checkChrome();
		await page.mouse.move(2, viewport.height / 2);
		await page.mouse.wheel(0, 500);
		assert.equal(
			await page.evaluate(() => window.scrollY),
			0,
			"modal locks background scrolling",
		);
		await page.keyboard.press("Tab");
		assert(
			await dialog.evaluate((el) => el.contains(document.activeElement)),
			"focus remains trapped",
		);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		await page.close();
		console.log(`Dialog viewport passed: ${viewport.width}x${viewport.height}`);
	}

	const settled = (page: import("playwright").Page) =>
		page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== "running"),
		);
	for (const viewport of [
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
	]) {
		const phone = viewport.width < 640;

		// Focus return + Escape on a plain form dialog.
		const page = await browser.newPage({ viewport });
		await page.goto(`${origin}/browser-tests/dialogs.html?view=identity`);
		const opener = page.getByRole("button", { name: "Edit identity" });
		await opener.click();
		const dialog = page.getByRole("dialog");
		await dialog.waitFor();
		await settled(page);
		const box = await dialog.boundingBox();
		assert(box, "dialog has a box");
		if (phone) {
			assert(
				box.x === 0 &&
					box.width === viewport.width &&
					Math.abs(box.y + box.height - viewport.height) <= 1,
				`phone dialog is a full-width bottom drawer ${JSON.stringify(box)}`,
			);
		} else {
			assert(
				Math.abs(box.x + box.width / 2 - viewport.width / 2) <= 1 &&
					box.y > 0 &&
					box.y + box.height < viewport.height,
				`desktop dialog is a centred card ${JSON.stringify(box)}`,
			);
		}
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "hidden" });
		assert(
			await opener.evaluate((el) => el === document.activeElement),
			"focus returns to the opener after Escape",
		);
		await page.close();

		// A confirm opened from inside a Sheet stacks above it; Escape closes
		// only the confirm and focus returns into the sheet.
		const nested = await browser.newPage({ viewport });
		await nested.goto(`${origin}/browser-tests/dialogs.html?view=sheet`);
		await nested.getByRole("button", { name: "Open details" }).click();
		const sheet = nested.getByRole("dialog", { name: "Source details" });
		await sheet.waitFor();
		await settled(nested);
		const removeSource = sheet.getByRole("button", { name: "Remove source" });
		await removeSource.click();
		const confirm = nested.getByRole("alertdialog");
		await confirm.waitFor();
		await settled(nested);
		const confirmButton = confirm.getByRole("button", {
			name: "Remove source",
		});
		// The phone drawer slides in, so poll until its button is hit-testable.
		await nested.waitForFunction(
			(el) => {
				const r = el.getBoundingClientRect();
				return el.contains(
					document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
				);
			},
			await confirmButton.elementHandle(),
			{ timeout: 3000 },
		);
		await nested.keyboard.press("Tab");
		assert(
			await confirm.evaluate((el) => el.contains(document.activeElement)),
			"focus is trapped in the top dialog",
		);
		await nested.keyboard.press("Escape");
		await confirm.waitFor({ state: "hidden" });
		assert(await sheet.isVisible(), "Escape leaves the sheet open");
		assert(
			await removeSource.evaluate((el) => el === document.activeElement),
			"focus returns to the sheet control",
		);
		await nested.close();
		console.log(
			`Dialog behaviour passed: ${viewport.width}x${viewport.height}`,
		);
	}
} finally {
	await browser?.close();
	// vp launches Vite in a child; close the group so test gates receive EOF.
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
