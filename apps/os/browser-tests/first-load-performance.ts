/**
 * Cold first-load measurements, using a fresh unauthenticated browser per sample.
 * Run the fixture dev server first. PERF_ASSETS_ROOT optionally serves a built
 * SPA while proxying its API calls to PERF_FIXTURES_ORIGIN (loopback only).
 * PERF_COMPRESS=1 mirrors gzip asset delivery; omit it for the legacy raw server.
 * PERF_TARGET selects one route. --live never imports a browser profile.
 */
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { startFixtureServer } from "./fixture-server";

const origin = process.env.PERF_ORIGIN ?? "http://127.0.0.1:3010";
const output = process.env.PERF_OUTPUT ?? "/tmp/os-first-load.json";
const samples = Number(process.env.PERF_SAMPLES ?? 5);
const assets = process.env.PERF_ASSETS_ROOT;
const viewport = {
	width: Number(process.env.PERF_VIEWPORT_WIDTH ?? 1440),
	height: Number(process.env.PERF_VIEWPORT_HEIGHT ?? 1000),
};
const downloadThroughput = Number(
	process.env.PERF_DOWNLOAD_THROUGHPUT ?? 1_250_000,
);
const cpuThrottlingRate = Number(process.env.PERF_CPU_THROTTLING_RATE ?? 4);
const fixtureServer = process.env.PERF_START_FIXTURES
	? await startFixtureServer("/", { stdout: "ignore", stderr: "ignore" })
	: undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
if (assets) {
	const fixtures = new URL(
		fixtureServer?.origin ??
			process.env.PERF_FIXTURES_ORIGIN ??
			"http://127.0.0.1:3010",
	);
	if (fixtures.hostname !== "127.0.0.1")
		throw new Error("Fixture proxy must use loopback.");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: Number(new URL(origin).port),
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/auth/session-broker/status") {
				return Response.json({
					authenticated: true,
					user: { name: "Performance fixture", email: "fixture@example.test" },
				});
			}
			if (
				url.pathname.startsWith("/api/") ||
				url.pathname.startsWith("/auth/")
			) {
				return fetch(new URL(url.pathname + url.search, fixtures), {
					method: request.method,
					headers: request.headers,
					body:
						request.method === "GET" ? undefined : await request.arrayBuffer(),
				});
			}
			const requested = Bun.file(path.join(assets, url.pathname));
			const file = (await requested.exists())
				? requested
				: Bun.file(path.join(assets, "index.html"));
			if (
				process.env.PERF_COMPRESS === "1" &&
				/\.(?:js|css|html)$/.test(file.name ?? "")
			) {
				return new Response(gzipSync(await file.arrayBuffer()), {
					headers: {
						"Content-Type": file.type,
						"Content-Encoding": "gzip",
						Vary: "Accept-Encoding",
					},
				});
			}
			return new Response(file);
		},
	});
}

const targets = process.argv.includes("--live")
	? [
			{
				name: "Live sign-in",
				url: process.env.PERF_LIVE_URL ?? "https://tedix.os.tedix.dev",
				text: "Continue with Google",
			},
		]
	: [
			{
				name: "Workspace chat",
				url:
					origin + "/workspace/00000030-0000-4000-8000-000000000001?pane=chat",
				text: "Message the workspace",
				selector: 'textarea[aria-label="Message the workspace"]',
			},
			{
				name: "Workspaces",
				url: origin + "/workspaces",
				text: "Weekly revenue reporting surfaces and gadgets",
			},
			{
				name: "Needs you",
				url: origin + "/work/needs-you",
				text: "Tests pass. Push the retry fix to main?",
			},
			{
				name: "Card review",
				url:
					origin +
					"/workspace/00000030-0000-4000-8000-000000000002?workpiece=gadget%3A00000031-0000-4000-8000-000000000003",
				text: "Not useful",
			},
		];
const browser = await chromium.launch({ headless: true });
const results = [];
try {
	for (const target of targets.filter(
		(target) =>
			!process.env.PERF_TARGET || target.name === process.env.PERF_TARGET,
	)) {
		for (let run = 0; run < samples; run++) {
			const context = await browser.newContext({ viewport });
			try {
				const page = await context.newPage();
				await page.addInitScript(
					({ text }) => {
						const observer = new MutationObserver(() => {
							const row = [
								...document.querySelectorAll("[data-needs-you]"),
							].find((node) => node.textContent?.includes(text));
							if (!row || row.getBoundingClientRect().height === 0) return;
							observer.disconnect();
							requestAnimationFrame(() =>
								requestAnimationFrame(() =>
									performance.mark("needs-you-useful"),
								),
							);
						});
						observer.observe(document, { childList: true, subtree: true });
					},
					{ text: target.text },
				);
				const cdp = await context.newCDPSession(page);
				await cdp.send("Network.enable");
				await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
				await cdp.send("Emulation.setCPUThrottlingRate", {
					rate: cpuThrottlingRate,
				});
				await cdp.send("Network.emulateNetworkConditions", {
					offline: false,
					latency: 40,
					downloadThroughput,
					uploadThroughput: 625_000,
				});
				const chunks = new Map<string, { bytes: number; gzip: number }>();
				const reads: string[] = [];
				const apiFailures: Array<{ path: string; status: number }> = [];
				const errors: string[] = [];
				const pending: Promise<void>[] = [];
				page.on("request", (request) => {
					const url = new URL(request.url());
					if (
						url.pathname.startsWith("/api/") &&
						!url.pathname.includes("stream")
					)
						reads.push(request.method() + " " + url.pathname);
				});
				page.on("pageerror", (error) => errors.push(error.message));
				page.on("response", (response) => {
					const url = new URL(response.url());
					if (response.status() >= 400)
						apiFailures.push({ path: url.pathname, status: response.status() });
					if (response.request().resourceType() === "script") {
						pending.push(
							(async () => {
								const body = await response.body();
								chunks.set(url.origin + url.pathname, {
									bytes: body.length,
									gzip: gzipSync(body).length,
								});
							})(),
						);
					}
				});
				const start = Date.now();
				await page.goto(target.url, { waitUntil: "commit" });
				const useful =
					"selector" in target
						? page.locator(target.selector)
						: target.name === "Card review"
							? page.getByRole("button", { name: target.text, exact: true })
							: page.getByText(target.text).first();
				try {
					await useful.waitFor({ state: "visible", timeout: 30_000 });
				} catch (error) {
					console.error({
						url: page.url(),
						body: (await page.locator("body").innerText()).slice(0, 1_000),
						errors,
						apiFailures,
					});
					throw error;
				}
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() => resolve()),
							),
						),
				);
				const usefulMs = Date.now() - start;
				if (process.env.PERF_VERIFY_EARLY_SEND === "1") {
					const queued = `Queued before startup ${run}`;
					await useful.fill(queued);
					await page.getByRole("button", { name: "Send", exact: true }).click();
					await page.getByText(queued, { exact: true }).waitFor({
						state: "visible",
						timeout: 30_000,
					});
				}
				// Use the same observation window even when useful content arrives earlier.
				await page.waitForTimeout(Math.max(0, 8_000 - (Date.now() - start)));
				await Promise.all(pending);
				const paints = await page.evaluate(() =>
					performance
						.getEntriesByType("paint")
						.map(({ name, startTime }) => ({ name, startTime })),
				);
				const resources = await page.evaluate(() =>
					performance
						.getEntriesByType("resource")
						.map((entry) => entry.toJSON()),
				);
				const observedUsefulMs = await page.evaluate(
					() => performance.getEntriesByName("needs-you-useful")[0]?.startTime,
				);
				const row = {
					observedUsefulMs,
					resources,
					target: target.name,
					run,
					usefulMs,
					paints,
					jsBytes: [...chunks.values()].reduce(
						(sum, chunk) => sum + chunk.bytes,
						0,
					),
					jsGzip: [...chunks.values()].reduce(
						(sum, chunk) => sum + chunk.gzip,
						0,
					),
					chunks: [...chunks].map(([url, sizes]) => ({ url, ...sizes })),
					reads,
					apiFailures,
					errors,
				};
				results.push(row);
				await Bun.write(output, JSON.stringify(results, null, 2));
				console.log(
					JSON.stringify({
						target: row.target,
						observedUsefulMs,
						scriptRequests: chunks.size,
						run,
						usefulMs,
						jsBytes: row.jsBytes,
						jsGzip: row.jsGzip,
						requests: reads.length,
						apiFailures: apiFailures.length,
						errors,
					}),
				);
				if (errors.length) throw new Error(errors.join("\n"));
			} finally {
				await context.close();
			}
		}
	}
} finally {
	await browser.close();
	server?.stop();
	await fixtureServer?.stop();
}
