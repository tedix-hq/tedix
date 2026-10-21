import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
	chromium,
	webkit,
	type Browser,
	type BrowserType,
	type Page,
} from "playwright";

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
type Case = {
	engine: string;
	type: BrowserType;
	viewport: { width: number; height: number };
	theme: "light" | "dark";
};
const cases: Case[] = [];
for (const theme of ["light", "dark"] as const) {
	for (const viewport of [
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
	])
		cases.push({ engine: "chromium", type: chromium, viewport, theme });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
	])
		cases.push({ engine: "webkit", type: webkit, viewport, theme });
}
const label = (c: Case) =>
	`${c.engine} ${c.viewport.width}x${c.viewport.height} ${c.theme}`;
const fixtureUrl = (c: Case, view?: string) =>
	`${origin}/browser-tests/dialogs.html?theme=${c.theme}${view ? `&view=${view}` : ""}`;
const browsers = new Map<string, Browser>();
const diagnostics = new Map<Page, string[]>();
const fresh = async (c: Case) => {
	let browser = browsers.get(c.engine);
	if (!browser) {
		browser = await c.type.launch({ headless: true });
		browsers.set(c.engine, browser);
	}
	const context = await browser.newContext({
		viewport: c.viewport,
		colorScheme: c.theme,
	});
	const page = await context.newPage();
	const seen: string[] = [];
	diagnostics.set(page, seen);
	page.on("pageerror", (e) => seen.push(`pageerror: ${e.message}`));
	page.on("requestfailed", (r) => seen.push(`requestfailed: ${r.url()}`));
	page.on("request", (r) => {
		if (!r.url().startsWith(origin)) seen.push(`external: ${r.url()}`);
		if (r.method() !== "GET" && r.method() !== "HEAD")
			seen.push(`${r.method()}: ${r.url()}`);
	});
	return page;
};
// Close the isolated context and require a clean run: no page error, failed
// or external request, submission or horizontal overflow.
const finish = async (page: Page, c: Case) => {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - innerWidth,
	);
	const seen = diagnostics.get(page) ?? [];
	await page.context().close();
	assert.deepEqual(seen, [], `${label(c)} diagnostics`);
	assert(overflow <= 0, `${label(c)} no horizontal overflow`);
};
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
	const settled = (page: Page) =>
		page.waitForFunction(() =>
			document.getAnimations().every((a) => a.playState !== "running"),
		);
	for (const c of cases) {
		const { viewport } = c;
		const page = await fresh(c);
		await page.goto(fixtureUrl(c));
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
		// Known product gap (support-get-help.tsx is outside this spec): closing
		// Get help leaves focus on <body> instead of the opener, so focus return
		// is asserted on the identity and nested dialogs below. Reopening by
		// keyboard and pointer still has to land on Summary every time.
		const help = page.getByRole("button", { name: "Get help", exact: true });
		for (const mode of ["keyboard", "pointer", "keyboard"] as const) {
			if (mode === "keyboard") {
				await help.focus();
				await page.keyboard.press("Enter");
			} else await help.click();
			await dialog.waitFor();
			await settled(page);
			assert(
				await page
					.getByRole("textbox", { name: "Summary", exact: true })
					.evaluate((el) => el === document.activeElement),
				`${label(c)}: Summary receives focus on ${mode} reopen`,
			);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
		}
		await finish(page, c);
		console.log(`Dialog viewport passed: ${label(c)}`);
	}

	for (const c of cases) {
		const { viewport } = c;
		const phone = viewport.width < 640;

		// Focus return + Escape on a plain form dialog.
		const page = await fresh(c);
		await page.goto(fixtureUrl(c, "identity"));
		const opener = page.getByRole("button", { name: "Edit identity" });
		// Safari does not focus a button on click, so WebKit opens by keyboard to
		// give the dialog a focused opener to restore; pointer opens follow below.
		if (c.engine === "webkit") {
			await opener.focus();
			await page.keyboard.press("Enter");
		} else await opener.click();
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
		for (const mode of ["keyboard", "pointer", "keyboard"] as const) {
			if (mode === "keyboard") await page.keyboard.press("Enter");
			else await opener.click();
			await dialog.waitFor();
			await settled(page);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			if (mode === "keyboard" || c.engine !== "webkit")
				assert(
					await opener.evaluate((el) => el === document.activeElement),
					`${label(c)}: focus returns after ${mode} reopen`,
				);
			else await opener.focus();
		}
		await finish(page, c);

		// A confirm opened from inside a Sheet stacks above it; Escape closes
		// only the confirm and focus returns into the sheet.
		const nested = await fresh(c);
		await nested.goto(fixtureUrl(c, "sheet"));
		await nested.getByRole("button", { name: "Open details" }).click();
		const sheet = nested.getByRole("dialog", { name: "Source details" });
		await sheet.waitFor();
		await settled(nested);
		const removeSource = sheet.getByRole("button", { name: "Remove source" });
		if (c.engine === "webkit") {
			await removeSource.focus();
			await nested.keyboard.press("Enter");
		} else await removeSource.click();
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
		// Footer actions stay visible and phone targets are at least 44px.
		await sheet.getByRole("button").last().waitFor();
		const footer = await sheet.getByRole("button").evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				return { w: r.width, h: r.height, bottom: r.bottom };
			}),
		);
		for (const b of footer)
			assert(
				b.bottom <= viewport.height && (!phone || b.h >= 44),
				`${label(c)}: sheet action visible and >=44px on phone ${JSON.stringify(footer)}`,
			);
		await finish(nested, c);
		console.log(`Dialog behaviour passed: ${label(c)}`);
	}
} finally {
	for (const browser of browsers.values()) await browser.close();
	// vp launches Vite in a child; close the group so test gates receive EOF.
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
