import { appendFileSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

/**
 * Shared fixture, page helpers and lifecycle diagnostics for the shell browser
 * specs. A spec runs against SHELL_TEST_ORIGIN, the run-specs shared server
 * (OS_FIXTURE_ORIGIN), or its own `vp dev` process; SHELL_EVIDENCE_DIR records
 * lifecycle.jsonl and screenshots.
 */
export type ShellTools = {
	origin: string;
	evidenceDir: string | undefined;
	pageErrors: string[];
	record: (event: string, detail: unknown) => void;
	newPage: (options?: Parameters<Browser["newPage"]>[0]) => Promise<Page>;
	rail: (page: Page) => ReturnType<Page["locator"]>;
	sidebarState: (page: Page) => Promise<Record<string, unknown>>;
	widthIs: (page: Page, width: number) => Promise<void>;
	stateIs: (page: Page, state: string) => Promise<void>;
	capture: (page: Page, name: string) => Promise<void>;
};

export async function runShellSpec(
	body: (shell: ShellTools) => Promise<void>,
): Promise<void> {
	const cwd = new URL("../", import.meta.url).pathname;
	const evidenceDir = process.env.SHELL_EVIDENCE_DIR;
	if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
	const events: string[] = [];
	function record(event: string, detail: unknown) {
		const line = JSON.stringify({
			at: new Date().toISOString(),
			event,
			detail,
		});
		events.push(line);
		if (events.length > 200) events.shift();
		if (evidenceDir)
			appendFileSync(`${evidenceDir}/lifecycle.jsonl`, `${line}\n`);
	}
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = probe.port!;
	probe.stop();
	const external =
		process.env.SHELL_TEST_ORIGIN ?? process.env.OS_FIXTURE_ORIGIN;
	const origin = external ?? `http://127.0.0.1:${port}`;
	const server = external
		? undefined
		: Bun.spawn(
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
	record("server", { origin, pid: server?.pid, owned: Boolean(server) });
	async function readOutput(stream: ReadableStream<Uint8Array>, name: string) {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			record(name, text);
			(name === "stdout" ? process.stdout : process.stderr).write(text);
		}
	}
	const output = server
		? Promise.all([
				readOutput(server.stdout, "stdout"),
				readOutput(server.stderr, "stderr"),
			])
		: Promise.resolve();
	let stopping = false;
	const stop = new AbortController();
	const serverExited = server?.exited.then((code) => {
		record("server-exit", {
			pid: server.pid,
			code,
			signal: server.signalCode,
			stopping,
		});
		if (!stopping)
			throw new Error(`Shell fixture server ${server.pid} exited: ${code}`);
	});
	let browser: Browser | undefined;
	const pageErrors: string[] = [];
	async function sidebarState(page: Page) {
		return page.evaluate(() => ({
			url: location.href,
			readyState: document.readyState,
			viewport: { width: innerWidth, height: innerHeight },
			mode: document.documentElement.dataset.mode,
			sidebars: Array.from(
				document.querySelectorAll('[data-sidebar="sidebar"]'),
			).map((node) => ({
				state: node.getAttribute("data-state"),
				rect: node.getBoundingClientRect().toJSON(),
			})),
		}));
	}
	async function newPage(options?: Parameters<Browser["newPage"]>[0]) {
		if (!browser) throw new Error("Shell browser is not launched");
		const page = await browser.newPage(options);
		page.on("pageerror", (error) => {
			pageErrors.push(error.stack ?? String(error));
			record("page-error", {
				url: page.url(),
				error: error.stack ?? String(error),
			});
		});
		page.on("console", (message) => {
			if (["error", "warning"].includes(message.type()))
				record("console", {
					url: page.url(),
					type: message.type(),
					text: message.text(),
				});
		});
		page.on("requestfailed", (request) =>
			record("request-failed", {
				url: request.url(),
				local: new URL(request.url()).origin === origin,
				method: request.method(),
				failure: request.failure(),
			}),
		);
		page.on("response", (response) => {
			if (response.status() >= 400 && new URL(response.url()).origin === origin)
				record("http-error", {
					url: response.url(),
					status: response.status(),
				});
		});
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame())
				record("navigation", { url: frame.url() });
		});
		return page;
	}
	const rail = (page: Page) => page.locator('[data-sidebar="sidebar"]');
	async function widthIs(page: Page, width: number) {
		record("wait-width", { url: page.url(), width });
		await page.waitForFunction(
			(expected) =>
				Math.abs(
					(document
						.querySelector('[data-sidebar="sidebar"]')
						?.getBoundingClientRect().width ?? 0) - expected,
				) < 1,
			width,
		);
		record("sidebar", await sidebarState(page));
	}
	async function stateIs(page: Page, state: string) {
		record("wait-state", { url: page.url(), state });
		await page.waitForFunction(
			(expected) =>
				document
					.querySelector('[data-sidebar="sidebar"]')
					?.getAttribute("data-state") === expected,
			state,
		);
		record("sidebar", await sidebarState(page));
	}
	async function capture(page: Page, name: string) {
		await page.waitForTimeout(300);
		if (evidenceDir)
			await page.screenshot({
				path: `${evidenceDir}/plain-labels-${name}.png`,
				fullPage: true,
			});
	}
	async function runBody() {
		const deadline = Date.now() + 20_000;
		const readinessUrl = `${origin}/skills?section=triggers`;
		for (let i = 0; i < 100; i++) {
			stop.signal.throwIfAborted();
			try {
				const response = await fetch(readinessUrl, {
					signal: AbortSignal.any([
						stop.signal,
						AbortSignal.timeout(Math.max(1, deadline - Date.now())),
					]),
				});
				record("readiness", { url: readinessUrl, status: response.status });
				if (response.ok && (await response.text()).includes("/src/main.tsx"))
					break;
			} catch (error) {
				record("readiness-error", String(error));
			}
			if (i === 99 || Date.now() >= deadline)
				throw new Error(
					"Shell fixture server did not serve the SPA entry within 20000ms",
				);
			await Bun.sleep(200);
		}
		stop.signal.throwIfAborted();
		browser = await chromium.launch({ headless: true });
		stop.signal.throwIfAborted();
		await body({
			origin,
			evidenceDir,
			pageErrors,
			record,
			newPage,
			rail,
			sidebarState,
			widthIs,
			stateIs,
			capture,
		});
	}
	const running = runBody();
	try {
		await Promise.race([
			running,
			...(serverExited ? [serverExited] : []),
			output.then(() => new Promise<never>(() => {})),
		]);
	} catch (error) {
		stop.abort(error);
		record("failure", String(error));
		let failurePage = 0;
		for (const context of browser?.contexts() ?? []) {
			for (const page of context.pages()) {
				try {
					record("failure-sidebar", await sidebarState(page));
					if (evidenceDir)
						await page.screenshot({
							path: `${evidenceDir}/failure-${failurePage++}.png`,
							timeout: 1000,
						});
				} catch (diagnosticError) {
					record("diagnostic-error", {
						url: page.url(),
						error: String(diagnosticError),
					});
				}
			}
		}
		console.error(events.join("\n"));
		throw error;
	} finally {
		stopping = true;
		stop.abort();
		try {
			const closingBrowser = browser;
			await closingBrowser?.close();
			// An exit can win the race while Chromium is still launching.
			await Promise.allSettled([running]);
			if (browser !== closingBrowser) await browser?.close();
		} finally {
			if (server) {
				try {
					process.kill(-server.pid, "SIGTERM");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
				await server.exited;
				await output;
			}
		}
	}
}
