import { startFixtureServer } from "./fixture-server";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";

const evidence =
	process.env.B13_FILE_PREVIEW_EVIDENCE ??
	new URL(
		"../node_modules/.cache/tedix-b13-file-preview-identity/",
		import.meta.url,
	).pathname;
await mkdir(evidence, { recursive: true });
const server = await startFixtureServer(
	"/browser-tests/b13-file-preview-identity.html",
);
const { origin } = server;
const receipts: unknown[] = [];
let browser: Browser | undefined;

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const CLIP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LONG_NAME = `fictional-quarterly-review-recording-${"a".repeat(80)}.webm`;
// 1x1 PNG.
const PHOTO_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function fileFixture(workspaceId: string, resourceId: string, sig: number) {
	const media: Record<
		string,
		{ filename: string; mimeType: string; size: number }
	> = {
		[CLIP_A]: { filename: LONG_NAME, mimeType: "video/webm", size: 1234567 },
		[CLIP_B]: {
			filename: "fictional-clip-b.webm",
			mimeType: "video/webm",
			size: 765432,
		},
		[PHOTO]: {
			filename: "fictional-photo.png",
			mimeType: "image/png",
			size: 4321,
		},
	};
	const file = media[resourceId];
	assert(file, `unexpected file read ${workspaceId}/${resourceId}`);
	return {
		...file,
		resourceId,
		url:
			file.mimeType === "image/png"
				? "/media/preview.png"
				: `/media/${resourceId}.webm?sig=${sig}`,
		expiresAt: "2026-10-22T13:00:00.000Z",
	};
}

async function waitVideo(
	page: Page,
	needle: string,
	state: "metadata" | "playing" | "paused",
) {
	await page.waitForFunction(
		({ needleSource, want }) => {
			const video = document.querySelector("video");
			if (!video || !video.src.includes(needleSource)) return false;
			if (want === "metadata") return video.readyState >= 1;
			if (want === "playing") return !video.paused && video.readyState >= 1;
			return video.paused && video.readyState >= 1;
		},
		{ needleSource: needle, want: state },
	);
}

try {
	browser = await chromium.launch({
		headless: true,
		args: ["--autoplay-policy=no-user-gesture-required"],
	});
	for (const viewport of [
		{ width: 375, height: 667 },
		{ width: 390, height: 844 },
		{ width: 1280, height: 900 },
	]) {
		for (const theme of ["light", "dark"] as const) {
			const label = `${viewport.width}x${viewport.height}-${theme}`;
			const context = await browser.newContext({
				viewport,
				colorScheme: theme,
				hasTouch: viewport.width < 640,
				isMobile: viewport.width < 640,
			});
			const page = await context.newPage();
			const consoleEntries: string[] = [];
			page.on("console", (entry) => {
				consoleEntries.push(`${entry.type()}: ${entry.text()}`);
			});
			page.on("pageerror", (error) =>
				consoleEntries.push(`pageerror: ${error.message}`),
			);
			let sig = 1;
			let failReads = false;
			const reads: string[] = [];
			await context.route(
				"**/api/rpc/osWorkspaces/resources/getFile*",
				async (route) => {
					const raw = new URL(route.request().url()).searchParams.get("data");
					const parsed =
						route.request().method() === "GET"
							? JSON.parse(raw ?? "{}")
							: route.request().postDataJSON();
					const input = parsed?.json ?? parsed;
					reads.push(`${input.workspaceId}/${input.resourceId}`);
					if (failReads) {
						await route.abort("failed");
						return;
					}
					await route.fulfill({
						contentType: "application/json",
						body: JSON.stringify({
							json: fileFixture(input.workspaceId, input.resourceId, sig),
						}),
					});
				},
			);
			await context.route("**/media/**", async (route) => {
				if (route.request().url().endsWith("preview.png")) {
					await route.fulfill({
						contentType: "image/png",
						body: PHOTO_BYTES,
					});
					return;
				}
				const base64 = await page.evaluate(
					() => (window as unknown as { __clipBytes?: string }).__clipBytes,
				);
				if (!base64) {
					await route.abort("failed");
					return;
				}
				const bytes = Buffer.from(base64, "base64");
				const range = route.request().headers()["range"];
				const match = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
				if (match) {
					const start = Number(match[1]);
					const end = match[2]
						? Math.min(Number(match[2]), bytes.length - 1)
						: bytes.length - 1;
					await route.fulfill({
						status: 206,
						contentType: "video/webm",
						headers: {
							"Accept-Ranges": "bytes",
							"Content-Range": `bytes ${start}-${end}/${bytes.length}`,
						},
						body: bytes.subarray(start, end + 1),
					});
				} else {
					await route.fulfill({
						status: 200,
						contentType: "video/webm",
						headers: { "Accept-Ranges": "bytes" },
						body: bytes,
					});
				}
			});
			await page.goto(
				`${origin}/browser-tests/b13-file-preview-identity.html?theme=${theme}`,
			);
			await page.waitForSelector("[data-media-ready='1']");
			const video = () => page.locator("video");
			await waitVideo(page, CLIP_A, "metadata");
			assert(reads.includes(`${WORKSPACE_A}/${CLIP_A}`));
			assert.equal(
				await page.locator("a[download]").getAttribute("download"),
				LONG_NAME,
			);
			assert(await page.getByText(LONG_NAME).isVisible());

			// Same-file signed-URL rotation restores position and play intent.
			await page.evaluate(() => document.querySelector("video")!.play());
			await page.waitForFunction(
				() => document.querySelector("video")!.currentTime > 0.35,
			);
			const before = await page.evaluate(
				() => document.querySelector("video")!.currentTime,
			);
			sig = 2;
			await page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("preview-refresh")),
			);
			await waitVideo(page, "sig=2", "metadata");
			const restored = await page.evaluate(
				() => document.querySelector("video")!.currentTime,
			);
			assert(
				restored > 0.05 && restored <= before + 0.5,
				`rotation restored ${restored} from ${before}`,
			);
			await waitVideo(page, "sig=2", "playing");
			await capture(page, `${label}-rotation-playing`);

			// A paused intent also survives rotation.
			await page.evaluate(() => document.querySelector("video")!.pause());
			await waitVideo(page, "sig=2", "paused");
			sig = 3;
			await page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("preview-refresh")),
			);
			await waitVideo(page, "sig=3", "metadata");
			const afterPause = await page.evaluate(
				() => document.querySelector("video")!.currentTime,
			);
			assert(afterPause > 0.05, `paused rotation restored ${afterPause}`);
			assert(
				await page.evaluate(() => document.querySelector("video")!.paused),
			);

			// A different workspace/file starts cold — no position, no autoplay.
			const readsBeforeSwitch = reads.length;
			await page.getByRole("button", { name: "Clip B", exact: true }).click();
			await waitVideo(page, CLIP_B, "metadata");
			assert(reads.some((r) => r === `${WORKSPACE_B}/${CLIP_B}`));
			assert(reads.length > readsBeforeSwitch);
			const transferred = await page.evaluate(
				() => document.querySelector("video")!.currentTime,
			);
			assert(transferred < 0.25, `clip B inherited ${transferred}`);
			assert(
				await page.evaluate(() => document.querySelector("video")!.paused),
				"clip B must not inherit play intent",
			);

			// A non-video selection clears playback for good.
			await page.getByRole("button", { name: "Photo", exact: true }).click();
			await page.locator("img").waitFor();
			assert.equal(await video().count(), 0);
			await page.getByRole("button", { name: "Clip A", exact: true }).click();
			await waitVideo(page, CLIP_A, "metadata");
			const restarted = await page.evaluate(
				() => document.querySelector("video")!.currentTime,
			);
			assert(restarted < 0.25, `clip A restart kept ${restarted}`);
			assert(
				await page.evaluate(() => document.querySelector("video")!.paused),
			);

			// A canonical failure removes media and retries read-only.
			failReads = true;
			await page.evaluate(() =>
				window.dispatchEvent(new CustomEvent("preview-refresh")),
			);
			await page
				.getByText("This file is unavailable or you no longer have access.")
				.waitFor();
			assert.equal(await video().count(), 0);
			assert.equal(await page.locator("img").count(), 0);
			assert.equal(await page.locator("a[download]").count(), 0);
			await capture(page, `${label}-failure`);
			failReads = false;
			await page
				.getByRole("button", { name: "Try again", exact: true })
				.click();
			await waitVideo(page, CLIP_A, "metadata");

			const layout = await page.evaluate(() => {
				const caption = document.querySelector("figcaption span")!;
				const download = document
					.querySelector("a[download]")!
					.getBoundingClientRect();
				return {
					viewport: { width: innerWidth, height: innerHeight },
					theme: getComputedStyle(document.documentElement).colorScheme,
					overflow: document.documentElement.scrollWidth - innerWidth,
					captionWraps: caption.scrollWidth <= caption.clientWidth + 1,
					captionRight: caption.getBoundingClientRect().right,
					download: {
						width: download.width,
						height: download.height,
						right: download.right,
					},
				};
			});
			assert.deepEqual(layout.viewport, {
				width: viewport.width,
				height: viewport.height,
			});
			assert.equal(layout.theme, theme);
			assert(layout.overflow <= 1, `page overflow ${layout.overflow}`);
			assert(layout.captionWraps, "long filename wraps");
			assert(
				layout.download.right <= viewport.width,
				"download stays in viewport",
			);
			if (viewport.width < 640)
				assert(
					layout.download.width >= 44 && layout.download.height >= 44,
					`44px download target ${JSON.stringify(layout.download)}`,
				);
			receipts.push({ label, reads, layout });
			assert(
				!consoleEntries.some(
					(line) =>
						line.startsWith("pageerror:") ||
						(line.startsWith("error:") && !line.includes("net::ERR_FAILED")),
				),
				consoleEntries.join("\n"),
			);
			await context.close();
		}
	}
	console.log(
		`PASS: file preview playback stays scoped to the selected file across URL rotation, switches, non-video transitions and failures (Chromium, ${receipts.length} viewport/theme combinations, evidence in ${evidence})`,
	);
} finally {
	await writeFile(
		`${evidence}/measurements.json`,
		JSON.stringify(receipts, null, 2),
	);
	await browser?.close();
	await server.stop();
}

async function capture(page: Page, name: string) {
	const png = await page.screenshot({ path: `${evidence}/${name}.png` });
	const viewport = page.viewportSize()!;
	assert.equal(png.readUInt32BE(16), viewport.width);
	assert.equal(png.readUInt32BE(20), viewport.height);
}
