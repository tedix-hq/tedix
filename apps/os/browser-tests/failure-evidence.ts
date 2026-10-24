import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/**
 * Failure diagnostics for the hand-rolled browser specs. The specs drive
 * Playwright directly rather than through its test runner, so a failing
 * assertion used to leave nothing but the run log. When the runner exports
 * TEDIX_BROWSER_EVIDENCE_DIR — the full-suite workflow does — the bunfig
 * preload in evidence-preload.ts records a Playwright trace per context into
 * <dir>/<spec>/trace-N.zip, and a crash also writes error.txt plus a bounded
 * set of page screenshots. A clean exit removes the spec's directory, so the
 * workflow's bounded artifact carries only failing specs.
 */
export const evidenceDirVariable = "TEDIX_BROWSER_EVIDENCE_DIR";

const maxFailureScreenshots = 4;
const screenshotTimeoutMs = 2_000;
const captureTimeoutMs = 8_000;
const traceOptions = { screenshots: true, snapshots: true } as const;

/** Directory-safe spec name derived from the spec path in argv[1]. */
export function specEvidenceName(entry: string | undefined): string {
	const name = basename(entry ?? "")
		.replace(/\.spec\.[cm]?[jt]sx?$/, "")
		.replace(/\.[^./\\]+$/, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return name || "spec";
}

type EvidencePage = {
	url(): string;
	screenshot(options: { path: string; timeout: number }): Promise<unknown>;
};

type EvidenceContext = {
	pages(): EvidencePage[];
	tracing: {
		start(options: {
			screenshots: boolean;
			snapshots: boolean;
			title?: string;
		}): Promise<void>;
		stop(options: { path: string }): Promise<void>;
	};
	close(options?: { reason?: string }): Promise<void>;
};

type EvidenceOwnedPage = EvidencePage & {
	context(): EvidenceContext;
	close(options?: {
		runBeforeUnload?: boolean;
		reason?: string;
	}): Promise<unknown>;
};

type EvidenceBrowser = {
	newContext(options?: unknown): Promise<EvidenceContext>;
	newPage(options?: unknown): Promise<EvidenceOwnedPage>;
	close(options?: { reason?: string }): Promise<void>;
};

type EvidenceBrowserType = {
	launch(options?: unknown): Promise<EvidenceBrowser>;
};

export function createEvidenceRecorder(
	specDir: string,
	report: (message: string) => void = (message) =>
		console.error(`[evidence] ${message}`),
) {
	let nextTrace = 0;
	type Trace = {
		index: number;
		context: EvidenceContext;
		path: string;
		stopped: boolean;
	};
	const traces = new Map<EvidenceContext, Trace>();

	async function stopTrace(trace: Trace) {
		if (trace.stopped) return;
		trace.stopped = true;
		try {
			await trace.context.tracing.stop({ path: trace.path });
		} catch (error) {
			report(`trace-${trace.index}.zip was not saved: ${error}`);
		}
	}

	async function trace(context: EvidenceContext) {
		if (traces.has(context)) return;
		const index = ++nextTrace;
		try {
			await context.tracing.start({ ...traceOptions, title: `spec ${index}` });
		} catch (error) {
			report(`context ${index} could not record a trace: ${error}`);
			return;
		}
		mkdirSync(specDir, { recursive: true });
		const record: Trace = {
			index,
			context,
			path: join(specDir, `trace-${index}.zip`),
			stopped: false,
		};
		traces.set(context, record);
		const close = context.close.bind(context);
		context.close = async (options) => {
			await stopTrace(record);
			return close(options);
		};
	}

	function instrumentBrowser<T extends EvidenceBrowser>(browser: T): T {
		const newContext = browser.newContext.bind(browser);
		browser.newContext = async (options) => {
			const context = await newContext(options);
			await trace(context);
			return context;
		};
		const newPage = browser.newPage.bind(browser);
		browser.newPage = async (options) => {
			const page = await newPage(options);
			// newPage owns a context; its trace must stop before the page closes
			// it, since an owned-context close can bypass the wrapped method.
			let record: Trace | undefined;
			try {
				await trace(page.context());
				record = traces.get(page.context());
			} catch (error) {
				report(`owned context was not traced: ${error}`);
			}
			if (record) {
				const closePage = page.close.bind(page);
				page.close = async (closeOptions) => {
					await stopTrace(record);
					return closePage(closeOptions);
				};
			}
			return page;
		};
		const closeBrowser = browser.close.bind(browser);
		browser.close = async (options) => {
			for (const pending of traces.values()) await stopTrace(pending);
			return closeBrowser(options);
		};
		return browser;
	}

	async function captureFailure(error: unknown, note = "failure") {
		mkdirSync(specDir, { recursive: true });
		const detail =
			error instanceof Error ? (error.stack ?? error.message) : String(error);
		try {
			writeFileSync(join(specDir, "error.txt"), `${note}\n${detail}\n`);
		} catch (writeError) {
			report(`error.txt was not written: ${writeError}`);
		}
		let shots = 0;
		for (const pending of traces.values()) {
			if (pending.stopped || shots >= maxFailureScreenshots) continue;
			let pages: EvidencePage[];
			try {
				pages = pending.context.pages();
			} catch {
				continue;
			}
			for (const page of pages) {
				if (shots >= maxFailureScreenshots) break;
				try {
					await page.screenshot({
						path: join(specDir, `failure-${shots + 1}.png`),
						timeout: screenshotTimeoutMs,
					});
					shots += 1;
				} catch {
					// The page raced the crash; keep collecting what is left.
				}
			}
		}
		for (const pending of traces.values()) await stopTrace(pending);
	}

	return { instrumentBrowser, captureFailure };
}

/** Remove a passing or evidence-free spec directory: uploads carry failures only. */
export function discardSpecEvidence(specDir: string, exitCode: number) {
	try {
		const kept =
			exitCode !== 0 && existsSync(specDir) && readdirSync(specDir).length > 0;
		if (!kept) rmSync(specDir, { recursive: true, force: true });
	} catch {
		// Cleanup must never change the spec's outcome.
	}
}

function installEvidenceHooks(
	capture: (error: unknown, note?: string) => Promise<void>,
	specDir: string,
) {
	let capturing = false;
	const fail = (error: unknown, note: string) => {
		// The default unhandled-error print is replaced; keep the failure in the
		// run log before collecting diagnostics.
		console.error(error);
		if (capturing) return;
		capturing = true;
		void Promise.race([
			capture(error, note),
			Bun.sleep(captureTimeoutMs),
		]).finally(() => process.exit(1));
	};
	process.on("uncaughtException", (error) => fail(error, "uncaughtException"));
	process.on("unhandledRejection", (reason) =>
		fail(reason, "unhandledRejection"),
	);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () =>
			fail(new Error(`${signal} interrupted the spec`), signal),
		);
	process.on("exit", (code) => discardSpecEvidence(specDir, code));
}

/**
 * Preload entry armed by apps/os/bunfig.toml: wrap every Playwright launch so
 * contexts record traces, then install the failure hooks. Without the
 * evidence directory in the environment this is a no-op.
 */
export async function installBrowserEvidence(env = process.env) {
	const dir = env[evidenceDirVariable];
	if (!dir || !process.argv[1]) return;
	const specDir = join(dir, specEvidenceName(process.argv[1]));
	const recorder = createEvidenceRecorder(specDir);
	let playwright: typeof import("playwright");
	try {
		playwright = await import("playwright");
	} catch (error) {
		console.error(`[evidence] Playwright import failed: ${error}`);
		return;
	}
	for (const browserType of [
		playwright.chromium,
		playwright.firefox,
		playwright.webkit,
	] as unknown as EvidenceBrowserType[]) {
		const launch = browserType.launch.bind(browserType);
		browserType.launch = async (options) => {
			const browser = await launch(options);
			return recorder.instrumentBrowser(browser);
		};
	}
	installEvidenceHooks(recorder.captureFailure, specDir);
}
