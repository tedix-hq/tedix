import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	handlers: new Map<
		string,
		(args: Record<string, unknown>) => Promise<{
			structuredContent: Record<string, unknown>;
		}>
	>(),
	start: vi.fn(),
	read: vi.fn(),
	cancel: vi.fn(),
}));
vi.mock("@tedix/mcp-shared/server", () => ({
	createMcpServer: () => ({
		registerTool: (name: string, _config: unknown, handler: never) =>
			mocks.handlers.set(name, handler),
	}),
}));
vi.mock("./preview-exec-runner", async (original) => ({
	...(await original<object>()),
	startCmsPreviewExec: mocks.start,
	readCmsPreviewExecStatus: mocks.read,
	cancelCmsPreviewExec: mocks.cancel,
}));
vi.mock("./build-runner", async (original) => ({
	...(await original<object>()),
	readCmsSandboxBuildStatus: mocks.read,
	cancelCmsSandboxBuild: mocks.cancel,
}));
vi.mock("./theme-artifacts", async (original) => ({
	...(await original<object>()),
	readThemeArtifactRepoSeedStatus: mocks.read,
	cancelThemeArtifactRepoSeed: mocks.cancel,
}));
import {
	buildSiteBuilderMcpServer,
	type SiteBuilderToolContext,
} from "./tools";

const terminal = {
	jobId: "one",
	status: "complete",
	exitCode: 0,
	running: false,
	startedAt: "2026-09-20T03:48:24.711Z",
	durationMs: 288,
	stdoutTail: "stdout\n",
	stderrTail: "stderr\n",
	logTail: "stdout\nstderr\n",
	command: "echo ok",
	seed: { commit: "abc", ok: true },
	successMarkerDetected: true,
	message: "complete",
};
const running = {
	...terminal,
	status: "running",
	exitCode: null,
	running: true,
};
const missing = {
	...terminal,
	status: "failed",
	exitCode: null,
	running: false,
	startedAt: null,
	durationMs: null,
	stdoutTail: "",
	stderrTail: "",
	logTail: "",
	seed: null,
	message: "process was not found",
};

function setup(initial: Record<string, unknown> | null) {
	let value = initial;
	let revision = 1;
	let race: (() => void) | undefined;
	const put = vi.fn(
		async (_key: string, body: string, options: R2PutOptions) => {
			race?.();
			race = undefined;
			const condition = options.onlyIf as R2Conditional;
			if (
				value
					? condition.etagMatches !== String(revision)
					: condition.etagDoesNotMatch !== "*"
			)
				return null;
			value = JSON.parse(body);
			revision++;
			return { etag: String(revision) };
		},
	);
	const storage = {
		get: vi.fn(async () => {
			const snapshot = value;
			const etag = String(revision);
			return snapshot ? { etag, json: async () => snapshot } : null;
		}),
		put,
	};
	buildSiteBuilderMcpServer({
		orgSlug: "acme",
		templateSlug: "tedix",
		storage,
		sandbox: {},
	} as unknown as SiteBuilderToolContext);
	return {
		put,
		stored: () => value,
		raceWith: (winner: Record<string, unknown>) => {
			race = () => {
				value = winner;
				revision++;
			};
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlers.clear();
});

it("allows a native container cold start beyond the short probe timeout", async () => {
	vi.useFakeTimers();
	try {
		setup(null);
		mocks.start.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 30_000));
			return {
				jobId: "one",
				processId: "native-one",
				startedAt: Date.parse(terminal.startedAt),
			};
		});
		mocks.read.mockResolvedValue({
			...terminal,
			startedAt: Date.parse(terminal.startedAt),
		});
		const result = mocks.handlers.get("theme_preview_exec")!({
			command: "echo ok",
			waitMs: 0,
		});
		let settled = false;
		void result.finally(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(25_001);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(4_999);
		expect((await result).structuredContent.status).toBe("complete");
	} finally {
		vi.useRealTimers();
	}
});

describe.each(["theme_preview_exec", "theme_build", "theme_artifact_seed"])(
	"%s receipts",
	(tool) => {
		const call = (suffix: string) =>
			mocks.handlers.get(`${tool}_${suffix}`)!({ jobId: "one" });
		it.each([
			["complete", 0],
			["timeout", 124],
			["cancelled", null],
			["failed", 1],
		])(
			"retains %s after process loss on status and cancel",
			async (status, exitCode) => {
				const receipt = { ...terminal, status, exitCode };
				const f = setup(receipt);
				expect((await call("status")).structuredContent).toEqual(receipt);
				expect((await call("cancel")).structuredContent).toEqual({
					...receipt,
					cancelled: false,
					previousStatus: status,
				});
				expect(mocks.read).not.toHaveBeenCalled();
				expect(mocks.cancel).not.toHaveBeenCalled();
				expect(f.put).not.toHaveBeenCalled();
				expect(f.stored()).toEqual(receipt);
			},
		);
		it("does not turn loss of a running process into a terminal proof", async () => {
			const f = setup(running);
			mocks.read.mockResolvedValue(missing);
			const lost = (await call("status")).structuredContent;
			expect(lost).toMatchObject({
				status: "failed",
				exitCode: null,
				durationMs: 288,
				logTail: terminal.logTail,
			});
			mocks.read.mockResolvedValue({
				...terminal,
				startedAt: Date.parse(terminal.startedAt),
			});
			expect((await call("status")).structuredContent.status).toBe("complete");
			expect(f.stored()?.status).toBe("complete");
			expect(mocks.read).toHaveBeenCalledTimes(2);
		});
		it.each([null, running])(
			"a stale observation cannot overwrite a concurrent terminal receipt",
			async (initial) => {
				const f = setup(initial);
				mocks.read.mockResolvedValue({
					...running,
					startedAt: Date.parse(terminal.startedAt),
				});
				f.raceWith(terminal);
				expect((await call("status")).structuredContent).toEqual(terminal);
				expect(f.stored()).toEqual(terminal);
				expect(mocks.read).toHaveBeenCalledOnce();
			},
		);
		it("persists the first observed terminal result with an absence condition", async () => {
			const f = setup(null);
			mocks.read.mockResolvedValue({
				...terminal,
				startedAt: Date.parse(terminal.startedAt),
			});
			const result = await call("status");
			expect(result.structuredContent).toMatchObject({
				status: "complete",
				exitCode: 0,
				durationMs: 288,
			});
			expect(f.put.mock.calls[0]?.[2].onlyIf).toEqual({
				etagDoesNotMatch: "*",
			});
			expect(f.stored()).toEqual(result.structuredContent);
		});
		it("surfaces repeated CAS conflicts without an unconditional write or repeated cancellation", async () => {
			const f = setup(running);
			f.put.mockResolvedValue(null);
			mocks.cancel.mockResolvedValue({
				...terminal,
				startedAt: Date.parse(terminal.startedAt),
				cancelled: false,
				previousStatus: "complete",
			});
			await expect(call("cancel")).rejects.toThrow("changed concurrently");
			expect(mocks.cancel).toHaveBeenCalledOnce();
			expect(f.stored()).toEqual(running);
			expect(
				f.put.mock.calls.every(
					(call) => (call[2].onlyIf as R2Conditional).etagMatches === "1",
				),
			).toBe(true);
		});
		it("cancel preserves terminal winner and does not repeat the native effect after CAS conflict", async () => {
			const f = setup(running);
			mocks.cancel.mockResolvedValue({
				...terminal,
				status: "cancelled",
				exitCode: 143,
				startedAt: Date.parse(terminal.startedAt),
				cancelled: true,
				previousStatus: "running",
			});
			f.raceWith(terminal);
			expect((await call("cancel")).structuredContent).toMatchObject({
				status: "complete",
				exitCode: 0,
				durationMs: 288,
				cancelled: false,
			});
			expect(f.stored()).toEqual(terminal);
			expect(mocks.cancel).toHaveBeenCalledOnce();
		});
	},
);
