import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";

const directory = await mkdtemp(
	join(tmpdir(), "tedix-workspace-library-recovery-"),
);
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}/browser-tests/b13-workspace-library-recovery.html`;
const log = Bun.file(`${directory}/server.log`);
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
const longName =
	"Quarterly supplier onboarding and contract renewals with a very long workspace title";
const workspaces: OsWorkspace[] = Array.from({ length: 18 }, (_, index) => ({
	id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
	organizationId: "org-fictional",
	name: index === 0 ? longName : `Workspace ${index + 1}`,
	description:
		"Supplier review and reporting https://example.test/" +
		"long-path-".repeat(12),
	status: "active",
	sourceBlueprintId: null,
	sourceBlueprintRevisionId: null,
	sourceBlueprintRevisionNumber: null,
	instantiationPreflight: null,
	rollbackReference: null,
	blueprintDecision: null,
	createdByKind: "user",
	createdById: "user-fictional",
	createdAt: "2026-10-01T12:00:00.000Z",
	updatedAt: "2026-10-01T12:00:00.000Z",
	visibility: index === 0 ? "private" : "org",
	ownerUserId: index === 0 ? "user-fictional" : null,
}));

async function refresh(page: Page, kind: string) {
	await page.evaluate(
		(detail) =>
			window.dispatchEvent(new CustomEvent("library-refresh", { detail })),
		kind,
	);
}
async function capture(
	page: Page,
	label: string,
	targetName: string,
	width: number,
	height: number,
	theme: string,
) {
	const target = page.getByRole("button", { name: targetName, exact: true });
	await target.focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	const measurements = await page.evaluate(() => {
		const focused = document.activeElement as HTMLElement;
		const rectangle = focused.getBoundingClientRect();
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
				outlineWidth: style.outlineWidth,
				shadow: style.boxShadow,
				width: rectangle.width,
				height: rectangle.height,
			},
			targets,
		};
	});
	assert.deepEqual(measurements.viewport, { width, height });
	assert.equal(measurements.theme, theme);
	assert(measurements.overflow <= 1, JSON.stringify(measurements));
	assert(measurements.focus.visible, JSON.stringify(measurements));
	assert(
		measurements.focus.outlineStyle !== "none" ||
			measurements.focus.shadow !== "none",
		"focus has visible styling",
	);
	if (width < 640)
		for (const target of measurements.targets)
			assert(target.width >= 44 && target.height >= 44, JSON.stringify(target));
	await page.evaluate(() => scrollTo(0, 0));
	const bytes = await page.screenshot({ path: `${directory}/${label}.png` });
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
		`${directory}/server-readiness.json`,
		JSON.stringify({
			origin,
			ready,
			pid: server.pid,
			exitCode: server.exitCode,
		}),
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
			let preferencesFail = true;
			let activeFail = false;
			let archiveFail = true;
			let favoriteWrites = 0;
			let restoreWrites = 0;
			const reads = { active: 0, archived: 0, preferences: 0 };
			let favoriteValue = false;
			let holdFavorite: (() => void) | undefined;
			let holdRestore: (() => void) | undefined;
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
				let fail = false;
				if (endpoint.endsWith("/workspacePreferences/list")) {
					reads.preferences++;
					fail = preferencesFail;
					json = {
						items: [
							{
								workspaceId: workspaces[0]!.id,
								favorite: favoriteValue,
								lastOpenedAt: null,
								updatedAt: "2026-10-21T12:00:00.000Z",
							},
						],
					};
				} else if (endpoint.endsWith("/osCollaborators/listShared")) {
					json = { items: [] };
				} else if (endpoint.endsWith("/workspaces/list")) {
					const archived = input.status === "archived";
					reads[archived ? "archived" : "active"]++;
					fail = archived ? archiveFail : activeFail;
					json = {
						items: archived
							? [{ ...workspaces[0], status: "archived" }]
							: workspaces,
						truncated: true,
					};
				} else if (endpoint.endsWith("/workspacePreferences/setFavorite")) {
					favoriteWrites++;
					await new Promise<void>((resolve) => {
						holdFavorite = resolve;
					});
					favoriteValue = input.favorite;
					json = {
						preference: {
							workspaceId: input.workspaceId,
							favorite: favoriteValue,
							lastOpenedAt: null,
							updatedAt: "2026-10-21T12:00:00.000Z",
						},
					};
				} else if (endpoint.endsWith("/workspaces/restore")) {
					restoreWrites++;
					await new Promise<void>((resolve) => {
						holdRestore = resolve;
					});
					json = { workspace: workspaces[0] };
				} else throw new Error(`Unexpected local request ${endpoint}`);
				// Every API request is intercepted locally, including injected network failures.
				if (fail) await route.abort("failed");
				else
					await route.fulfill({
						contentType: "application/json",
						body: JSON.stringify({ json }),
					});
			});
			const label = `${size.width}x${size.height}-${theme}`;
			await page.goto(`${url}?theme=${theme}&rejectReconciliation=1`);
			await page
				.getByText("Favorites are unavailable", { exact: true })
				.waitFor();
			assert.equal(
				await page
					.getByRole("link", { name: new RegExp(longName) })
					.getAttribute("href"),
				`/workspace/${workspaces[0]!.id}`,
			);
			assert(
				await page
					.getByRole("button", {
						name: `Favorites unavailable for ${longName}`,
						exact: true,
					})
					.isDisabled(),
			);
			assert(await page.getByText("Only you", { exact: true }).isVisible());
			assert.equal(
				await page.locator('ul[aria-label="Workspaces"] > li').count(),
				15,
			);
			await capture(
				page,
				`${label}-preferences-unavailable`,
				"Retry favorites",
				size.width,
				size.height,
				theme,
			);
			preferencesFail = false;
			const discoveryBefore = reads.active;
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await page
				.getByRole("button", {
					name: `Add ${longName} to favorites`,
					exact: true,
				})
				.waitFor();
			assert.equal(reads.active, discoveryBefore);
			await page
				.getByRole("button", { name: "Show more", exact: true })
				.click();
			assert.equal(
				await page.locator('ul[aria-label="Workspaces"] > li').count(),
				18,
			);
			await page
				.getByRole("searchbox", { name: "Search workspaces" })
				.fill("Workspace");
			assert.equal(
				await page.locator('ul[aria-label="Workspaces"] > li').count(),
				15,
			);
			await page.getByRole("searchbox", { name: "Search workspaces" }).fill("");
			activeFail = true;
			await refresh(page, "active");
			await page
				.getByText("Workspaces could not refresh", { exact: true })
				.waitFor();
			assert.equal(
				await page.locator('ul[aria-label="Workspaces"] > li').count(),
				15,
			);
			await capture(
				page,
				`${label}-active-cached`,
				"Retry workspaces",
				size.width,
				size.height,
				theme,
			);
			activeFail = false;
			const prefsBefore = reads.preferences;
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await page
				.getByText("Workspaces could not refresh", { exact: true })
				.waitFor({ state: "hidden" });
			assert.equal(reads.preferences, prefsBefore);
			await page
				.getByRole("button", {
					name: `Add ${longName} to favorites`,
					exact: true,
				})
				.click();
			await page.getByText("Saving favorite…", { exact: true }).waitFor();
			assert(
				await page
					.getByRole("button", {
						name: `Add ${longName} to favorites`,
						exact: true,
					})
					.isDisabled(),
			);
			for (let attempt = 0; !holdFavorite && attempt < 500; attempt++)
				await Bun.sleep(10);
			assert(holdFavorite, "local favorite request started");
			holdFavorite();
			await page
				.getByText("Favorite saved; favorites could not refresh", {
					exact: true,
				})
				.waitFor();
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await page
				.getByRole("button", {
					name: `Remove ${longName} from favorites`,
					exact: true,
				})
				.waitFor();
			assert.equal(favoriteWrites, 1);
			await page.getByRole("button", { name: "Archived", exact: true }).click();
			await page
				.getByText("Archived workspaces are unavailable", { exact: true })
				.waitFor();
			await capture(
				page,
				`${label}-archive-unavailable`,
				"Retry archived workspaces",
				size.width,
				size.height,
				theme,
			);
			archiveFail = false;
			const activeBefore = reads.active;
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await page
				.getByRole("button", { name: `Restore ${longName}`, exact: true })
				.waitFor();
			assert.equal(reads.active, activeBefore);
			archiveFail = true;
			await refresh(page, "archived");
			await page
				.getByText("Archived workspaces could not refresh", { exact: true })
				.waitFor();
			assert(await page.getByText(longName, { exact: true }).isVisible());
			await capture(
				page,
				`${label}-archive-cached`,
				"Retry archived workspaces",
				size.width,
				size.height,
				theme,
			);
			archiveFail = false;
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			await page
				.getByRole("button", { name: `Restore ${longName}`, exact: true })
				.waitFor({ state: "visible" });
			await page
				.getByRole("button", { name: `Restore ${longName}`, exact: true })
				.click();
			await page.waitForFunction(
				() =>
					document.querySelector<HTMLButtonElement>('[aria-label^="Restore "]')
						?.disabled,
			);
			for (let attempt = 0; !holdRestore && attempt < 500; attempt++)
				await Bun.sleep(10);
			assert(holdRestore, "local restore request started");
			holdRestore();
			await page
				.getByText(
					"Workspace restored; some workspace lists could not refresh",
					{ exact: true },
				)
				.waitFor();
			assert.equal(
				await page.getByText("No archived workspaces", { exact: true }).count(),
				0,
			);
			assert.equal(
				await page
					.getByText("Showing the first 0 archived workspaces.", {
						exact: true,
					})
					.count(),
				0,
			);
			await capture(
				page,
				`${label}-restore-confirmed`,
				"Retry archived workspaces",
				size.width,
				size.height,
				theme,
			);
			await page.getByRole("button", { name: "Retry", exact: true }).click();
			assert.equal(restoreWrites, 1);
			assert.equal(
				await page
					.getByRole("button", { name: `Restore ${longName}`, exact: true })
					.count(),
				0,
			);
			await page.close();
		}
	assert.deepEqual(errors, []);
} finally {
	await Bun.write(
		`${directory}/measurements.json`,
		JSON.stringify({ report, errors, consoleEvents }, null, 2),
	);
	await browser?.close();
	if (server.exitCode === null) process.kill(-server.pid, "SIGTERM");
	const exitCode = await server.exited;
	await Bun.write(
		`${directory}/server-exit.json`,
		JSON.stringify({ pid: server.pid, exitCode }),
	);
}
console.log(
	`Workspace recovery browser checks passed; ${report.length} dimension-checked screenshots in ${directory}`,
);
