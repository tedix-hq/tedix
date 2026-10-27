import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Permanent share links at phone and desktop widths, light and dark:
// - `/s/<id>` opens the sample company's shared app without an account,
//   keeps its session under the link id, and resumes on reload;
// - an old `/guest#token=` link moves to its `/s/<id>` address;
// - an unknown id says so and shows nothing;
// - the Share dialog shows the permanent address with Copy, offers the three
//   audiences, changes access in place, adds and removes invited people, and
//   turns the link off.
const PUBLIC_ID = "PricePilotOpportunity1";
const token = "share-link-token-0123456789abcdefghij";
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ?? join(tmpdir(), "tedix-share-link");
await mkdir(evidence, { recursive: true });

const server = await startFixtureServer("/");
let browser: Browser | undefined;

async function fits(page: Page, label: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth + 1,
		),
		`${label}: no horizontal page overflow`,
	);
}

async function openGuestApp(page: Page, label: string) {
	await page.getByRole("textbox", { name: "Your name" }).fill("Maya");
	await page.getByRole("button", { name: "Open app", exact: true }).click();
	await page
		.locator("[data-guest-app]")
		.getByRole("heading", { name: "Opportunity cards" })
		.waitFor();
	await fits(page, label);
}

try {
	browser = await chromium.launch({ headless: true });
	for (const theme of ["light", "dark"] as const) {
		for (const width of [375, 1280]) {
			const label = `${width}/${theme}`;
			const context = await browser.newContext({
				viewport: { width, height: width < 820 ? 812 : 800 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const page = await context.newPage();
			await page.addInitScript(
				(mode) => localStorage.setItem("tedix-os-theme", mode),
				theme,
			);
			await page.route("**/*", (route) =>
				new URL(route.request().url()).origin === server.origin
					? route.continue()
					: route.abort("blockedbyclient"),
			);

			// The permanent address opens the app for someone with no account.
			await page.goto(`${server.origin}/s/${PUBLIC_ID}`);
			await openGuestApp(page, `${label} /s`);
			assert.equal(new URL(page.url()).pathname, `/s/${PUBLIC_ID}`);
			assert.equal(
				await page.locator("html").getAttribute("data-mode"),
				theme,
				`${label}: the page follows the device theme`,
			);
			assert(
				await page.evaluate(
					(id) => sessionStorage.getItem(`tedix.os.share.${id}`) !== null,
					PUBLIC_ID,
				),
				`${label}: the session is kept under the link id`,
			);
			await page.screenshot({ path: `${evidence}/${width}-${theme}-s.png` });
			// A reload is a bookmark: same address, same session, no new name.
			await page.reload();
			await page
				.locator("[data-guest-app]")
				.getByRole("heading", { name: "Opportunity cards" })
				.waitFor();

			// An old link redeems once and moves to the permanent address.
			const old = await context.newPage();
			await old.goto(`${server.origin}/guest#token=${token}`);
			await old
				.locator("[data-guest-app]")
				.or(old.getByRole("textbox", { name: "Your name" }))
				.first()
				.waitFor();
			if (await old.getByRole("textbox", { name: "Your name" }).count())
				await openGuestApp(old, `${label} old`);
			assert.equal(
				new URL(old.url()).pathname,
				`/s/${PUBLIC_ID}`,
				`${label}: an old link shows its permanent address`,
			);
			assert.equal(new URL(old.url()).hash, "");
			await old.close();

			// An unknown link explains itself and shows nothing.
			await page.goto(`${server.origin}/s/UnknownLinkUnknownLink`);
			await page.getByText("This link isn't available").waitFor();
			assert.equal(await page.locator("iframe").count(), 0);
			await fits(page, `${label} unavailable`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-unavailable.png`,
			});

			// The Share dialog for a file.
			await page.goto(`${server.origin}/outputs`);
			const card = page.locator(".output-grid-card").first();
			await card.waitFor();
			// The card's own open control overlays it; Share is reached by keyboard.
			await card
				.getByRole("button", { name: "Share", exact: true })
				.press("Enter");
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("heading", { name: "Share this file" }).waitFor();
			const current = dialog.locator("[data-share-link-current]");
			const create = dialog.getByRole("button", {
				name: "Create link",
				exact: true,
			});
			await current.or(create).first().waitFor();
			if ((await current.count()) === 0) await create.click();
			const address = current.locator("[data-share-url]");
			await address.waitFor();
			const url = (await address.textContent()) ?? "";
			assert.match(
				url,
				/^https?:\/\/[^/]+\/s\/[A-Za-z0-9]{22}$/,
				`${label}: the dialog shows the permanent address`,
			);
			await current.getByRole("button", { name: "Copy link" }).waitFor();

			const access = dialog.getByRole("combobox", { name: "Who can open it" });
			await access.click();
			await page.getByRole("option").nth(2).waitFor();
			const options = (await page.getByRole("option").allTextContents()).map(
				(option) => option.trim(),
			);
			assert.equal(options.length, 3, `${label}: three audiences`);
			assert.equal(options[0], "Anyone with the link");
			assert.match(options[1] ?? "", /^People in \S/);
			assert.equal(options[2], "Only people you invite");
			await page
				.getByRole("option", { name: "Only people you invite" })
				.click();
			await dialog.getByRole("button", { name: "Change access" }).click();
			const invitees = dialog.locator("[data-share-invitees]");
			await invitees.waitFor();
			assert.equal(
				await address.textContent(),
				url,
				`${label}: changing access keeps the address`,
			);
			await invitees
				.getByLabel("Email address to invite")
				.fill("kai@example.test");
			await invitees.getByRole("button", { name: "Add", exact: true }).click();
			await invitees.getByText("kai@example.test").waitFor();
			await fits(page, `${label} dialog`);
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-dialog.png`,
			});
			await invitees
				.getByRole("button", { name: "Remove kai@example.test" })
				.click();
			await invitees.getByText("Nobody yet").waitFor();

			await dialog.getByRole("button", { name: "Link options" }).click();
			await page.getByRole("menuitem", { name: "Turn off link" }).click();
			const confirm = dialog.locator("[data-share-turn-off]");
			await confirm.waitFor();
			await page.screenshot({
				path: `${evidence}/${width}-${theme}-turn-off.png`,
			});
			await confirm.getByRole("button", { name: "Turn off link" }).click();
			await create.waitFor();
			assert.equal(await current.count(), 0, `${label}: the link is off`);
			await fits(page, `${label} after turn off`);
			await context.close();
		}
	}
	console.log(
		`Share links passed at 375px and 1280px in light and dark; screenshots in ${evidence}`,
	);
} finally {
	await browser?.close();
	await server.stop();
}
