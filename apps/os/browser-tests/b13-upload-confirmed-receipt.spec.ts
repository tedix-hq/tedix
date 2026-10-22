import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

const directory =
	process.env.STATE_GALLERY_SCREENSHOTS ?? "/tmp/b13-upload-confirmed-receipt";
await mkdir(directory, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/b13-upload-confirmed-receipt.html",
);
const url = `${server.origin}/browser-tests/b13-upload-confirmed-receipt.html`;
const report: unknown[] = [];
const errors: string[] = [];
const consoleEvents: { text: string; type: string; expected: boolean }[] = [];
const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";

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

async function launch(): Promise<Browser> {
	try {
		return await chromium.launch({ headless: true });
	} catch {
		// Sessions whose sandbox denies Mach service registration can only run
		// the browser single-process; each combo gets a fresh launch either way.
		return await chromium.launch({
			headless: true,
			args: ["--single-process"],
		});
	}
}

try {
	for (const theme of ["light", "dark"] as const)
		for (const size of [
			{ width: 375, height: 667 },
			{ width: 390, height: 844 },
			{ width: 1280, height: 900 },
		]) {
			const browser = await launch();
			try {
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
				const requests = {
					uploads: [] as { workspaceId: string; filename: string }[],
					confirms: 0,
					parts: 0,
					reads: { resources: 0, outputs: 0, library: 0 },
				};
				let confirmGate: Promise<void> | undefined;
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
					if (endpoint.endsWith("/resources/requestFileUpload")) {
						requests.uploads.push({
							workspaceId: input.workspaceId,
							filename: input.filename,
						});
						json = {
							resourceId: "file-1",
							expiresAt: "2026-10-22T12:15:00.000Z",
							partSize: input.size,
							parts: [
								{
									partNumber: 1,
									size: input.size,
									url: `${server.origin}/upload-part`,
								},
							],
						};
					} else if (endpoint.endsWith("/resources/confirmFileUpload")) {
						requests.confirms++;
						if (confirmGate) {
							const gate = confirmGate;
							confirmGate = undefined;
							await gate;
						}
						json = {
							outputId: `output-${requests.confirms}`,
							resource: { name: requests.uploads.at(-1)?.filename },
						};
					} else if (endpoint.endsWith("/resources/list")) {
						requests.reads.resources++;
						json = { items: [], truncated: false };
					} else if (endpoint.endsWith("/outputs/library")) {
						requests.reads.library++;
						json = { items: [], truncated: false };
					} else if (endpoint.endsWith("/outputs/list")) {
						requests.reads.outputs++;
						json = { items: [], truncated: false };
					} else throw new Error(`Unexpected local request ${endpoint}`);
					await route.fulfill({
						contentType: "application/json",
						body: JSON.stringify({ json }),
					});
				});
				// Every signed part PUT is intercepted locally too.
				await page.route("**/upload-part", async (route) => {
					requests.parts++;
					await route.fulfill({
						contentType: "application/json",
						body: JSON.stringify({ partNumber: 1, etag: "part-etag" }),
					});
				});
				const label = `${size.width}x${size.height}-${theme}`;
				// The first reader refresh round (three invalidations) rejects; the
				// deferred retry round succeeds.
				await page.goto(`${url}?theme=${theme}&rejectReconciliation=3`);
				const file = page.locator('input[type="file"]');
				await file.setInputFiles({
					name: "supplier-terms.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("supplier terms payload"),
				});
				await page
					.getByText("Uploaded supplier-terms.txt", { exact: true })
					.waitFor();
				const receipt = page.getByRole("link", {
					name: "Open output",
					exact: true,
				});
				assert.equal(await receipt.getAttribute("href"), "/outputs/output-1");
				await page.waitForFunction(
					() =>
						(
							window as unknown as {
								__reconciliation: { attempts: number };
							}
						).__reconciliation.attempts >= 6,
				);
				assert.equal(requests.uploads.length, 1);
				assert.equal(requests.uploads[0]!.workspaceId, WORKSPACE_A);
				assert.equal(requests.confirms, 1);
				assert.equal(requests.parts, 1);
				assert.equal(requests.reads.resources, 2);
				assert.equal(requests.reads.outputs, 2);
				assert.equal(requests.reads.library, 2);
				assert.equal(await page.getByText("failed").count(), 0);
				assert(
					await page
						.getByRole("button", { name: "Upload file", exact: true })
						.isEnabled(),
				);
				await capture(
					page,
					`${label}-confirmed-receipt`,
					"Upload file",
					size.width,
					size.height,
					theme,
				);
				// A workspace switch mid-confirm fences completion and reconciliation.
				let releaseConfirm!: () => void;
				confirmGate = new Promise<void>((resolve) => {
					releaseConfirm = resolve;
				});
				await file.setInputFiles({
					name: "appendix.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("appendix payload"),
				});
				for (let attempt = 0; requests.confirms < 2 && attempt < 500; attempt++)
					await Bun.sleep(10);
				assert.equal(requests.confirms, 2, "local confirm request started");
				await page.evaluate(
					(workspace) =>
						window.dispatchEvent(
							new CustomEvent("upload-switch-workspace", {
								detail: workspace,
							}),
						),
					WORKSPACE_B,
				);
				releaseConfirm();
				await Bun.sleep(300);
				assert.equal(requests.confirms, 2);
				assert.equal(
					await page.evaluate(
						() =>
							(
								window as unknown as {
									__reconciliation: { attempts: number };
								}
							).__reconciliation.attempts,
					),
					6,
				);
				assert.equal(
					await page.getByText("Uploaded", { exact: false }).count(),
					0,
				);
				// A fresh upload on the new workspace reconciles and confirms normally.
				await file.setInputFiles({
					name: "appendix.txt",
					mimeType: "text/plain",
					buffer: Buffer.from("appendix payload"),
				});
				await page
					.getByText("Uploaded appendix.txt", { exact: true })
					.waitFor();
				assert.equal(
					await page
						.getByRole("link", { name: "Open output", exact: true })
						.getAttribute("href"),
					"/outputs/output-3",
				);
				assert.equal(requests.uploads.length, 3);
				assert.equal(requests.uploads[2]!.workspaceId, WORKSPACE_B);
			} finally {
				await browser.close();
			}
		}
	assert.deepEqual(errors, []);
} finally {
	await Bun.write(
		`${directory}/measurements.json`,
		JSON.stringify({ report, errors, consoleEvents }, null, 2),
	);
	await server.stop();
}
console.log(
	`Upload confirmed-receipt browser checks passed; ${report.length} dimension-checked screenshots in ${directory}`,
);
