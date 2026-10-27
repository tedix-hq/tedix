import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * Workspace icon at phone and desktop widths in both themes: the Edit
 * workspace control uploads an SVG, the tile switches from initials to the
 * image, Remove brings the initials back, and an unsupported file is refused
 * before any request.
 */
const path = "/browser-tests/workspace-icon.html";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#FF4500"/></svg>';
const server = await startFixtureServer(path);
const browser = await chromium.launch({ headless: true });
const directory =
	process.env.TEDIX_BROWSER_ARTIFACTS_DIR ?? "/tmp/tedix-workspace-icon";
await mkdir(directory, { recursive: true });
const svgFile = `${directory}/icon.svg`;
const textFile = `${directory}/notes.txt`;
await writeFile(svgFile, SVG);
await writeFile(textFile, "not an image");

async function mockApi(page: Page) {
	const calls: Record<string, unknown[]> = {};
	const workspace = {
		id: WORKSPACE_ID,
		organizationId: "org-fictional",
		name: "Reddit research",
		description: null,
		status: "active",
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		createdByKind: "user",
		createdById: "member-robin",
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		visibility: "org",
		ownerUserId: null,
		iconUrl: null as string | null,
	};
	await page.route("**/api/**", async (route) => {
		const request = route.request();
		const endpoint = new URL(request.url()).pathname.split("/").pop() ?? "";
		const raw =
			request.method() === "GET"
				? JSON.parse(new URL(request.url()).searchParams.get("data") ?? "{}")
				: request.postDataJSON();
		const input = raw?.json ?? raw;
		(calls[endpoint] ??= []).push(input);
		if (endpoint === "setIcon") {
			workspace.iconUrl = `data:${input.contentType};base64,${input.fileData}`;
		} else if (endpoint === "removeIcon") {
			workspace.iconUrl = null;
		} else if (endpoint !== "get") {
			return route.fulfill({ status: 404, json: {} });
		}
		return route.fulfill({ json: { json: { workspace } } });
	});
	return calls;
}

let cases = 0;
const started = performance.now();
try {
	for (const width of [375, 1280]) {
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 720 },
				colorScheme: theme,
			});
			const calls = await mockApi(page);
			await page.goto(`${server.origin}${path}?theme=${theme}`);
			const field = page.getByTestId("workspace-icon-field");
			const tile = page.getByTestId("breadcrumb");
			await field.getByText("Workspace icon").waitFor();
			assert.equal(await tile.locator("img").count(), 0);
			assert.equal((await tile.textContent())?.includes("RR"), true);
			assert.equal(
				await field.getByRole("button", { name: "Remove" }).count(),
				0,
			);

			await page.getByLabel("Upload workspace icon").setInputFiles(textFile);
			await field.getByText("Choose a PNG, JPEG, WebP or SVG image.").waitFor();
			assert.equal(calls.setIcon, undefined);

			await page.getByLabel("Upload workspace icon").setInputFiles(svgFile);
			await tile.locator("img").waitFor();
			assert.deepEqual(calls.setIcon, [
				{
					workspaceId: WORKSPACE_ID,
					contentType: "image/svg+xml",
					fileData: Buffer.from(SVG).toString("base64"),
				},
			]);
			await field.getByRole("button", { name: "Remove" }).waitFor();
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - innerWidth,
			);
			assert(overflow <= 1, `${width} ${theme} overflows by ${overflow}px`);
			await page.screenshot({
				path: `${directory}/icon-${width}-${theme}.png`,
			});

			await field.getByRole("button", { name: "Remove" }).click();
			await page.waitForFunction(
				() =>
					!document.querySelector('[data-testid="breadcrumb"] img') &&
					document
						.querySelector('[data-testid="breadcrumb"]')
						?.textContent?.includes("RR"),
			);
			assert.equal(calls.removeIcon?.length, 1);
			await page.close();
			cases++;
			console.log(`PASS workspace icon ${width}px ${theme}`);
		}
	}
} finally {
	await browser.close();
	await server.stop();
}
console.log(
	`${cases} workspace icon cases in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
