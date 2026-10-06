import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { Box, render as renderInk } from "ink";
import { InkLivePanel } from "./ink-live-panel";
import { render as renderForInput } from "ink-testing-library";
import { InkRepl, type ReplController, type ReplState } from "./ink-repl";
import {
	eraseInteractiveComposer,
	INTERACTIVE_INK_RENDER_OPTIONS,
} from "./interactive-ink";
import { appendReplHistory } from "./repl-history";

const tempDirs: string[] = [];

afterEach(() => {
	delete process.env.TEDIX_CONFIG_DIR;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function isolateConfig(): void {
	const dir = mkdtempSync(join(tmpdir(), "tedix-ink-render-"));
	tempDirs.push(dir);
	process.env.TEDIX_CONFIG_DIR = dir;
}

function makeController() {
	const handlers = new Set<(state: ReplState) => void>();
	const dispatched: string[] = [];
	const selectedSessions: string[] = [];
	const approvalResponses: Array<{
		decision: "approve" | "reject";
		rememberForSession: boolean;
	}> = [];
	const questionResponses: string[] = [];
	const steers: string[] = [];
	let pickerDismissals = 0;
	let approvalDismissals = 0;
	let questionDismissals = 0;
	let interrupts = 0;
	let foreground: { homeRunId: string; label: string } | null = null;
	const controller: ReplController = {
		buildPrompt: () => "› ",
		dismissSessionPicker: () => {
			pickerDismissals++;
		},
		dismissApproval: () => {
			approvalDismissals++;
		},
		dismissQuestion: () => {
			questionDismissals++;
		},
		dispatch: async (line) => {
			dispatched.push(line);
			return "handled";
		},
		onUpdate: (handler) => {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		shouldExit: () => true,
		foregroundRun: () => foreground,
		steerForeground: async (instruction) => {
			steers.push(instruction);
			return true;
		},
		setActivityMode: () => {},
		cycleActivityMode: () => {},
		selectSession: async (conversationId) => {
			selectedSessions.push(conversationId);
		},
		waitAll: async () => {},
		interruptForeground: async () => {
			interrupts++;
		},
		respondApproval: async (decision, rememberForSession) => {
			approvalResponses.push({ decision, rememberForSession });
		},
		respondQuestion: async (answer) => {
			questionResponses.push(answer);
		},
	};
	return {
		controller,
		dispatched,
		selectedSessions,
		pickerDismissals: () => pickerDismissals,
		approvalDismissals: () => approvalDismissals,
		questionDismissals: () => questionDismissals,
		approvalResponses,
		questionResponses,
		steers,
		interrupts: () => interrupts,
		setForeground: (value: { homeRunId: string; label: string } | null) => {
			foreground = value;
		},
		hasSubscribers: () => handlers.size > 0,
		emit: (state: ReplState) => {
			for (const handler of handlers) handler(state);
		},
	};
}

function liveState(frameIndex: number, thinkingSince: number): ReplState {
	return {
		panelStates: [],
		pendingCommits: [],
		frameIndex,
		now: thinkingSince + frameIndex * 250,
		thinkingSince,
		thinkingLabel: "Contacting Home",
		lifecycle: "contacting_home",
		liveness: "live",
		livenessElapsedMs: frameIndex * 250,
		connection: "connected",
		sessionPicker: null,
		approvalPrompt: null,
		questionPrompt: null,
		activityMode: "compact",
		clearScreenSeq: 0,
		clearScreenLines: [],
	};
}

function testStreams() {
	const stdout = new PassThrough() as PassThrough & {
		columns: number;
		rows: number;
		isTTY: boolean;
		getColorDepth: () => number;
	};
	stdout.columns = 80;
	stdout.rows = 24;
	stdout.isTTY = true;
	stdout.getColorDepth = () => 8;

	const stdin = new PassThrough() as PassThrough & {
		isTTY: boolean;
		isRaw: boolean;
		ref: () => typeof stdin;
		setRawMode: (mode: boolean) => typeof stdin;
		unref: () => typeof stdin;
	};
	stdin.isTTY = true;
	stdin.isRaw = false;
	stdin.ref = () => stdin;
	stdin.unref = () => stdin;
	stdin.setRawMode = (mode) => {
		stdin.isRaw = mode;
		return stdin;
	};

	let raw = "";
	stdout.on("data", (chunk) => {
		raw += chunk.toString();
	});
	return {
		stdin,
		stdout,
		takeRaw: () => {
			const result = raw;
			raw = "";
			return result;
		},
	};
}

async function settleRender(instance: {
	waitUntilRenderFlush: () => Promise<void>;
}): Promise<void> {
	// Deterministic settle instead of racing a wall-clock sleep against CI
	// load: each pass yields to the macrotask queue (letting already-written
	// stdin data and controller emits run their handlers and enqueue React
	// work), then awaits Ink's render commit + throttled stdout flush. Three
	// passes cover multi-hop chains (input handler → async dispatch →
	// controller emit → re-render) without any fixed real-time wait.
	for (let pass = 0; pass < 3; pass++) {
		await new Promise<void>((resolve) => {
			setImmediate(resolve);
		});
		await instance.waitUntilRenderFlush();
	}
}

async function waitForSubscription(
	hasSubscribers: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!hasSubscribers()) {
		if (Date.now() >= deadline) {
			throw new Error("Ink controller subscription did not attach");
		}
		await Bun.sleep(25);
	}
}

async function waitForCondition(
	predicate: () => boolean,
	message: string,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(10);
	}
}

describe("Ink incremental terminal rendering", () => {
	test("generic non-TTY streams render without raw mode", async () => {
		isolateConfig();
		const kit = makeController();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		let output = "";
		stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		const view = renderInk(
			<InkRepl
				controller={kit.controller}
				greeting={["Generic stream transcript"]}
			/>,
			{
				stdin,
				stdout,
				stderr: stdout,
				exitOnCtrlC: false,
			},
		);
		try {
			await settleRender(view);
			expect(stripVTControlCharacters(output)).toContain(
				"Generic stream transcript",
			);
		} finally {
			view.unmount();
			view.cleanup();
		}
	});

	test("live rows align cost to their content box rather than process stdout", async () => {
		const now = Date.now();
		const view = renderForInput(
			<Box width={60}>
				<InkLivePanel
					states={[
						{
							entry: {
								homeRunId: "run-width",
								label: "Home",
								startedAt: now,
								conversationId: "home:width",
								settled: false,
							},
							activities: [],
							summary: { status: "running" },
						},
					]}
					frameIndex={0}
					now={now}
					activityMode="compact"
				/>
			</Box>,
		);
		try {
			await waitForCondition(
				() => view.lastFrame()?.includes("0ms") === true,
				"panel did not render",
			);
			const row =
				stripVTControlCharacters(view.lastFrame() ?? "").split("\n")[0] ?? "";
			expect(row.trimEnd().endsWith("0ms")).toBe(true);
			expect([...row.trimEnd()]).toHaveLength(59);
		} finally {
			view.unmount();
		}
	});

	test("incremental command output stays contiguous in terminal scrollback", async () => {
		isolateConfig();
		const { controller, emit, hasSubscribers } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
			},
		);
		try {
			await waitForSubscription(hasSubscribers);
			await settleRender(instance);
			takeRaw();
			emit({
				...liveState(0, Date.now()),
				pendingCommits: [
					{ id: "out-1", speaker: "output", lines: ["first output line"] },
					{ id: "out-2", speaker: "output", lines: ["second output line"] },
				],
			});
			await settleRender(instance);
			const text = stripVTControlCharacters(takeRaw()).replace(/\r/g, "");
			expect(text).toContain("first output line\nsecond output line");
		} finally {
			instance.unmount();
		}
	});

	test("typing keeps the composer as the last dynamic rows without a footer repaint", async () => {
		isolateConfig();
		const { controller } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			takeRaw();

			stdin.write("a");
			await settleRender(instance);
			const firstKey = takeRaw();
			stdin.write("b");
			await settleRender(instance);
			const secondKey = takeRaw();

			for (const frame of [firstKey, secondKey]) {
				expect(frame).not.toContain("Ctrl-D quit");
				// The dynamic region is now exactly the three-row composer. The old
				// footer layout emitted ESC[4A and visibly traversed that status row.
				expect(frame).toContain("\x1b[3A");
				expect(frame).not.toContain("\x1b[4A");
			}
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});

	test("settlement commits an answer and clears live state in one terminal frame", async () => {
		isolateConfig();
		const { controller, emit, hasSubscribers } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			await waitForSubscription(hasSubscribers);
			const startedAt = Date.now();
			emit(liveState(0, startedAt));
			await settleRender(instance);
			takeRaw();

			emit({
				...liveState(1, startedAt),
				thinkingSince: null,
				pendingCommits: [
					{
						id: "answer",
						speaker: "kernel",
						lines: ["Atomic terminal answer"],
					},
				],
			});
			await settleRender(instance);
			const settled = takeRaw();

			expect(settled.match(/Atomic terminal answer/g) ?? []).toHaveLength(1);
			expect(settled.match(/Send a message/g) ?? []).toHaveLength(1);
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});

	test("renders parallel conversations and coordinated tedis as one calm live frame", async () => {
		isolateConfig();
		const { controller, emit, hasSubscribers } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			await waitForSubscription(hasSubscribers);
			takeRaw();
			const startedAt = Date.now();
			emit({
				...liveState(0, startedAt),
				thinkingSince: null,
				panelStates: [
					{
						entry: {
							homeRunId: "run-plan-very-long-id",
							conversationId: "home:parallel:a",
							label: "release review",
							settled: false,
							startedAt,
						},
						childTotal: 2,
						childDone: 1,
						childFailed: 0,
						children: [
							{
								id: "child:cto:raw-child-run-id",
								label: "CTO",
								status: "completed",
								objective: "Inspect main",
							},
							{
								id: "child:cpo:raw-child-run-id",
								label: "CPO",
								status: "running",
								objective: "Check runtime",
							},
						],
					},
					{
						entry: {
							homeRunId: "run-b-very-long-id",
							conversationId: "home:parallel:b",
							label: "activity review",
							settled: false,
							startedAt,
						},
					},
				],
			});
			await settleRender(instance);
			const frame = takeRaw();

			expect(frame).toContain("release review");
			expect(frame).toContain("activity review");
			expect(frame).toContain("✓ CTO");
			expect(frame).toContain("CPO");
			expect(frame).not.toContain("raw-child-run-id");
			expect(frame.match(/Send a message/g) ?? []).toHaveLength(1);
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});

	test("stays stable through repeated typing, spinner, resize, and parallel-run updates", async () => {
		isolateConfig();
		const { controller, emit, hasSubscribers } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			await waitForSubscription(hasSubscribers);
			takeRaw();
			const startedAt = Date.now();
			let allIncrementalOutput = "";
			// Twenty rounds still cover repeated input, four resize boundaries, and
			// interleaved parallel-run updates without making the assertion depend on
			// a loaded CI runner completing forty serialized render flushes.
			for (let index = 0; index < 20; index++) {
				stdin.write(String(index % 10));
				await settleRender(instance);
				const typed = takeRaw();
				allIncrementalOutput += typed;
				expect(typed).not.toContain("Ctrl-D quit");
				expect(
					(typed.match(/Send a message/g) ?? []).length,
				).toBeLessThanOrEqual(1);

				emit({
					...liveState(index, startedAt),
					thinkingSince: null,
					panelStates: [
						{
							entry: {
								homeRunId: "stress-plan",
								conversationId: "home:stress:a",
								label: "coordinated review",
								settled: false,
								startedAt,
							},
							childTotal: 3,
							childDone: index % 4,
							childFailed: 0,
						},
						{
							entry: {
								homeRunId: "stress-parallel",
								conversationId: "home:stress:b",
								label: "parallel conversation",
								settled: false,
								startedAt,
							},
						},
					],
				});
				if (index % 5 === 0) {
					stdout.columns = index % 10 === 0 ? 60 : 100;
					stdout.emit("resize");
				}
				await settleRender(instance);
				const tick = takeRaw();
				allIncrementalOutput += tick;
				// Live ticks may patch only changed cells, but they must never bring
				// the removed footer back or repaint the unchanged composer.
				expect(tick).not.toContain("Ctrl-D quit");
				expect(tick).not.toContain("Send a message");
			}

			expect(allIncrementalOutput).not.toContain("Ctrl-D quit");
			emit({
				...liveState(21, startedAt),
				thinkingSince: null,
				panelStates: [],
				pendingCommits: [
					{
						id: "stress-answer",
						speaker: "kernel",
						lines: ["Stress loop settled once"],
					},
				],
			});
			await settleRender(instance);
			const settled = takeRaw();
			expect(settled.match(/Stress loop settled once/g) ?? []).toHaveLength(1);
			// Ink may leave an unchanged static composer row untouched (zero bytes),
			// or repaint it once when the live region collapses. More than one is the
			// duplication regression this stress loop certifies against.
			expect(
				(settled.match(/Send a message/g) ?? []).length,
			).toBeLessThanOrEqual(1);
			expect(settled).not.toContain("Ctrl-D quit");
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	}, 20_000);

	test("spinner ticks omit unchanged composer text before and after resize", async () => {
		isolateConfig();
		const { controller, emit, hasSubscribers } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				// Ink intentionally disables interactive redraws when CI=true unless
				// explicitly overridden. These tests exercise the interactive renderer.
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			await waitForSubscription(hasSubscribers);
			const startedAt = Date.now();
			emit(liveState(0, startedAt));
			await settleRender(instance);
			takeRaw();

			emit(liveState(1, startedAt));
			await settleRender(instance);
			const firstTick = takeRaw();

			emit(liveState(2, startedAt));
			await settleRender(instance);
			// Ink may coalesce either adjacent state update on a loaded CI runner.
			// The invariant is that the incremental tick window contains the live row
			// without repainting static composer/footer text, not that frame 2 alone
			// must flush bytes.
			const tick = firstTick + takeRaw();
			expect(tick).toContain("Contacting Home");
			expect(tick).not.toContain("Send a message");
			expect(tick).not.toContain("Ctrl-D quit");

			stdout.columns = 60;
			stdout.emit("resize");
			await settleRender(instance);
			takeRaw();

			emit(liveState(3, startedAt));
			await settleRender(instance);
			const firstPostResizeTick = takeRaw();

			emit(liveState(4, startedAt));
			await settleRender(instance);
			const postResizeTick = firstPostResizeTick + takeRaw();
			expect(postResizeTick).toContain("Contacting Home");
			expect(postResizeTick).not.toContain("Send a message");
			expect(postResizeTick).not.toContain("Ctrl-D quit");
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});

	test("Ctrl-L clears through Ink and redraws one composer without a footer", async () => {
		isolateConfig();
		const { controller } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={["TEDIX"]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			takeRaw();
			stdin.write("\x0c");
			await settleRender(instance);
			const cleared = takeRaw();
			expect(cleared).toContain("\x1b[2J\x1b[3J\x1b[H");
			expect(cleared.match(/TEDIX/g) ?? []).toHaveLength(1);
			expect(cleared.match(/Send a message/g) ?? []).toHaveLength(1);
			expect(cleared).not.toContain("Ctrl-D quit");
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});

	test("unmount erases the dynamic composer before returning to the shell", async () => {
		isolateConfig();
		const { controller } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={["TEDIX"]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		await settleRender(instance);
		takeRaw();
		stdin.write("\x04");
		await instance.waitUntilExit();
		eraseInteractiveComposer(stdout);
		const teardown = takeRaw();
		expect(teardown).toContain("\x1b[2K");
		expect(teardown).not.toContain("Send a message");
		instance.unmount();
	});

	test("/new clear frame includes its announcement before one composer", async () => {
		isolateConfig();
		const { controller, emit } = makeController();
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={controller} greeting={["TEDIX"]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			takeRaw();
			emit({
				...liveState(0, Date.now()),
				clearScreenSeq: 1,
				clearScreenLines: ["✓ Now in session test — fresh context"],
			});
			await settleRender(instance);
			const cleared = takeRaw();
			expect(cleared).toContain("✓ Now in session test — fresh context");
			expect(cleared.match(/TEDIX/g) ?? []).toHaveLength(1);
			expect(cleared.match(/Send a message/g) ?? []).toHaveLength(1);
			expect(cleared).not.toContain("Ctrl-D quit");
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});
});

describe("Ink slash-command transitions", () => {
	test("active turns queue follow-ups and Esc steers instead of forking", async () => {
		isolateConfig();
		const kit = makeController();
		kit.setForeground({ homeRunId: "run-active", label: "Research" });
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			view.stdin.write("focus on primary sources\r");
			await waitForCondition(
				() => view.lastFrame()?.includes("Queued 1/5") === true,
				"queued follow-up did not render",
			);
			expect(kit.dispatched).toEqual([]);

			view.stdin.write("\x1b");
			await waitForCondition(
				() => kit.steers.length === 1,
				"queued follow-up was not steered",
			);
			expect(kit.steers).toEqual(["focus on primary sources"]);
			expect(kit.dispatched).toEqual([]);
		} finally {
			view.unmount();
		}
	});

	test("empty-queue Esc arms cancellation instead of interrupting immediately", async () => {
		isolateConfig();
		const kit = makeController();
		kit.setForeground({ homeRunId: "run-active", label: "Research" });
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			view.stdin.write("\x1b");
			await waitForCondition(
				() =>
					view.lastFrame()?.includes("Esc again to cancel the active run") ===
					true,
				"cancel confirmation did not render",
			);
			expect(kit.interrupts()).toBe(0);
		} finally {
			view.unmount();
		}
	});

	test("/parallel explicitly bypasses the active-turn queue", async () => {
		isolateConfig();
		const kit = makeController();
		kit.setForeground({ homeRunId: "run-active", label: "Research" });
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			view.stdin.write("/parallel inspect billing independently\r");
			await waitForCondition(
				() => kit.dispatched.length === 1,
				"parallel message was not dispatched",
			);
			expect(kit.dispatched).toEqual(["inspect billing independently"]);
			expect(view.lastFrame()).not.toContain("Queued 1/5");
		} finally {
			view.unmount();
		}
	});

	test("ask_human choices own input and answer without leaking prose", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				questionPrompt: {
					homeRunId: "run-question",
					prompt: "Which workspace should I inspect?",
					options: [
						{ label: "Tedix", value: "Tedix" },
						{ label: "Globex", value: "Globex" },
					],
					resolving: false,
				},
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("Home needs your input") === true,
				"question modal did not render",
			);
			expect(view.lastFrame()).not.toContain("Send a message");
			view.stdin.write("2");
			await waitForCondition(
				() => kit.questionResponses.length === 1,
				"number key did not answer question",
			);
			expect(kit.questionResponses).toEqual(["Globex"]);
			expect(kit.dispatched).toEqual([]);
		} finally {
			view.unmount();
		}
	});

	test("approval modal owns input and resolves exactly once", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				approvalPrompt: {
					homeRunId: "run-cmo",
					targetLabel: "CMO",
					detail: "Read current blog status",
					reason:
						"CMO is in standby. Approval wakes it and dispatches this work order.",
					scope: "delegate:cmo",
					scopeLabel: "CMO delegations",
					resolving: false,
				},
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("CMO needs approval") === true,
				"approval modal did not render",
			);

			expect(view.lastFrame()).toContain("CMO needs approval");
			expect(view.lastFrame()).toContain(
				"Always allow CMO delegations this session",
			);
			expect(view.lastFrame()).not.toContain("delegate:cmo");
			expect(view.lastFrame()).toContain("Approve once");
			expect(view.lastFrame()).toContain("Why: CMO is in standby");
			expect(view.lastFrame()).toContain("Run run-cmo");
			expect(view.lastFrame()).not.toContain("Send a message");

			// Down selects session-scoped approval; ordinary text is consumed by the
			// modal rather than submitted as a second Home inference turn.
			view.stdin.write("approved");
			view.stdin.write("\x1b[B\r");
			await waitForCondition(
				() => kit.approvalResponses.length === 1,
				"approval response was not recorded",
			);
			expect(kit.dispatched).toEqual([]);
			expect(kit.approvalResponses).toEqual([
				{ decision: "approve", rememberForSession: true },
			]);
		} finally {
			view.unmount();
		}
	});

	test("arrow keys can select Reject and Enter resolves without inference", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				approvalPrompt: {
					homeRunId: "run-cfo",
					targetLabel: "CFO",
					detail: "Inspect the catalog",
					scope: "delegate:cfo",
					scopeLabel: "CFO delegations",
					resolving: false,
				},
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("CFO needs approval") === true,
				"approval modal did not render",
			);

			view.stdin.write("\x1b[B\x1b[B\r");
			await waitForCondition(
				() => kit.approvalResponses.length === 1,
				"reject response was not recorded",
			);
			expect(kit.dispatched).toEqual([]);
			expect(kit.approvalResponses).toEqual([
				{ decision: "reject", rememberForSession: false },
			]);
		} finally {
			view.unmount();
		}
	});

	test("session picker owns Up/Down, Enter, and Esc", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				sessionPicker: {
					currentConversationId: "home:one",
					items: [
						{ id: "home:one", title: "Current session" },
						{ id: "home:two", title: "Middle session" },
						{ id: "home:three", title: "Selected session" },
					],
				},
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("Resume a session") === true,
				"session picker did not render",
			);

			expect(view.lastFrame()).toContain("Resume a session");
			expect(view.lastFrame()).toContain(
				"↑/↓ move · PgUp/PgDn page · Enter resume · Esc cancel",
			);
			expect(view.lastFrame()).not.toContain("Send a message");

			// Coalesced terminal input must chain synchronously: two Down events and
			// Enter in one burst select the third row, never the stale second row.
			view.stdin.write("\x1b[B\x1b[B\r");
			await waitForCondition(
				() =>
					kit.selectedSessions.length === 1 &&
					view.lastFrame()?.includes("› Selected session") === true,
				"coalesced Down/Down/Enter did not select the third session",
			);
			expect(view.lastFrame()).toContain("› Selected session");
			expect(kit.selectedSessions).toEqual(["home:three"]);

			view.stdin.write("\x1b");
			await waitForCondition(
				() => kit.pickerDismissals() === 1,
				"Esc did not dismiss the session picker",
			);
			expect(kit.pickerDismissals()).toBe(1);
		} finally {
			view.unmount();
		}
	});

	test("session viewport scrolls, pages and follows renderer row changes", async () => {
		isolateConfig();
		const kit = makeController();
		const { stdin, stdout } = testStreams();
		const view = renderInk(
			<InkRepl controller={kit.controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				stdin,
				stdout,
				stderr: stdout,
			},
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			const items = Array.from({ length: 30 }, (_, index) => ({
				id: `session:${index}`,
				title: `Session ${index}`,
			}));
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				sessionPicker: { items, currentConversationId: "session:0" },
			});
			await view.waitUntilRenderFlush();
			stdin.write("\x1b[6~\r");
			await waitForCondition(
				() => kit.selectedSessions.length === 1,
				"page selection missing",
			);
			expect(kit.selectedSessions).toEqual(["session:10"]);
			stdout.rows = 12;
			stdout.emit("resize");
			await settleRender(view);
			stdin.write("\x1b[6~\r");
			await waitForCondition(
				() => kit.selectedSessions.length === 2,
				"resized page selection missing",
			);
			expect(kit.selectedSessions[1]).toBe("session:14");
			stdin.write("\x1b[5~\r");
			await waitForCondition(
				() => kit.selectedSessions.length === 3,
				"page up selection missing",
			);
			expect(kit.selectedSessions[2]).toBe("session:10");
			expect(kit.dispatched).toEqual([]);
		} finally {
			view.unmount();
			view.cleanup();
		}
	});

	test("native viewport clips offscreen sessions around the current selection", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				sessionPicker: {
					currentConversationId: "session:20",
					items: Array.from({ length: 30 }, (_, index) => ({
						id: `session:${index}`,
						title: `Choice-${index}-end`,
					})),
				},
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("› Choice-20-end") === true,
				"selected row not visible",
			);
			expect(view.lastFrame()).not.toContain("Choice-0-end");
			expect(view.lastFrame()).not.toContain("Choice-29-end");
			expect(view.lastFrame()).toContain("↑ more");
			expect(view.lastFrame()).toContain("↓ more");
		} finally {
			view.unmount();
		}
	});

	test("terminal replies never become composer text and keypad Enter submits", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			view.stdin.write("hello");
			view.stdin.write("\x1b[<0;10;5M\x1b[I\x1b[12;34R");
			view.stdin.write("\x1bOM");
			await waitForCondition(
				() => kit.dispatched.length === 1,
				"keypad Enter did not submit",
			);
			expect(kit.dispatched).toEqual(["hello"]);
		} finally {
			view.unmount();
		}
	});

	test("typeahead shows the command signature while submitting only its name", async () => {
		isolateConfig();
		const { controller, dispatched } = makeController();
		const view = renderForInput(
			<InkRepl
				controller={controller}
				greeting={[]}
				slashCommands={[
					{
						argHint: "[search]",
						description: "List Home conversations",
						name: "sessions",
						source: "interactive",
					},
				]}
			/>,
		);
		try {
			view.stdin.write("/se");
			await waitForCondition(
				() => view.lastFrame()?.includes("/sessions [search]") === true,
				"typeahead did not show the command signature",
			);
			expect(view.lastFrame()).toContain("/sessions [search]");

			view.stdin.write("\r");
			await waitForCondition(
				() => dispatched.length === 1,
				"slash command was not dispatched",
			);
			expect(dispatched).toEqual(["/sessions"]);
		} finally {
			view.unmount();
		}
	});

	test("typeahead completes and submits the highlighted slash command", async () => {
		isolateConfig();
		const { controller, dispatched } = makeController();
		const view = renderForInput(
			<InkRepl
				controller={controller}
				greeting={[]}
				slashCommands={[
					{
						description: "Show command reference",
						name: "help",
						source: "interactive",
					},
				]}
			/>,
		);
		try {
			view.stdin.write("/he");
			await waitForCondition(
				() => view.lastFrame()?.includes("› /he ") === true,
				"typed slash prefix did not reach the composer",
			);
			expect(view.lastFrame()).toContain("/help");

			view.stdin.write("\t");
			await waitForCondition(() => {
				const frame = view.lastFrame();
				return (
					frame?.includes("/help") === true &&
					!frame.includes("Show command reference")
				);
			}, "slash command completion did not replace the suggestion");
			expect(view.lastFrame()).toContain("/help ");

			view.stdin.write("\r");
			await waitForCondition(
				() => dispatched.length === 1,
				"slash command was not dispatched",
			);
			expect(dispatched).toEqual(["/help"]);
		} finally {
			view.unmount();
		}
	});

	test("handled slash output relocates the composer only once", async () => {
		isolateConfig();
		const kit = makeController();
		kit.controller.dispatch = async () => {
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				pendingCommits: [
					{ id: "result", speaker: "output", lines: ["No in-flight runs."] },
				],
			});
			return "handled";
		};
		const { stdin, stdout, takeRaw } = testStreams();
		const instance = renderInk(
			<InkRepl controller={kit.controller} greeting={[]} />,
			{
				...INTERACTIVE_INK_RENDER_OPTIONS,
				interactive: true,
				stdin: stdin,
				stdout: stdout,
				stderr: stdout,
				patchConsole: false,
			},
		);

		try {
			await settleRender(instance);
			takeRaw();
			stdin.write("/runs\r");
			await settleRender(instance);
			const output = takeRaw();
			expect(output).toContain("No in-flight runs.");
			expect(output).not.toContain("› /runs");
			expect(output.match(/Send a message/g) ?? []).toHaveLength(1);
		} finally {
			instance.unmount();
			await instance.waitUntilExit();
		}
	});
});

describe("Ink attachment completion", () => {
	test("shows an @path candidate and commits it with Tab without sending", async () => {
		isolateConfig();
		const { controller, dispatched } = makeController();
		const view = renderForInput(
			<InkRepl controller={controller} greeting={[]} />,
		);
		try {
			view.stdin.write("@pack");
			await waitForCondition(() => {
				const frame = view.lastFrame();
				return (
					frame?.includes("@package.json") === true &&
					frame.includes("Attach file")
				);
			}, "@path candidate did not render");
			expect(view.lastFrame()).toContain("@package.json");
			expect(view.lastFrame()).toContain("Attach file");

			view.stdin.write("\t");
			await waitForCondition(() => {
				const frame = view.lastFrame();
				return (
					frame?.includes("@package.json") === true &&
					!frame.includes("Attach file")
				);
			}, "Tab did not commit the @path candidate");
			expect(view.lastFrame()).toContain("@package.json");
			expect(view.lastFrame()).not.toContain("Attach file");
			expect(dispatched).toEqual([]);
		} finally {
			view.unmount();
		}
	});
});

describe("Ink reverse history search", () => {
	test("Ctrl-R recalls matching entries newest-first without submitting", async () => {
		isolateConfig();
		appendReplHistory("deploy staging");
		appendReplHistory("inspect run abc");
		appendReplHistory("deploy production");
		const { controller, dispatched } = makeController();
		const view = renderForInput(
			<InkRepl controller={controller} greeting={[]} />,
		);
		try {
			view.stdin.write("deploy");
			await waitForCondition(
				() => view.lastFrame()?.includes("deploy") === true,
				"typed query did not reach the composer",
			);
			view.stdin.write("\x12");
			await waitForCondition(() => {
				const frame = view.lastFrame();
				return (
					frame?.includes("deploy production") === true &&
					frame.includes("match 3/3")
				);
			}, "Ctrl-R did not recall the newest match");
			expect(view.lastFrame()).toContain("deploy production");
			expect(view.lastFrame()).toContain("match 3/3");

			view.stdin.write("\x12");
			await waitForCondition(() => {
				const frame = view.lastFrame();
				return (
					frame?.includes("deploy staging") === true &&
					frame.includes("match 1/3")
				);
			}, "second Ctrl-R did not wrap to the oldest match");
			expect(view.lastFrame()).toContain("deploy staging");
			expect(view.lastFrame()).toContain("match 1/3");
			expect(dispatched).toEqual([]);
		} finally {
			view.unmount();
		}
	});
});

function renderSized(
	tree: Parameters<typeof renderInk>[0],
	streams: ReturnType<typeof testStreams>,
) {
	let frame = "";
	streams.stdout.on("data", (chunk) => {
		const rendered = stripVTControlCharacters(chunk.toString()).trimEnd();
		if (rendered) frame = rendered;
	});
	const instance = renderInk(tree, {
		...INTERACTIVE_INK_RENDER_OPTIONS,
		debug: true,
		stdin: streams.stdin,
		stdout: streams.stdout,
		stderr: streams.stdout,
		patchConsole: false,
	});
	return { ...instance, lastFrame: () => frame };
}

describe("terminal height and decision detail ownership", () => {
	test("many runs, children, queue and typeahead leave the composer visible after resize", async () => {
		isolateConfig();
		const kit = makeController();
		const { stdin, stdout } = testStreams();
		stdout.rows = 12;
		stdout.columns = 40;
		const view = renderSized(
			<InkRepl
				controller={kit.controller}
				greeting={[]}
				slashCommands={Array.from({ length: 8 }, (_, index) => ({
					name: `command${index}`,
					description: "a command",
					source: "interactive" as const,
				}))}
			/>,
			{ stdin, stdout, takeRaw: () => "" },
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.setForeground({ homeRunId: "busy", label: "busy" });
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				panelStates: Array.from({ length: 10 }, (_, index) => ({
					entry: {
						homeRunId: `busy${index}`,
						conversationId: `home:${index}`,
						label: `review ${index}`,
						startedAt: Date.now(),
						settled: false,
					},
					children: Array.from({ length: 6 }, (_, child) => ({
						id: `${index}:${child}`,
						label: `worker ${child}`,
						status: "running" as const,
						objective: "inspect",
					})),
				})),
			});
			await waitForCondition(
				() => view.lastFrame().includes("review 0"),
				"busy frame did not render",
			);
			for (let index = 0; index < 4; index++) {
				stdin.write(`follow up ${index}\r`);
				await waitForCondition(
					() => view.lastFrame().includes(`Queued ${index + 1}/5`),
					"queued frame did not render",
				);
			}
			expect(view.lastFrame()).toContain("Queued 4/5");
			expect(view.lastFrame()).toContain("Send a message");
			expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(11);
			stdin.write("/");
			await waitForCondition(
				() => view.lastFrame().includes("command0"),
				"typeahead did not render",
			);
			expect(view.lastFrame()).toContain("command0");
			expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(11);
			stdout.rows = 8;
			stdout.columns = 30;
			stdout.emit("resize");
			await waitForCondition(
				() =>
					view.lastFrame().includes("╭────────────────────────────╮") &&
					view.lastFrame().split("\n").length <= 7,
				"resized frame did not render",
			);
			expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(7);
			expect(view.lastFrame()).toContain("› /");
		} finally {
			view.unmount();
			view.cleanup();
		}
	});

	test("full approval inspector pages through scope and never approves while inspecting", async () => {
		isolateConfig();
		const kit = makeController();
		const { stdin, stdout } = testStreams();
		stdout.rows = 12;
		stdout.columns = 40;
		const view = renderSized(
			<InkRepl controller={kit.controller} greeting={[]} />,
			{ stdin, stdout, takeRaw: () => "" },
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				approvalPrompt: {
					homeRunId: "long-approval",
					targetLabel: "CTO",
					detail: Array.from(
						{ length: 30 },
						(_, index) => `Detail ${index} important scope information`,
					).join("\n"),
					reason: "A full explanation to review",
					scope: "delegate:entire-scope-final",
					scopeLabel: "review scope end marker",
					resolving: false,
				},
			});
			await waitForCondition(
				() => view.lastFrame().includes("Ctrl-O inspect"),
				"approval frame did not render after terminal startup",
			);
			stdin.write("\x1b[111;5u\x1b[13u\x1b[49u");
			await waitForCondition(
				() => view.lastFrame().includes("Ctrl-O/Esc back"),
				"inspector did not render",
			);
			expect(view.lastFrame()).toContain("Detail 0");
			stdin.write("\r1");
			await settleRender(view);
			expect(kit.approvalResponses).toEqual([]);
			let sawScope = false;
			for (let page = 0; page < 12; page++) {
				const previousFrame = view.lastFrame();
				stdin.write("\x1b[6~");
				await waitForCondition(
					() => view.lastFrame() !== previousFrame,
					"inspector page did not advance",
				);
				sawScope ||= view.lastFrame().includes("delegate:entire-scope-final");
				if (view.lastFrame().includes("Reject")) break;
			}
			expect(sawScope).toBe(true);
			expect(view.lastFrame()).toContain("Reject");
			stdout.columns = 30;
			stdout.rows = 8;
			stdout.emit("resize");
			await waitForCondition(
				() =>
					view.lastFrame().includes("╭────────────────────────────╮") &&
					view.lastFrame().split("\n").length <= 7,
				"resized frame did not render",
			);
			expect(view.lastFrame()!.split("\n").length).toBeLessThanOrEqual(7);
			stdin.write("\x1b[5~");
			await settleRender(view);
			stdin.write("\x1b");
			await waitForCondition(
				() => view.lastFrame().includes("Approve once"),
				"Escape did not close inspector",
			);
			expect(kit.approvalDismissals()).toBe(0);
			expect(view.lastFrame()).toContain("Approve once");
			stdin.write("\r");
			await waitForCondition(
				() => kit.approvalResponses.length === 1,
				"approval choice did not resolve",
			);
			expect(kit.approvalResponses).toEqual([
				{ decision: "approve", rememberForSession: false },
			]);
		} finally {
			view.unmount();
			view.cleanup();
		}
	});

	test("question free text survives inspection and numeric typing stays in its draft", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				questionPrompt: {
					homeRunId: "question",
					prompt:
						"Question start\n" +
						"Full explanatory text\n".repeat(30) +
						"Question end",
					options: [{ label: "Yes", value: "yes" }],
					resolving: false,
				},
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("Home needs your input") === true,
				"question missing",
			);
			view.stdin.write("\x1b[B");
			await waitForCondition(
				() => view.lastFrame()?.includes("Answer Home") === true,
				"free text missing",
			);
			view.stdin.write("draft 1");
			await waitForCondition(
				() => view.lastFrame()?.includes("draft 1") === true,
				"draft missing",
			);
			expect(kit.questionResponses).toEqual([]);
			view.stdin.write("\x1b[111;5u\x1b[13u\x1b[49u");
			await waitForCondition(
				() => view.lastFrame()?.includes("Details") === true,
				"inspector missing",
			);
			view.stdin.write("\r1");
			await Bun.sleep(10);
			expect(kit.questionResponses).toEqual([]);
			view.stdin.write("\x1b");
			await waitForCondition(
				() => view.lastFrame()?.includes("draft 1") === true,
				"draft not restored",
			);
			view.stdin.write("\r");
			await waitForCondition(
				() => kit.questionResponses.length === 1,
				"draft not submitted",
			);
			expect(kit.questionResponses).toEqual(["draft 1"]);
		} finally {
			view.unmount();
		}
	});
});

describe("exclusive editing and queued-draft inspection", () => {
	test("question editor keeps paste, arrows and Enter out of option selection across polling", async () => {
		isolateConfig();
		const kit = makeController();
		const { stdin, stdout } = testStreams();
		stdout.rows = 12;
		stdout.columns = 40;
		const view = renderSized(
			<InkRepl controller={kit.controller} greeting={[]} />,
			{ stdin, stdout, takeRaw: () => "" },
		);
		const question = {
			homeRunId: "same-run",
			prompt: "Answer carefully?",
			options: [{ label: "Yes", value: "yes" }],
			resolving: false,
		};
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				questionPrompt: question,
			});
			await waitForCondition(
				() => view.lastFrame().includes("Home needs your input"),
				"question missing",
			);
			stdin.write("\x1b[B");
			await waitForCondition(
				() => view.lastFrame().includes("Answer Home"),
				"editor did not take focus",
			);
			kit.emit({
				...liveState(1, Date.now()),
				thinkingSince: null,
				questionPrompt: {
					...question,
					options: question.options.map((option) => ({ ...option })),
				},
			});
			await settleRender(view);
			expect(view.lastFrame()).toContain("Answer Home");
			stdin.write("\x1b[200~first\nsecond\x1b[201~\x1b[A\r");
			await waitForCondition(
				() => kit.questionResponses.length === 1,
				"editor did not answer the draft",
			);
			expect(kit.questionResponses).toEqual(["first\nsecond"]);
			expect(kit.dispatched).toEqual([]);
		} finally {
			view.unmount();
			view.cleanup();
		}
	});

	test("Escape restores choices and keeps the editor draft, while changed questions reset focus", async () => {
		isolateConfig();
		const kit = makeController();
		const view = renderForInput(
			<InkRepl controller={kit.controller} greeting={[]} />,
		);
		const question = {
			homeRunId: "same-run",
			prompt: "First question",
			options: [{ label: "Yes", value: "yes" }],
			resolving: false,
		};
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				questionPrompt: question,
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("First question") === true,
				"question missing",
			);
			view.stdin.write("\x1b[B");
			await waitForCondition(
				() => view.lastFrame()?.includes("Answer Home") === true,
				"editor missing",
			);
			view.stdin.write("retained 1");
			await waitForCondition(
				() => view.lastFrame()?.includes("retained 1") === true,
				"draft missing",
			);
			view.stdin.write("\x1b");
			await waitForCondition(
				() => view.lastFrame()?.includes("number/Enter select") === true,
				"Escape did not restore choices",
			);
			expect(view.lastFrame()).not.toContain("retained 1");
			expect(kit.questionDismissals()).toBe(0);
			view.stdin.write("\r");
			await waitForCondition(
				() => view.lastFrame()?.includes("retained 1") === true,
				"draft was not retained",
			);
			expect(kit.questionResponses).toEqual([]);
			view.stdin.write("\x1b[111;5u\x1b[13u\x1b[49u");
			await waitForCondition(
				() => view.lastFrame()?.includes("Ctrl-O/Esc back") === true,
				"inspector missing",
			);
			expect(kit.questionResponses).toEqual([]);
			view.stdin.write("\x1b");
			await waitForCondition(
				() => view.lastFrame()?.includes("retained 1") === true,
				"inspection did not resume editor",
			);
			kit.emit({
				...liveState(2, Date.now()),
				thinkingSince: null,
				questionPrompt: { ...question, prompt: "Changed question" },
			});
			await waitForCondition(
				() => view.lastFrame()?.includes("Changed question") === true,
				"changed question missing",
			);
			expect(view.lastFrame()).not.toContain("retained 1");
			expect(view.lastFrame()).not.toContain("Answer Home");
			view.stdin.write("\x1b");
			await waitForCondition(
				() => kit.questionDismissals() === 1,
				"choices Escape did not leave pending question",
			);
		} finally {
			view.unmount();
		}
	});

	for (const [columns, rows] of [
		[40, 12],
		[30, 8],
	]) {
		test(`all FIFO queue drafts inspect at ${columns}x${rows}, with inert Enter and retained composer`, async () => {
			isolateConfig();
			const kit = makeController();
			const { stdin, stdout } = testStreams();
			stdout.columns = columns!;
			stdout.rows = rows!;
			const view = renderSized(
				<InkRepl controller={kit.controller} greeting={[]} />,
				{ stdin, stdout, takeRaw: () => "" },
			);
			try {
				await waitForSubscription(kit.hasSubscribers);
				kit.setForeground({ homeRunId: "busy", label: "busy" });
				kit.emit({
					...liveState(0, Date.now()),
					thinkingSince: null,
					panelStates: [
						{
							entry: {
								homeRunId: "busy",
								conversationId: "home:busy",
								label: "busy",
								settled: false,
								startedAt: Date.now(),
							},
						},
					],
				});
				await waitForCondition(
					() => view.lastFrame().includes("Send a message"),
					"composer missing",
				);
				for (let index = 1; index <= 5; index++) {
					stdin.write(
						`FIFO-${index}-START ${"long complete draft ".repeat(4)} FIFO-${index}-END\r`,
					);
					await waitForCondition(
						() => view.lastFrame().includes(`Queued ${index}/5`),
						"queued draft missing",
					);
				}
				expect(view.lastFrame()).toContain("Ctrl-Q");
				expect(view.lastFrame()).toContain("hidden");
				stdin.write("keep me");
				await waitForCondition(
					() => view.lastFrame().includes("keep me"),
					"composer draft missing",
				);
				stdin.write("\x1b[113;5u\x1b[13u");
				await waitForCondition(
					() => view.lastFrame().includes("Ctrl-Q/Esc back"),
					"queue inspector missing",
				);
				expect(kit.dispatched).toEqual([]);
				expect(kit.steers).toEqual([]);
				let inspected = view.lastFrame();
				for (
					let page = 0;
					page < 50 && !inspected.includes("FIFO-5-END");
					page++
				) {
					const previous = view.lastFrame();
					stdin.write("\x1b[6~");
					await waitForCondition(
						() => view.lastFrame() !== previous,
						"queue page did not advance",
					);
					inspected += view.lastFrame();
				}
				for (let index = 1; index <= 5; index++) {
					expect(inspected).toContain(`FIFO-${index}-START`);
					expect(inspected).toContain(`FIFO-${index}-END`);
				}
				expect(view.lastFrame().split("\n").length).toBeLessThanOrEqual(
					rows! - 1,
				);
				stdin.write("\x1b");
				await waitForCondition(
					() => view.lastFrame().includes("keep me"),
					"inspector did not restore composer",
				);
				expect(view.lastFrame()).toContain("Queued 5/5");
				expect(kit.dispatched).toEqual([]);
				expect(kit.steers).toEqual([]);
			} finally {
				view.unmount();
				view.cleanup();
			}
		});
	}

	test("empty composer gives activity its measured rows back and wrapped arrows edit instead of recall", async () => {
		isolateConfig();
		const kit = makeController();
		appendReplHistory("HISTORY SHOULD STAY PARKED");
		const { stdin, stdout } = testStreams();
		stdout.rows = 12;
		stdout.columns = 40;
		const view = renderSized(
			<InkRepl controller={kit.controller} greeting={[]} />,
			{ stdin, stdout, takeRaw: () => "" },
		);
		try {
			await waitForSubscription(kit.hasSubscribers);
			kit.emit({
				...liveState(0, Date.now()),
				thinkingSince: null,
				panelStates: Array.from({ length: 10 }, (_, index) => ({
					entry: {
						homeRunId: `run:${index}`,
						conversationId: `home:${index}`,
						label: `Review-${index}-end`,
						settled: false,
						startedAt: Date.now(),
					},
				})),
			});
			await waitForCondition(
				() => view.lastFrame().includes("Review-6-end"),
				"empty draft did not return activity rows",
			);
			const fullDraft = "wrapped draft without newline ".repeat(5);
			stdin.write(`\x1b[200~${fullDraft}\x1b[201~\x1b[A`);
			await waitForCondition(
				() => !view.lastFrame().includes("Review-6-end"),
				"wrapped draft did not reserve measured rows",
			);
			expect(view.lastFrame()).not.toContain("HISTORY SHOULD STAY PARKED");
			stdin.write("\r");
			await waitForCondition(
				() => kit.dispatched.length === 1,
				"wrapped draft did not submit",
			);
			expect(kit.dispatched).toEqual([fullDraft.trim()]);
			await waitForCondition(
				() => view.lastFrame().includes("Review-6-end"),
				"cleared draft did not return activity rows",
			);
		} finally {
			view.unmount();
			view.cleanup();
		}
	});
});
