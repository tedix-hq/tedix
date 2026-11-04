import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * My accounts after adding a second Gmail account. One row per account, each
 * showing its Gmail address, which is the default, that both are personal,
 * and which app uses it; a missing Identity permission names the exact line
 * to allow on Google's screen; Details says which account each app uses.
 */
const evidence =
	process.env.TEDIX_SCREENSHOT_DIR ??
	new URL("../node_modules/.cache/gmail-accounts/", import.meta.url).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer();
const browser = await chromium.launch({ headless: true });

const identityScope = "https://www.googleapis.com/auth/userinfo.email";
const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";
const gmailApp = {
	appId: "00000000-0000-4000-8000-00000000a0a1",
	appSlug: "google-gmail",
	appName: "Google Gmail",
	source: "app",
};
const tedixApp = {
	appId: "00000000-0000-4000-8000-00000000a0a2",
	appSlug: "google-gmail-tedix",
	appName: "Google Gmail Tedix",
	source: "app",
};

/** The personal Gmail rows the API returns once a second account is added. */
function gmailAccounts(template: Record<string, unknown>) {
	const provider = {
		...(template.provider as Record<string, unknown>),
		credentialProfile: {
			scopeGroups: [
				{ id: "identity", label: "Identity", scopes: [identityScope] },
				{ id: "mail", label: "Mail", scopes: [gmailScope] },
			],
		},
	};
	const account = (
		id: string,
		extra: Record<string, unknown>,
		scopes: string[],
	) => ({
		...template,
		provider,
		scope: "user",
		accountState: "present",
		connectionInstanceId: id,
		bindingTargets: [gmailApp, tedixApp],
		connection: {
			appId: "google-gmail",
			providerName: "Google Gmail",
			status: "connected",
			connectedAt: null,
			tokenExpiresAt: null,
			scopes,
			tokenScope: "user",
		},
		capabilities: [
			{
				id: "identity",
				label: "Identity",
				requiredScopes: [identityScope],
				state: scopes.includes(identityScope) ? "connected" : "not_configured",
				setupUrl: `/account/connections?connect=google-gmail&connectionInstanceId=${id}&capability=identity`,
				verified: true,
			},
			{
				id: "mail",
				label: "Mail",
				requiredScopes: [gmailScope],
				state: "connected",
				setupUrl: `/account/connections?connect=google-gmail&connectionInstanceId=${id}&capability=mail`,
				verified: true,
			},
		],
		...extra,
	});
	return [
		account(
			"00000000-0000-4000-8000-0000000000a1",
			{
				instanceLabel: "Gmail (default)",
				accountEmail: "owner@solstice.example",
				isDefault: true,
				references: [gmailApp],
			},
			[identityScope, gmailScope],
		),
		account(
			"00000000-0000-4000-8000-0000000000a2",
			{
				instanceLabel: "Account",
				accountEmail: "sam@solstice.example",
				isDefault: false,
				references: [tedixApp],
			},
			[gmailScope],
		),
	];
}

let checks = 0;
try {
	for (const width of [375, 1280])
		for (const theme of ["light", "dark"] as const) {
			const label = `${width}/${theme}`;
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
				reducedMotion: "reduce",
			});
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.route(
				"**/api/rpc/connections/getConnectionsOverview*",
				async (route) => {
					const response = await route.fetch();
					const body = await response.json();
					if (body.json?.scope !== "personal")
						return route.fulfill({ response, json: body });
					const rows = body.json.rows as Record<string, unknown>[];
					const template = rows.find(
						(row) =>
							(row.provider as { appId: string }).appId === "google-gmail",
					);
					assert.ok(template, "fixture has a personal Gmail row");
					body.json.rows = [
						...rows.filter((row) => row !== template),
						...gmailAccounts(template),
					];
					body.json.total = body.json.rows.length;
					await route.fulfill({ response, json: body });
				},
			);
			await page.goto(`${server.origin}/account/connections`);
			const gmail = page.locator(
				'[aria-label="Connected accounts"] > li[data-account-group="google-gmail"]',
			);
			await gmail.waitFor();
			await page.evaluate(() => document.fonts.ready);
			assert.equal(
				await page.locator('li[data-account-group="google-gmail"]').count(),
				1,
				`${label}: Gmail is one app row`,
			);
			await page.getByRole("button", { name: "Gmail details" }).click();

			// One row per account ID, never a "Default account" twin.
			const accounts = gmail.locator("li[data-account-row]");
			assert.equal(await accounts.count(), 2, `${label}: two account rows`);
			assert.deepEqual(
				await accounts.evaluateAll((items) =>
					items.map((item) => item.getAttribute("data-account-row")),
				),
				[
					"00000000-0000-4000-8000-0000000000a1",
					"00000000-0000-4000-8000-0000000000a2",
				],
				`${label}: one row per account ID`,
			);
			const opened = await gmail.innerText();
			assert.ok(
				!opened.includes("Default account"),
				`${label}: no unnamed default twin`,
			);

			const [owner, second] = [accounts.nth(0), accounts.nth(1)];
			const ownerText = await owner.innerText();
			const secondText = await second.innerText();
			assert.ok(
				ownerText.includes("owner@solstice.example"),
				`${label}: the default account shows its Gmail address`,
			);
			assert.ok(
				ownerText.includes("Default · Personal · Used by Google Gmail"),
				`${label}: default, scope and app on the first account (${ownerText})`,
			);
			assert.ok(
				secondText.includes("sam@solstice.example"),
				`${label}: the added account shows its Gmail address`,
			);
			assert.ok(
				secondText.includes(
					"Named “Account” · Personal · Used by Google Gmail Tedix",
				) && !secondText.includes("Default ·"),
				`${label}: the added account is personal, not default (${secondText})`,
			);
			assert.ok(
				secondText.includes(
					"Missing permission for Identity. Reconnect and allow “See your primary Google Account email address” on Google's screen",
				),
				`${label}: the Identity fault names Google's exact line`,
			);
			assert.ok(
				await second
					.getByRole("button", {
						name: "Reconnect Gmail sam@solstice.example",
					})
					.isVisible(),
				`${label}: Reconnect on the account that needs it`,
			);

			await gmail.getByRole("button", { name: "Details", exact: true }).click();
			const details = await gmail.innerText();
			assert.ok(
				details.includes(
					"2 apps use Gmail. Each signs in on its own, so each can use a different account.",
				),
				`${label}: two app identifiers are explained`,
			);
			assert.ok(
				details.includes(
					"One per app that uses Gmail: google-gmail, google-gmail-tedix",
				),
				`${label}: app identifiers say why there are two`,
			);
			for (const [slug, text] of [
				["google-gmail", "Google Gmail uses owner@solstice.example"],
				["google-gmail-tedix", "Google Gmail Tedix uses sam@solstice.example"],
			] as const)
				assert.ok(
					(
						await gmail.locator(`[data-app-account="${slug}"]`).innerText()
					).includes(text),
					`${label}: ${text}`,
				);
			assert.ok(
				await gmail
					.getByRole("button", {
						name: "Use sam@solstice.example for Google Gmail",
					})
					.isVisible(),
				`${label}: switching names the account and the app`,
			);

			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			);
			assert.equal(overflow, 0, `${label}: horizontal overflow`);
			assert.deepEqual(errors, [], `${label}: no page errors`);
			await page.screenshot({
				path: `${evidence}gmail-accounts-${width}-${theme}.png`,
				fullPage: true,
			});
			checks += 1;
			await page.close();
		}
	console.log(
		`PASS: two Gmail accounts in ${checks} page states; screenshots in ${evidence}`,
	);
} finally {
	await browser.close();
	await server.stop();
}
