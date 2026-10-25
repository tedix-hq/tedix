import assert from "node:assert/strict";
import { devices, webkit, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * The Deck's "Confirm decision" sheet in WebKit. Live report: tapping Confirm
 * on a protected card did nothing visible. The save failed, but its error was
 * written into the card behind the modal and into a toast that Kumo's z-1
 * viewport painted under the sheet. The sheet must show progress at once,
 * keep a failure on screen with a way forward, and close on success.
 */
const server = await startFixtureServer("/work?view=deck", {
	stdout: "ignore",
});
const { origin } = server;
const shots = process.env.TEDIX_SCREENSHOT_DIR;
// Protected sample cards: their yes option asks for confirmation. Each run
// saves one, so every viewport gets its own.
const CARDS = [11, 12, 13, 14, 15, 16].map(
	(n) => `000000a7-0000-4000-8000-0000000000${n}`,
);
const RESPOND = /\/api\/rpc\/workInteractions\/respond/;

/** Footer geometry: equal full-width buttons on phones, a right-aligned row on desktop. */
function footer(page: Page) {
	return page.evaluate(() => {
		const dialog = document.querySelector<HTMLElement>("[role=alertdialog]")!;
		const row = dialog.querySelector<HTMLElement>(
			"[data-slot=alert-dialog-footer]",
		)!;
		const rowBox = row.getBoundingClientRect();
		const style = getComputedStyle(row);
		const inner = {
			left: rowBox.left + parseFloat(style.paddingLeft),
			right: rowBox.right - parseFloat(style.paddingRight),
		};
		const buttons = [...row.querySelectorAll<HTMLElement>("button")].map(
			(button) => {
				const box = button.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				);
				return {
					text: button.innerText.trim(),
					left: box.left,
					right: box.right,
					top: box.top,
					bottom: box.bottom,
					width: box.width,
					height: box.height,
					justify: getComputedStyle(button).justifyContent,
					hit: Boolean(hit && button.contains(hit)),
				};
			},
		);
		const title = dialog.querySelector<HTMLElement>("h2")!;
		const description = dialog.querySelector<HTMLElement>("p")!;
		return {
			buttons,
			inner,
			viewport: {
				width: innerWidth,
				height: window.visualViewport?.height ?? innerHeight,
			},
			align: [
				getComputedStyle(title).textAlign,
				getComputedStyle(description).textAlign,
			],
		};
	});
}

function checkFooter(
	label: string,
	phone: boolean,
	geometry: Awaited<ReturnType<typeof footer>>,
) {
	const [back, confirm] = geometry.buttons;
	assert(back && confirm, `${label}: two footer buttons`);
	for (const button of geometry.buttons) {
		assert(button.hit, `${label}: "${button.text}" is covered`);
		assert(
			button.left >= 0 &&
				button.right <= geometry.viewport.width &&
				button.bottom <= geometry.viewport.height,
			`${label}: "${button.text}" leaves the viewport ${JSON.stringify(button)}`,
		);
		if (phone) {
			assert(
				button.height >= 44,
				`${label}: "${button.text}" is ${button.height}px tall`,
			);
			assert.equal(
				button.justify,
				"center",
				`${label}: "${button.text}" label is not centred`,
			);
		}
	}
	assert.deepEqual(
		geometry.align.map((value) => (value === "start" ? "left" : value)),
		["left", "left"],
		`${label}: title and body alignment`,
	);
	if (phone) {
		assert(
			Math.abs(back.width - confirm.width) <= 1,
			`${label}: buttons ${back.width} and ${confirm.width} wide`,
		);
		assert(
			Math.abs(confirm.left - geometry.inner.left) <= 1 &&
				Math.abs(confirm.right - geometry.inner.right) <= 1,
			`${label}: Confirm is not full width`,
		);
		assert(confirm.bottom <= back.top, `${label}: Confirm sits above Go back`);
	} else {
		assert(
			Math.abs(back.top - confirm.top) <= 1,
			`${label}: desktop actions share a row`,
		);
		assert(back.right < confirm.left, `${label}: Go back precedes Confirm`);
		assert(
			Math.abs(confirm.right - geometry.inner.right) <= 1,
			`${label}: desktop actions are right-aligned`,
		);
	}
}

async function shot(page: Page, name: string) {
	if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function settleToast(page: Page, title: string) {
	await page.waitForFunction(
		(text) => {
			const toast = [
				...document.querySelectorAll<HTMLElement>(
					"[data-os-toast-outlet] [role=dialog]",
				),
			].find((element) => element.innerText.includes(text));
			if (!toast || toast.hasAttribute("data-starting-style")) return false;
			return [
				...document.querySelectorAll<HTMLElement>(
					"[data-os-toast-outlet], [role=alertdialog]",
				),
			].every((element) =>
				element
					.getAnimations({ subtree: true })
					.every((animation) => animation.playState !== "running"),
			);
		},
		title,
		{ timeout: 10_000 },
	);
}

let browser: Browser | undefined;
try {
	browser = await webkit.launch({ headless: true });
	// A toast raised while any dialog is open paints above that dialog.
	{
		const context = await browser.newContext({ ...devices["iPhone 13"] });
		const page = await context.newPage();
		await page.route(RESPOND, (route) =>
			route.fulfill({
				status: 403,
				contentType: "application/json",
				body: JSON.stringify({
					json: { defined: false, code: "FORBIDDEN", message: "Nope" },
				}),
			}),
		);
		await page.goto(`${origin}/work?view=deck#card=${CARDS[0]}`);
		await page.locator(".fd-deck-current .fd-card").waitFor();
		await page
			.locator('.fd-deck-current [data-decision-intent="approve"]')
			.first()
			.tap();
		await page.getByRole("alertdialog").waitFor();
		await page.evaluate(async () => {
			const { toast } = await import("/src/components/kumo/toast.tsx");
			// Keep the layering probe alive across separate browser calls on busy runners.
			toast.message("Layer check", { duration: 0 });
		});
		await settleToast(page, "Layer check");
		const above = await page.evaluate(() => {
			const node = [
				...document.querySelectorAll<HTMLElement>(
					"[data-os-toast-outlet] [role=dialog]",
				),
			].find((element) => element.innerText.includes("Layer check"));
			if (!node) return "no toast";
			const box = node.getBoundingClientRect();
			const hit = document.elementFromPoint(
				box.left + box.width / 2,
				box.top + box.height / 2,
			);
			return hit && node.contains(hit) ? "above" : "covered";
		});
		assert.equal(above, "above", "toast paints above an open dialog");
		await context.close();
		console.log("PASS toast above dialog");
	}
	const sizes = [
		["390x844", devices["iPhone 13"], true],
		["375x667", devices["iPhone 8"], true],
		["1280x800", { viewport: { width: 1280, height: 800 } }, false],
	] as const;
	let run = 0;
	for (const [size, device, phone] of sizes)
		for (const colorScheme of ["light", "dark"] as const) {
			const cardId = CARDS[run++]!;
			const label = `${size} ${colorScheme}`;
			const context = await browser.newContext({
				...device,
				colorScheme,
				reducedMotion: "reduce",
			});
			await context.addInitScript(
				(theme) => localStorage.setItem("tedix-os-theme", theme),
				colorScheme,
			);
			const page = await context.newPage();
			const tap = (name: string) =>
				phone
					? page.getByRole("button", { name, exact: true }).tap()
					: page.getByRole("button", { name, exact: true }).click();
			// Every save is refused first, slowly enough to see it pending.
			let release: () => void = () => {};
			await page.route(RESPOND, async (route) => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				await route.fulfill({
					status: 403,
					contentType: "application/json",
					body: JSON.stringify({
						json: {
							defined: false,
							code: "FORBIDDEN",
							message: "Missing permission",
						},
					}),
				});
			});
			await page.goto(`${origin}/work?view=deck#card=${cardId}`);
			const card = page.locator(".fd-deck-current .fd-card");
			await card.waitFor();
			await page.evaluate(() => document.fonts.ready);
			const approve = card.locator('[data-decision-intent="approve"]').first();
			await (phone ? approve.tap() : approve.click());
			const dialog = page.getByRole("alertdialog");
			await dialog.waitFor();
			await page.waitForFunction(() =>
				document.getAnimations().every((a) => a.playState !== "running"),
			);
			const description = await dialog.locator("p").first().innerText();
			assert(!/\.\./.test(description), `${label}: "${description}"`);
			checkFooter(label, phone, await footer(page));
			await shot(page, `sheet-${size}-${colorScheme}`);

			// Pending: the tap shows progress at once and blocks a second submit.
			await tap("Confirm");
			const pending = dialog.getByRole("button", {
				name: /Confirming/,
			});
			await pending.waitFor();
			assert(await pending.isDisabled(), `${label}: pending Confirm disabled`);
			assert(
				await dialog
					.getByRole("button", { name: "Go back", exact: true })
					.isDisabled(),
				`${label}: Go back disabled while saving`,
			);
			await shot(page, `pending-${size}-${colorScheme}`);

			// Failure: the sheet stays, says why and what to do, and offers a retry.
			release();
			const alert = dialog.locator("[data-confirm-error]");
			await alert.waitFor();
			const message = await alert.innerText();
			assert(
				/not saved|permission/i.test(message) &&
					/owner of the originating Work|admin/.test(message),
				`${label}: error reads "${message}"`,
			);
			await dialog
				.getByRole("button", { name: "Try again", exact: true })
				.waitFor();
			checkFooter(label, phone, await footer(page));
			assert.equal(
				await page.locator("[data-os-toast-outlet] [role=dialog]").count(),
				0,
				`${label}: the failure is not repeated in a toast over the sheet`,
			);
			await shot(page, `error-${size}-${colorScheme}`);

			// Success: the next attempt saves, the sheet closes and a toast says so.
			await page.unroute(RESPOND);
			await tap("Try again");
			await dialog.waitFor({ state: "hidden" });
			const toast = page
				.locator("[data-os-toast-outlet] [role=dialog]")
				.filter({ hasText: "Decision saved" });
			await toast.waitFor();
			await settleToast(page, "Decision saved");
			const visible = await toast.evaluate((node) => {
				const box = node.getBoundingClientRect();
				const hit = document.elementFromPoint(
					box.left + box.width / 2,
					box.top + box.height / 2,
				);
				return Boolean(hit && node.contains(hit));
			});
			assert(visible, `${label}: "Decision saved" toast is covered`);
			await shot(page, `saved-${size}-${colorScheme}`);
			await context.close();
			console.log(`PASS ${label}`);
		}
} finally {
	await browser?.close();
	await server.stop();
}
