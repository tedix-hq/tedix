import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEvidenceRecorder,
	discardSpecEvidence,
	evidenceDirVariable,
	specEvidenceName,
} from "../../apps/os/browser-tests/failure-evidence";

test("the evidence directory names the spec, sanitized to one path segment", () => {
	expect(
		specEvidenceName("/repo/apps/os/browser-tests/deck-iphone.spec.ts"),
	).toBe("deck-iphone");
	expect(specEvidenceName("browser-tests/feed deck.spec.ts")).toBe("feed-deck");
	expect(specEvidenceName(undefined)).toBe("spec");
	expect(specEvidenceName("")).toBe("spec");
});

type FakeContext = ReturnType<typeof fakeContext>["context"];

function fakeContext() {
	const calls = {
		starts: 0,
		tracePaths: [] as string[],
		closes: 0,
		pages: [] as {
			url(): string;
			screenshot(options: { path: string; timeout: number }): Promise<void>;
		}[],
	};
	const context = {
		pages: () => calls.pages,
		tracing: {
			start: async () => {
				calls.starts += 1;
			},
			stop: async ({ path }: { path: string }) => {
				calls.tracePaths.push(path);
			},
		},
		close: async () => {
			calls.closes += 1;
		},
	};
	return { context, calls };
}

function fakeBrowser(contexts: FakeContext[]) {
	const queue = [...contexts];
	return {
		newContext: async () => {
			const context = queue.shift();
			if (!context) throw new Error("no more contexts");
			return context;
		},
		newPage: async () => {
			throw new Error("no owned page");
		},
		close: async () => {},
	};
}

test("a context records its trace into the spec directory on close", async () => {
	const root = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const recorder = createEvidenceRecorder(join(root, "deck"), () => {});
		const { context, calls } = fakeContext();
		const browser = recorder.instrumentBrowser(fakeBrowser([context]));
		const traced = await browser.newContext();
		expect(calls.starts).toBe(1);
		await traced.close();
		expect(calls.tracePaths).toEqual([join(root, "deck", "trace-1.zip")]);
		expect(calls.closes).toBe(1);
		await traced.close();
		expect(calls.tracePaths).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("browser.close saves the traces still open at crash time", async () => {
	const root = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const recorder = createEvidenceRecorder(join(root, "deck"), () => {});
		const first = fakeContext();
		const second = fakeContext();
		const browser = recorder.instrumentBrowser(
			fakeBrowser([first.context, second.context]),
		);
		await browser.newContext();
		await browser.newContext();
		await browser.close();
		expect(first.calls.tracePaths).toEqual([join(root, "deck", "trace-1.zip")]);
		expect(second.calls.tracePaths).toEqual([
			join(root, "deck", "trace-2.zip"),
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failure capture writes error.txt, bounded screenshots and open traces", async () => {
	const root = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const specDir = join(root, "deck");
		const recorder = createEvidenceRecorder(specDir, () => {});
		const { context, calls } = fakeContext();
		for (let page = 0; page < 8; page++)
			calls.pages.push({
				url: () => `http://fixture/${page}`,
				screenshot: async ({ path }) => {
					writeFileSync(path, "png");
				},
			});
		const browser = recorder.instrumentBrowser(fakeBrowser([context]));
		await browser.newContext();
		await recorder.captureFailure(new Error("assertion boom"));
		expect(readFileSync(join(specDir, "error.txt"), "utf8")).toContain(
			"assertion boom",
		);
		for (const shot of [1, 2, 3, 4])
			expect(existsSync(join(specDir, `failure-${shot}.png`))).toBe(true);
		expect(existsSync(join(specDir, "failure-5.png"))).toBe(false);
		expect(calls.tracePaths).toEqual([join(specDir, "trace-1.zip")]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discard keeps only failing specs with evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const failed = join(root, "failed");
		mkdirSync(failed, { recursive: true });
		writeFileSync(join(failed, "error.txt"), "boom");
		discardSpecEvidence(failed, 1);
		expect(existsSync(join(failed, "error.txt"))).toBe(true);
		discardSpecEvidence(failed, 0);
		expect(existsSync(failed)).toBe(false);
		const empty = join(root, "empty");
		mkdirSync(empty, { recursive: true });
		discardSpecEvidence(empty, 1);
		expect(existsSync(empty)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const osDir = new URL("../../apps/os", import.meta.url).pathname;

function runSpec(source: string, evidence: string) {
	const spec = join(evidence, "evidence-check.spec.ts");
	writeFileSync(spec, source);
	return spawnSync(process.execPath, [spec], {
		cwd: osDir,
		env: { ...process.env, [evidenceDirVariable]: join(evidence, "out") },
		encoding: "utf8",
	});
}

test("a failing spec keeps its diagnostics through the bunfig preload", () => {
	const root = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const run = runSpec(`throw new Error("boom spec");\n`, root);
		expect(run.status).not.toBe(0);
		expect(run.stderr).toContain("boom spec");
		expect(
			readFileSync(join(root, "out", "evidence-check", "error.txt"), "utf8"),
		).toContain("boom spec");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a passing spec leaves no diagnostics behind", () => {
	const root = mkdtempSync(join(tmpdir(), "browser-evidence-"));
	try {
		const run = runSpec(`console.log("clean");\n`, root);
		expect(run.status).toBe(0);
		expect(existsSync(join(root, "out", "evidence-check"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
