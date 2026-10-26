import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";
import { App } from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/server.js";
import manifest from "../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/manifest.json";

const server = await startFixtureServer("/browser-tests/app-runtime.html");
const browser = await chromium.launch({ headless: true });
try {
	for (const width of [375, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 812 } });
		const calls: string[] = [];
		let saved: unknown;
		await page.route("**/api/rpc/osAppRuntime/*", async (route) => {
			const method = new URL(route.request().url()).pathname.split("/").pop();
			if (method === "open")
				return route.fulfill({
					json: {
						json: {
							session: "host-only",
							expiresAt: Math.floor(Date.now() / 1000) + 60,
							role: "use",
							revisionId: "33333333-3333-4333-8333-333333333333",
						},
					},
				});
			const input = route.request().postDataJSON().json;
			assert.equal(input.session, "host-only");
			calls.push(input.method);
			if (input.method === "rate") saved = input.args[0];
			return route.fulfill({
				json: {
					json: { result: input.method === "rate" ? saved : { one: saved } },
				},
			});
		});
		await page.goto(`${server.origin}/browser-tests/app-runtime.html`);
		const guest = page
			.frameLocator('iframe[title="Rating app"]')
			.frameLocator("iframe");
		await guest.getByRole("button", { name: "Hilfreich", exact: true }).click();
		await guest
			.getByRole("status")
			.filter({ hasText: '"decision":"Hilfreich"' })
			.waitFor();
		assert.deepEqual(calls, ["rate", "ratings"]);
		assert.equal(
			await page.locator("[data-app-runtime-frame]").getAttribute("data-state"),
			"ready",
		);
		await page.close();
	}
	for (const width of [375, 1280]) {
		const page = await browser.newPage({
			viewport: { width, height: 812 },
			colorScheme: "light",
		});
		const values = new Map<string, unknown>([["unrelated", "keep"]]);
		const kv = {
			get: (key: string) => values.get(key),
			put: (key: string, value: unknown) => values.set(key, value),
			delete: (key: string) => values.delete(key),
			list: ({ prefix }: { prefix: string }) =>
				new Map([...values].filter(([key]) => key.startsWith(prefix))),
		};
		const sheet = {
			kind: "sheet",
			columns: ["ID", "Titel", "Text", "Thema"],
			rows: [
				[
					"one",
					"Ein hilfreicher Vorschlag",
					"Langer deutscher Text ".repeat(24),
					"Planung",
				],
				["two", "Zweiter Vorschlag", "<script>untrusted</script>", "Team"],
			],
		};
		const app = new App(
			{ storage: { kv } },
			{
				CONFIG: manifest.config,
				TEDIX: {
					outputsRead: async (slot: string) => {
						assert.equal(slot, "cards");
						return { revision: { content: sheet } };
					},
				},
			},
		);
		await assert.rejects(() => app.rate("one", "send"));
		await assert.rejects(() => app.rate("missing", "useful"));
		await page.route("**/api/rpc/osAppRuntime/*", async (route) => {
			const method = new URL(route.request().url()).pathname.split("/").pop();
			if (method === "open")
				return route.fulfill({
					json: {
						json: {
							session: "host-only",
							expiresAt: Math.floor(Date.now() / 1000) + 60,
							role: "use",
							revisionId: "33333333-3333-4333-8333-333333333333",
						},
					},
				});
			const input = route.request().postDataJSON().json;
			const result =
				input.method === "cards"
					? await app.cards()
					: input.method === "rate"
						? await app.rate(...input.args)
						: app.reset();
			await route.fulfill({ json: { json: { result } } });
		});
		await page.goto(`${server.origin}/browser-tests/app-runtime.html?starter`);
		const guest = page
			.frameLocator('iframe[title="Rating app"]')
			.frameLocator("iframe");
		await guest
			.getByRole("heading", { name: "Ein hilfreicher Vorschlag" })
			.waitFor();
		assert.equal(await guest.locator("html").getAttribute("lang"), "de");
		const geometry = await guest.locator("body").evaluate((body) => ({
			overflow: body.scrollWidth > document.documentElement.clientWidth,
			background: getComputedStyle(body).backgroundColor,
			targets: [...body.querySelectorAll("button")].map((button) => ({
				width: button.getBoundingClientRect().width,
				height: button.getBoundingClientRect().height,
			})),
		}));
		assert.equal(geometry.overflow, false);
		assert.equal(geometry.background, "rgb(245, 244, 240)");
		assert(
			geometry.targets.every(
				({ width, height }) => width >= 44 && height >= 44,
			),
		);
		if (process.env.TEDIX_STARTER_SCREENSHOT_DIR)
			await page.screenshot({
				path: `${process.env.TEDIX_STARTER_SCREENSHOT_DIR}/starter-${width}.png`,
				fullPage: true,
			});
		await guest.getByRole("button", { name: "Hilfreich", exact: true }).click();
		await guest.getByRole("heading", { name: "Zweiter Vorschlag" }).waitFor();
		assert.equal(values.get("review:one"), "useful");
		await guest.getByRole("tab", { name: "Bewertet" }).click();
		await guest
			.getByRole("heading", { name: "Ein hilfreicher Vorschlag" })
			.waitFor();
		await page.reload();
		await guest.getByRole("heading", { name: "Zweiter Vorschlag" }).waitFor();
		await guest
			.getByRole("button", { name: "Bewertungen zurücksetzen" })
			.click();
		await guest.getByRole("button", { name: "Abbrechen" }).click();
		assert.equal(values.get("review:one"), "useful");
		await guest
			.getByRole("button", { name: "Bewertungen zurücksetzen" })
			.click();
		await guest.getByRole("button", { name: "Ja, zurücksetzen" }).click();
		await guest
			.getByRole("heading", { name: "Ein hilfreicher Vorschlag" })
			.waitFor();
		assert.equal(values.has("review:one"), false);
		assert.equal(values.get("unrelated"), "keep");
		assert.equal(sheet.rows.length, 2);
		sheet.rows = [];
		await guest.getByRole("button", { name: "Neu laden" }).click();
		await guest.getByText("Alles geprüft. Danke!", { exact: true }).waitFor();
		await page.route("**/api/rpc/osAppRuntime/call", (route) => route.abort());
		await guest.getByRole("button", { name: "Neu laden" }).click();
		await guest.getByRole("alert").waitFor();
		await page.close();
	}
	console.log(
		"Runtime app sandbox rating round trip passed at 375px and 1280px",
	);
} finally {
	await browser.close();
	await server.stop();
}
