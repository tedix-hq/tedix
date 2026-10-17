/**
 * Cold first-load measurements, using a fresh unauthenticated browser per sample.
 * Run the fixture dev server first. PERF_ASSETS_ROOT optionally serves a built
 * SPA while proxying its API calls to PERF_FIXTURES_ORIGIN (loopback only).
 * --live measures only the public sign-in journey; it never imports a profile.
 */
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";

const origin = process.env.PERF_ORIGIN ?? "http://127.0.0.1:3010";
const output = process.env.PERF_OUTPUT ?? "/tmp/os-first-load.json";
const samples = Number(process.env.PERF_SAMPLES ?? 5);
const assets = process.env.PERF_ASSETS_ROOT;
let server: ReturnType<typeof Bun.serve> | undefined;
if (assets) {
	const fixtures = new URL(
		process.env.PERF_FIXTURES_ORIGIN ?? "http://127.0.0.1:3010",
	);
	if (fixtures.hostname !== "127.0.0.1")
		throw new Error("Fixture proxy must use loopback.");
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: Number(new URL(origin).port),
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/api/")) {
				return fetch(new URL(url.pathname + url.search, fixtures), {
					method: request.method,
					headers: request.headers,
					body:
						request.method === "GET" ? undefined : await request.arrayBuffer(),
				});
			}
			const file = Bun.file(path.join(assets, url.pathname));
			return new Response(
				(await file.exists())
					? file
					: Bun.file(path.join(assets, "index.html")),
			);
		},
	});
}

const targets = process.argv.includes("--live")
	? [
			{
				name: "Live sign-in",
				url: "https://tedix.os.tedix.dev",
				text: "Continue with Google",
			},
		]
	: [
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
	for (const target of targets) {
		for (let run = 0; run < samples; run++) {
			const context = await browser.newContext({
				viewport: { width: 1440, height: 1000 },
			});
			try {
				const page = await context.newPage();
				const cdp = await context.newCDPSession(page);
				await cdp.send("Network.enable");
				await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
				await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
				await cdp.send("Network.emulateNetworkConditions", {
					offline: false,
					latency: 40,
					downloadThroughput: 1_250_000,
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
					if (url.pathname.startsWith("/api/") && response.status() >= 400)
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
					target.name === "Card review"
						? page.getByRole("button", { name: target.text, exact: true })
						: page.getByText(target.text).first();
				await useful.waitFor({ state: "visible", timeout: 30_000 });
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() =>
								requestAnimationFrame(() => resolve()),
							),
						),
				);
				const usefulMs = Date.now() - start;
				// Use the same observation window even when useful content arrives earlier.
				await page.waitForTimeout(Math.max(0, 8_000 - (Date.now() - start)));
				await Promise.all(pending);
				const paints = await page.evaluate(() =>
					performance
						.getEntriesByType("paint")
						.map(({ name, startTime }) => ({ name, startTime })),
				);
				const row = {
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
}
