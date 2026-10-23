import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { PersonalResourceDelegationSchema } from "@tedix/api-contract/schemas/personal-resource-delegations";
import type { z } from "zod";

const candidates = [
	process.env.B13_PERSONAL_ACCESS_EVIDENCE_DIR,
	process.env.TEDIX_LANE_LOG
		? join(
				dirname(process.env.TEDIX_LANE_LOG),
				"b13-personal-access-read-fence",
			)
		: undefined,
	join(
		new URL("../", import.meta.url).pathname,
		"node_modules/.cache/b13-personal-access-read-fence",
	),
	"/tmp/b13-personal-access-read-fence",
].filter((value): value is string => Boolean(value));
let evidence: string | undefined;
for (const candidate of candidates)
	try {
		await mkdir(candidate, { recursive: true });
		evidence = candidate;
		break;
	} catch {}
assert(evidence, "no writable evidence directory");
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}/browser-tests/b13-personal-access-read-fence.html`;
const log = Bun.file(`${evidence}/server.log`);
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--strictPort",
	],
	{
		cwd: new URL("../", import.meta.url).pathname,
		env: {
			...process.env,
			TEDIX_OS_LOCAL_DEV: "0",
			TEDIX_OS_REMOTE_DEV: "0",
			VITE_LIVE_API: "0",
			TEDIX_LOCAL_API_PROXY_URL: "",
		},
		stdout: log,
		stderr: log,
		detached: true,
	},
);
let browser: Browser | undefined;
const report: unknown[] = [];
const errors: string[] = [];
const consoleEvents: { text: string; type: string; expected: boolean }[] = [];

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
type Grant = z.infer<typeof PersonalResourceDelegationSchema>;
const grant: Grant = {
	id: "66666666-6666-4666-8666-666666666666",
	organizationId: "fictional-org",
	tediId: "77777777-7777-4777-8777-777777777777",
	skillId: "88888888-8888-4888-8888-888888888888",
	skillRevision: 1,
	connectionInstanceId: "33333333-3333-4333-8333-333333333333",
	ownerUserId: "fictional-owner",
	providerId: "sample-mail",
	resourceType: "mailbox",
	providerResourceId: "sample-mailbox",
	requiredScopes: [],
	toolIds: ["read_mail"],
	createdAt: "2026-01-01T00:00:00.000Z",
	workspaceId: WORKSPACE_ID,
	resourceId: RESOURCE_ID,
	operations: ["read"],
	revokedAt: null,
	expiresAt: "2099-01-01T00:00:00.000Z",
};
const hundred: Grant[] = Array.from({ length: 100 }, (_, index) => ({
	...grant,
	id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
}));
const unverified = "Access could not be verified.";
const comboboxName = "Access for this workspace's skills";

async function refresh(page: Page) {
	await page.evaluate(() =>
		window.dispatchEvent(new CustomEvent("access-refresh")),
	);
}
async function settled(page: Page) {
	await page.waitForFunction(
		() =>
			(
				globalThis as { accessReadsPending?: () => number }
			).accessReadsPending?.() === 0,
	);
}
const listRead = (page: Page) =>
	page.waitForResponse((response) =>
		response.url().includes("/personalResourceDelegations/list"),
	);
async function capture(
	page: Page,
	label: string,
	targetName: string | undefined,
	width: number,
	height: number,
	theme: string,
) {
	if (targetName) {
		const target = page
			.getByRole("button", { name: targetName, exact: true })
			.or(page.getByRole("combobox", { name: targetName, exact: true }));
		await target.focus();
		await page.keyboard.press("Tab");
		await page.keyboard.press("Shift+Tab");
	}
	const measurements = await page.evaluate(() => {
		const focused = document.activeElement as HTMLElement;
		const style = getComputedStyle(focused);
		const targets = [...document.querySelectorAll<HTMLElement>("button")]
			.filter((element) => element.offsetParent !== null)
			.map((element) => {
				const bounds = element.getBoundingClientRect();
				return {
					name: element.getAttribute("aria-label") ?? element.textContent,
					width: bounds.width,
					height: bounds.height,
				};
			});
		return {
			viewport: { width: innerWidth, height: innerHeight },
			theme: getComputedStyle(document.documentElement).colorScheme,
			surface: getComputedStyle(document.body).backgroundColor,
			overflow: document.documentElement.scrollWidth - innerWidth,
			focus: {
				name: focused.getAttribute("aria-label") ?? focused.textContent,
				visible: focused.matches(":focus-visible"),
				outlineStyle: style.outlineStyle,
				shadow: style.boxShadow,
			},
			targets,
		};
	});
	assert.deepEqual(measurements.viewport, { width, height });
	assert.equal(measurements.theme, theme);
	assert(measurements.overflow <= 1, JSON.stringify(measurements));
	if (targetName) {
		assert(measurements.focus.visible, JSON.stringify(measurements));
		assert(
			measurements.focus.outlineStyle !== "none" ||
				measurements.focus.shadow !== "none",
			"focus has visible styling",
		);
	}
	if (width < 640)
		for (const target of measurements.targets)
			assert(target.width >= 44 && target.height >= 44, JSON.stringify(target));
	await page.evaluate(() => scrollTo(0, 0));
	const bytes = await page.screenshot({ path: `${evidence}/${label}.png` });
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	assert.equal(view.getUint32(16), width);
	assert.equal(view.getUint32(20), height);
	report.push({
		label,
		...measurements,
		screenshot: { width: view.getUint32(16), height: view.getUint32(20) },
	});
}

try {
	browser = await chromium.launch({ headless: true });
	let ready = false;
	for (let attempt = 0; attempt < 120; attempt++) {
		if (server.exitCode !== null)
			throw new Error(`Owned server exited ${server.exitCode}; see server.log`);
		try {
			if ((await fetch(url)).ok) {
				ready = true;
				break;
			}
		} catch {}
		await Bun.sleep(250);
	}
	assert(ready, "Owned ephemeral server readiness timed out; see server.log");
	await Bun.write(
		`${evidence}/server-readiness.json`,
		JSON.stringify({ origin, ready, pid: server.pid }),
	);
	for (const theme of ["light", "dark"] as const)
		for (const size of [
			{ width: 375, height: 667 },
			{ width: 390, height: 844 },
			{ width: 1280, height: 900 },
		]) {
			const page = await browser.newPage({
				viewport: size,
				colorScheme: theme,
				reducedMotion: "reduce",
				hasTouch: size.width < 640,
				isMobile: size.width < 640,
			});
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				const expected = message.text().includes("net::ERR_FAILED");
				consoleEvents.push({
					text: message.text(),
					type: message.type(),
					expected,
				});
				if (message.type() === "error" && !expected)
					errors.push(message.text());
			});
			let mode: "hold" | "fail" | "ok" = "fail";
			let grants: Grant[] = [];
			let holdList: (() => void) | undefined;
			let holdSet: (() => void) | undefined;
			const reads = { list: 0, set: 0 };
			await page.route("**/api/**", async (route) => {
				const request = route.request();
				const endpoint = new URL(request.url()).pathname;
				const raw =
					request.method() === "GET"
						? JSON.parse(
								new URL(request.url()).searchParams.get("data") ?? "{}",
							)
						: request.postDataJSON();
				const input = raw?.json ?? raw;
				let json: unknown;
				if (endpoint.endsWith("/personalResourceDelegations/list")) {
					reads.list++;
					if (mode === "hold")
						await new Promise<void>((resolve) => {
							holdList = resolve;
						});
					else if (mode === "fail") {
						await route.abort("failed");
						return;
					}
					json = grants;
				} else if (
					endpoint.endsWith("/setPersonalAccess") ||
					endpoint.endsWith("/personal-access")
				) {
					reads.set++;
					await new Promise<void>((resolve) => {
						holdSet = resolve;
					});
					json = { level: input.level ?? "read", skills: [] };
				} else throw new Error(`Unexpected local request ${endpoint}`);
				// Every API request is intercepted locally, including injected failures.
				await route.fulfill({
					contentType: "application/json",
					body: JSON.stringify({ json }),
				});
			});
			const label = `${size.width}x${size.height}-${theme}`;
			const combobox = page.getByRole("combobox", {
				name: comboboxName,
				exact: true,
			});
			// Cold rejection: the read failed, so access is unverified — no
			// "No access" claim and no way to change it.
			await page.goto(`${url}?theme=${theme}`);
			await page.getByText(unverified, { exact: true }).waitFor();
			assert.equal(await combobox.count(), 0);
			assert.equal(await page.getByText("No access").count(), 0);
			await capture(
				page,
				`${label}-unverified`,
				"Retry access",
				size.width,
				size.height,
				theme,
			);
			// Cold pending: the read is still out, so access is unknown — the
			// fence shows a checking state and no selector.
			mode = "hold";
			await page.goto(`${url}?theme=${theme}`);
			await page.getByText("Checking access…", { exact: true }).waitFor();
			assert.equal(await combobox.count(), 0);
			assert.equal(await page.getByText("No access").count(), 0);
			await capture(
				page,
				`${label}-pending`,
				undefined,
				size.width,
				size.height,
				theme,
			);
			for (let attempt = 0; !holdList && attempt < 500; attempt++)
				await Bun.sleep(10);
			assert(holdList, "held list read started");
			mode = "ok";
			grants = [grant];
			holdList();
			await combobox.waitFor();
			assert((await combobox.textContent())?.includes("Read"));
			// A complete empty read is verified: "No access" is truthful and the
			// selector is enabled.
			grants = [];
			await Promise.all([listRead(page), refresh(page)]);
			await page.waitForFunction(() =>
				document
					.querySelector('[role="combobox"]')
					?.textContent?.includes("No access"),
			);
			assert(await combobox.isEnabled());
			// A failed refresh of cached grants goes back to unverified even
			// though a verified value is still in the cache.
			mode = "fail";
			await Promise.all([
				page.waitForRequest("**/personalResourceDelegations/list"),
				refresh(page),
			]);
			await page.getByText(unverified, { exact: true }).waitFor();
			assert.equal(await combobox.count(), 0);
			assert.equal(await page.getByText("No access").count(), 0);
			// A bounded read that fills the limit is ambiguous: the same
			// unverified state must survive the retry, not claim "Read".
			mode = "ok";
			grants = hundred;
			const listsBefore = reads.list;
			await Promise.all([
				listRead(page),
				page.getByRole("button", { name: "Retry access", exact: true }).click(),
			]);
			assert.equal(reads.list, listsBefore + 1);
			await settled(page);
			assert.equal(await combobox.count(), 0);
			assert(await page.getByText(unverified, { exact: true }).isVisible());
			await capture(
				page,
				`${label}-ambiguous`,
				"Retry access",
				size.width,
				size.height,
				theme,
			);
			// Retry recovery: a verified read restores the real level.
			grants = [grant];
			await Promise.all([
				listRead(page),
				page.getByRole("button", { name: "Retry access", exact: true }).click(),
			]);
			await page.waitForFunction(() =>
				document
					.querySelector('[role="combobox"]')
					?.textContent?.includes("Read"),
			);
			await capture(
				page,
				`${label}-verified`,
				comboboxName,
				size.width,
				size.height,
				theme,
			);
			// A pending change shows the chosen level and cannot be re-changed.
			await combobox.click();
			await page
				.getByRole("option", { name: /organise/, exact: false })
				.click();
			for (let attempt = 0; !holdSet && attempt < 500; attempt++)
				await Bun.sleep(10);
			assert(holdSet, "held access change started");
			assert.equal(reads.set, 1);
			await page.waitForFunction(
				() =>
					(document.querySelector('[role="combobox"]') as HTMLButtonElement)
						?.disabled,
			);
			assert(
				(await combobox.textContent())?.includes("organise"),
				"pending change shows the chosen level",
			);
			const listsAtSave = reads.list;
			holdSet();
			for (
				let attempt = 0;
				reads.list === listsAtSave && attempt < 500;
				attempt++
			)
				await Bun.sleep(10);
			assert(
				reads.list > listsAtSave,
				"the saved change invalidated the grants read",
			);
			await settled(page);
			await page.waitForFunction(
				() =>
					document
						.querySelector('[role="combobox"]')
						?.textContent?.includes("Read") &&
					!(document.querySelector('[role="combobox"]') as HTMLButtonElement)
						?.disabled,
			);
			assert.equal(reads.set, 1);
			await page.close();
		}
	assert.deepEqual(errors, []);
} finally {
	await Bun.write(
		`${evidence}/measurements.json`,
		JSON.stringify({ report, errors, consoleEvents }, null, 2),
	);
	await browser?.close();
	if (server.exitCode === null) process.kill(-server.pid, "SIGTERM");
	const exitCode = await server.exited;
	await Bun.write(
		`${evidence}/server-exit.json`,
		JSON.stringify({ pid: server.pid, exitCode }),
	);
}
console.log(
	`Personal access read-fence checks passed; ${report.length} dimension-checked screenshots in ${evidence}`,
);
