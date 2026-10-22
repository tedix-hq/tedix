import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

const output =
	process.env.CALENDAR_RECOVERY_SHOTS ??
	join(tmpdir(), "b13-calendar-picker-recovery");
await mkdir(output, { recursive: true });
const probe = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const log = Bun.file(`${output}/server.log`).writer();
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		String(port),
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{
		cwd: new URL("../", import.meta.url).pathname,
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
		env: { ...process.env, VITE_LIVE_API: "0" },
	},
);
const collect = async (stream: ReadableStream<Uint8Array>) => {
	for await (const chunk of stream) {
		log.write(chunk);
		await log.flush();
	}
};
const streams = Promise.all([collect(server.stdout), collect(server.stderr)]);
let exited: number | undefined;
void server.exited.then((code) => {
	exited = code;
});
const account = {
	adapter: "google",
	providerId: "fictional-calendar",
	connectionScope: "user",
	connectionInstanceId: "11111111-1111-4111-8111-111111111111",
	instanceLabel: `Orchard team ${"long-account-label".repeat(8)}`,
	accountSubject: "grower@example.test",
};
const calendar = {
	id: "opaque-orchard-calendar",
	name: `Harvest planning ${"long-calendar-name".repeat(8)}`,
	timeZone: "Europe/Berlin",
	canRead: true,
	canWrite: false,
	conditionalWrites: false,
	ownerEmail: "grower@example.test",
};
const receipts: unknown[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const choices = (page: Page) =>
	page.evaluate(() => window.calendarFixture.choices);
const chooseButton = (page: Page) =>
	page.getByRole("button", { name: "Choose calendar", exact: true }).first();
async function select(page: Page) {
	await page
		.getByRole("combobox", { name: "Connected calendar account" })
		.click();
	await page.getByRole("option").first().click();
}
async function waitEnabled(page: Page) {
	await chooseButton(page).waitFor();
	await page.waitForFunction(() =>
		[...document.querySelectorAll<HTMLButtonElement>("button")].some(
			(b) => b.textContent === "Choose calendar" && !b.disabled,
		),
	);
}
async function capture(page: Page, name: string) {
	await page.getByRole("button", { name: "My accounts", exact: true }).focus();
	await page.keyboard.press("Tab");
	const geometry = await page.evaluate(() => ({
		viewport: { width: innerWidth, height: innerHeight },
		theme: getComputedStyle(document.documentElement).colorScheme,
		background: getComputedStyle(document.body).backgroundColor,
		overflow: document.documentElement.scrollWidth > innerWidth,
		targets: [...document.querySelectorAll<HTMLElement>("button")].map(
			(el) => ({
				text: el.textContent,
				width: el.getBoundingClientRect().width,
				height: el.getBoundingClientRect().height,
			}),
		),
		focus: (() => {
			const el = document.activeElement!;
			const style = getComputedStyle(el);
			return {
				text: el.textContent,
				visible: el.matches(":focus-visible"),
				shadow: style.boxShadow,
				outline: style.outlineStyle,
			};
		})(),
	}));
	assert.equal(geometry.overflow, false);
	if (geometry.viewport.width < 640)
		for (const target of geometry.targets) {
			assert(target.width >= 44, JSON.stringify(target));
			assert(target.height >= 44, JSON.stringify(target));
		}
	assert(geometry.focus.visible);
	assert(geometry.focus.shadow !== "none" || geometry.focus.outline !== "none");
	const path = `${output}/${name}.png`;
	const bytes = await page.screenshot({ path, fullPage: true });
	assert.equal(bytes.readUInt32BE(16), geometry.viewport.width);
	assert(bytes.readUInt32BE(20) >= geometry.viewport.height);
	receipts.push({
		name,
		...geometry,
		screenshot: {
			path,
			width: bytes.readUInt32BE(16),
			height: bytes.readUInt32BE(20),
		},
	});
}
try {
	const started = Date.now();
	let ready = false;
	while (Date.now() - started < 90000) {
		if (exited !== undefined)
			throw new Error(`Owned server exited before readiness: ${exited}`);
		try {
			ready = (
				await fetch(`${origin}/browser-tests/b13-calendar-picker-recovery.html`)
			).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "private fixture server readiness timeout");
	await writeFile(
		`${output}/server-readiness.json`,
		JSON.stringify({ origin, ready, elapsedMs: Date.now() - started }),
	);
	browser = await chromium.launch({ headless: true });
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	])
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport,
				colorScheme: theme,
			});
			const page = await context.newPage();
			const errors: string[] = [];
			const consoleErrors: string[] = [];
			const requests: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") consoleErrors.push(message.text());
			});
			let accountsFail = true,
				calendarsFail = true,
				deferred: "accounts" | "calendars" | undefined;
			let release: (() => void) | undefined;
			let waiting = false;
			const waitForRequest = async () => {
				const started = Date.now();
				while (!waiting && Date.now() - started < 15000)
					await page.waitForTimeout(10);
				assert(waiting, "deferred discovery request did not start");
			};
			await page.route("**/*", async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== origin) {
					errors.push(`external request ${url.origin}`);
					return route.abort();
				}
				if (!url.pathname.startsWith("/api/")) return route.continue();
				const read = url.pathname.endsWith("/supportedAccounts")
					? "accounts"
					: url.pathname.endsWith("/listCalendars")
						? "calendars"
						: undefined;
				assert(read, `unexpected provider call ${url.pathname}`);
				requests.push(read);
				const input =
					route.request().method() === "GET"
						? JSON.parse(url.searchParams.get("data") ?? "{}").json
						: route.request().postDataJSON().json;
				if (read === deferred) {
					waiting = true;
					await new Promise<void>((r) => {
						release = r;
					});
					waiting = false;
				}
				if (read === "accounts" ? accountsFail : calendarsFail)
					return route.fulfill({
						status: 503,
						body: "Fictional discovery unavailable",
					});
				const selected = {
					...account,
					connectionScope: input.scope ?? input.connectionScope,
				};
				return route.fulfill({
					json: {
						json:
							read === "accounts"
								? [selected]
								: {
										account: selected,
										calendars: [
											calendar,
											{
												...calendar,
												id: "unreadable",
												name: "Private orchard calendar",
												canRead: false,
											},
										],
									},
					},
				});
			});
			await page.goto(
				`${origin}/browser-tests/b13-calendar-picker-recovery.html?theme=${theme}`,
			);
			await page
				.getByRole("button", { name: "Retry accounts", exact: true })
				.waitFor();
			assert(await page.getByRole("combobox").isDisabled());
			await capture(
				page,
				`${viewport.width}x${viewport.height}-${theme}-accounts-cold-error`,
			);
			accountsFail = false;
			await page
				.getByRole("button", { name: "Retry accounts", exact: true })
				.click();
			await select(page);
			await page
				.getByRole("button", { name: "Retry calendars", exact: true })
				.waitFor();
			await capture(
				page,
				`${viewport.width}x${viewport.height}-${theme}-calendars-cold-error`,
			);
			calendarsFail = false;
			await page
				.getByRole("button", { name: "Retry calendars", exact: true })
				.click();
			await waitEnabled(page);
			assert.equal((await choices(page)).length, 0);
			assert(
				await page
					.getByRole("button", { name: "Choose calendar", exact: true })
					.nth(1)
					.isDisabled(),
			);
			assert(await page.getByText("Read only", { exact: false }).count());
			assert(
				await page
					.getByText("Safe blocker updates unavailable", { exact: false })
					.count(),
			);
			await page.keyboard.press("Tab");
			await capture(
				page,
				`${viewport.width}x${viewport.height}-${theme}-recovered`,
			);
			assert.equal(
				await page.evaluate(
					() => getComputedStyle(document.documentElement).colorScheme,
				),
				theme,
			);
			for (const read of ["accounts", "calendars"] as const) {
				if (read === "accounts") accountsFail = true;
				else calendarsFail = true;
				await page.evaluate(
					(read) => window.calendarFixture.refresh(read),
					read,
				);
				await page
					.getByRole("button", { name: `Retry ${read}`, exact: true })
					.waitFor();
				assert(await chooseButton(page).isDisabled());
				assert(
					await page.getByText(calendar.name, { exact: true }).isVisible(),
				);
				await capture(
					page,
					`${viewport.width}x${viewport.height}-${theme}-${read}-cached-error`,
				);
				if (read === "accounts") accountsFail = false;
				else calendarsFail = false;
				deferred = read;
				await page
					.getByRole("button", { name: `Retry ${read}`, exact: true })
					.click();
				await waitForRequest();
				await page.waitForFunction(
					(label) =>
						[...document.querySelectorAll<HTMLButtonElement>("button")].some(
							(button) => button.textContent === label && button.disabled,
						),
					`Retry ${read}`,
				);
				assert(await chooseButton(page).isDisabled());
				assert(
					await page
						.getByRole("button", { name: `Retry ${read}`, exact: true })
						.isDisabled(),
				);
				deferred = undefined;
				release!();
				await waitEnabled(page);
				assert.equal((await choices(page)).length, 0);
			}
			await page.evaluate(() =>
				window.calendarFixture.setProps({ disabled: true }),
			);
			await page.waitForFunction(() =>
				[...document.querySelectorAll<HTMLButtonElement>("button")]
					.filter((button) => button.textContent === "My accounts")
					.every((button) => button.disabled),
			);
			assert(
				await page
					.getByRole("button", { name: "My accounts", exact: true })
					.isDisabled(),
			);
			assert(
				await page
					.getByRole("button", { name: "Organization accounts", exact: true })
					.isDisabled(),
			);
			assert(await page.getByRole("combobox").isDisabled());
			assert(await chooseButton(page).isDisabled());
			await page.evaluate(() => window.calendarFixture.setProps({}));
			await waitEnabled(page);
			await chooseButton(page).click();
			assert.deepEqual(await choices(page), [{ account, calendar }]);
			for (const change of ["scope", "provider"] as const) {
				if (change === "provider") {
					await page
						.getByRole("button", { name: "My accounts", exact: true })
						.click();
					await select(page);
					await waitEnabled(page);
				}
				deferred = "calendars";
				void page.evaluate(() => window.calendarFixture.refresh("calendars"));
				await waitForRequest();
				if (change === "scope")
					await page
						.getByRole("button", { name: "Organization accounts", exact: true })
						.click();
				else
					await page.evaluate(() =>
						window.calendarFixture.setProps({ providerId: "other-provider" }),
					);
				deferred = undefined;
				release!();
				await page.waitForTimeout(100);
				assert.equal(
					await page
						.getByRole("button", { name: "Choose calendar", exact: true })
						.count(),
					0,
				);
				assert.equal((await choices(page)).length, 1);
			}
			assert.deepEqual(errors, []);
			assert(
				consoleErrors.every((message) => message.includes("503")),
				JSON.stringify(consoleErrors),
			);
			receipts.push({
				viewport,
				theme,
				consoleErrors,
				pageErrors: errors,
				requests,
				selectionCount: (await choices(page)).length,
				passed: true,
			});
			await context.close();
		}
} finally {
	await browser?.close();
	if (exited === undefined) process.kill(-server.pid, "SIGTERM");
	await server.exited;
	await streams;
	await log.end();
	await writeFile(
		`${output}/browser-receipts.json`,
		JSON.stringify({ receipts, serverExit: exited }, null, 2),
	);
}
console.log(
	`Calendar recovery: ${receipts.length} receipts recorded in ${output}`,
);
