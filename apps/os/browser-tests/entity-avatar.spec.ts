import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = probe.port!;
probe.stop();
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}/browser-tests/entity-avatar.html`;
const selector = "[data-avatar-palette]";
let diagnostics = "";
const record = (message: string) => {
	diagnostics = `${diagnostics}${message}\n`.slice(-16_384);
};
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
	{ cwd, stdout: "pipe", stderr: "pipe", detached: true },
);
const capture = async (stream: ReadableStream<Uint8Array>, label: string) => {
	const decoder = new TextDecoder();
	for await (const chunk of stream)
		record(`${label}: ${decoder.decode(chunk, { stream: true })}`);
};
const output = Promise.all([
	capture(server.stdout, "stdout"),
	capture(server.stderr, "stderr"),
]);
// Attach immediately: a process can exit while Chromium is still launching.
const exited = server.exited.then((code) => {
	record(`server exited: code=${code}, signal=${server.signalCode}`);
	return new Error(`Avatar fixture server exited early (code ${code})`);
});
const whileRunning = <T>(operation: Promise<T>): Promise<T> =>
	Promise.race([
		operation,
		exited.then((error) => {
			throw error;
		}),
	]);
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const deadline = Date.now() + 20_000;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null) throw await exited;
		try {
			const response = await whileRunning(
				fetch(url, {
					signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
				}),
			);
			await response.body?.cancel();
			if (response.ok) break;
			record(`readiness: ${url} HTTP ${response.status}`);
		} catch (error) {
			record(`readiness: ${url} ${String(error)}`);
			if (server.exitCode !== null) throw await exited;
		}
		if (i === 99 || Date.now() >= deadline)
			throw new Error("Avatar fixture did not start");
		await Bun.sleep(200);
	}
	const page = await browser.newPage();
	page.on("pageerror", (error) =>
		record(`pageerror: ${page.url()} ${error.stack ?? error.message}`),
	);
	page.on("requestfailed", (request) => {
		if (request.url().startsWith(`${origin}/`))
			record(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
	});
	page.on("response", (response) => {
		if (response.url().startsWith(`${origin}/`) && response.status() >= 400)
			record(`response: ${response.status()} ${response.url()}`);
	});
	await whileRunning(page.goto(url));
	await whileRunning(page.locator(selector).last().waitFor());
	for (const dark of [false, true]) {
		for (const palette of [
			null,
			{ background: "#fff8e7", foreground: "#352614" },
			{ background: "#18212f", foreground: "#e2e9f4" },
			{ background: "#777777", foreground: "#000000" },
		]) {
			const ratios = await page.evaluate(
				({ dark, palette }) => {
					const root = document.documentElement;
					root.classList.toggle("dark", dark);
					root.dataset.mode = dark ? "dark" : "light";
					root.dataset.theme = "tedix";
					for (const key of ["background", "foreground"] as const) {
						if (palette) root.style.setProperty(`--${key}`, palette[key]);
						else root.style.removeProperty(`--${key}`);
					}
					const canvas = document.createElement("canvas");
					canvas.width = canvas.height = 1;
					const ctx = canvas.getContext("2d")!;
					const luminance = (color: string) => {
						ctx.fillStyle = color;
						ctx.fillRect(0, 0, 1, 1);
						const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data)
							.slice(0, 3)
							.map((value) => {
								const channel = value / 255;
								return channel <= 0.04045
									? channel / 12.92
									: ((channel + 0.055) / 1.055) ** 2.4;
							});
						return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
					};
					return Array.from(
						document.querySelectorAll("[data-avatar-palette]"),
						(el) => {
							const style = getComputedStyle(el);
							const bg = luminance(style.backgroundColor),
								fg = luminance(style.color);
							return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
						},
					);
				},
				{ dark, palette },
			);
			assert.equal(ratios.length, 11);
			for (const ratio of ratios)
				assert.ok(ratio >= 4.5, `Avatar contrast ${ratio} below AA`);
			const portraits = await page
				.locator('[data-entity-kind="tedi"]')
				.evaluateAll((elements) =>
					elements.map((element) => {
						const style = getComputedStyle(element);
						return [style.backgroundColor, style.color];
					}),
				);
			assert.deepEqual(
				portraits[0],
				portraits[1],
				"Feed and Team must use the same tedi colors",
			);
		}
	}
	console.log(
		"PASS: all nine avatar tints meet 4.5:1 in light, dark and custom organization palettes",
	);
} catch (error) {
	throw new Error(
		`Avatar browser check failed: URL=${url} selector=${selector}\nserver pid=${server.pid} exit=${server.exitCode} signal=${server.signalCode}\n${diagnostics}`,
		{ cause: error },
	);
} finally {
	try {
		await browser?.close();
	} finally {
		const signal = (value: NodeJS.Signals) => {
			try {
				process.kill(-server.pid, value);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		signal("SIGTERM");
		const killTimer = setTimeout(() => signal("SIGKILL"), 2_000);
		try {
			await server.exited;
			await output;
		} finally {
			clearTimeout(killTimer);
		}
	}
}
