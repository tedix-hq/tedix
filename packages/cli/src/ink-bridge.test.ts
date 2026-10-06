import { describe, expect, mock, test } from "bun:test";
import type { ConversationPoller } from "./conversation-poller";
import { INK_TICK_MS, InkReplBridge } from "./ink-bridge";
import type { ReplState } from "./ink-repl";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RegistryEntry {
	homeRunId: string;
	label: string;
	startedAt: number;
}

function makeBridge(opts?: {
	registryList?: RegistryEntry[];
	cancel?: (homeRunId: string, reason?: string) => Promise<unknown>;
	resolveApproval?: ConstructorParameters<
		typeof InkReplBridge
	>[0]["resolveApproval"];
}) {
	const states: ReplState[] = [];
	const bridge = new InkReplBridge({
		getRegistryCount: () => opts?.registryList?.length ?? 0,
		getRegistryList: () => opts?.registryList ?? [],
		waitAll: async () => {},
		dispatch: async () => "handled",
		getPanelStates: () => [],
		cancel: opts?.cancel ?? (async () => undefined),
		resolveApproval: opts?.resolveApproval,
	});
	bridge.onUpdate((s) => states.push({ ...s }));
	return { bridge, states };
}

/** Flatten every commit line committed across all pushed states, in order. */
function allCommits(
	states: ReplState[],
): Array<{ speaker: string; lines: string[] }> {
	return states.flatMap((s) =>
		s.pendingCommits.map((c) => ({ speaker: c.speaker, lines: c.lines })),
	);
}

describe("InkReplBridge.dispatch — local command status", () => {
	test("does not show a thinking state for an immediate local command", async () => {
		const states: ReplState[] = [];
		const bridge = new InkReplBridge({
			getRegistryCount: () => 0,
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async () => "handled",
			getPanelStates: () => [],
			cancel: async () => undefined,
			shouldShowThinking: (line) => line !== "/help",
		});
		bridge.onUpdate((state) => states.push({ ...state }));

		await bridge.dispatch("/help");

		expect(states.every((state) => state.thinkingSince === null)).toBe(true);
		bridge.stop();
	});

	test("uses command-specific thinking copy for a remote deterministic read", async () => {
		const states: ReplState[] = [];
		const bridge = new InkReplBridge({
			getRegistryCount: () => 0,
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async () => "handled",
			getPanelStates: () => [],
			cancel: async () => undefined,
			thinkingLabelFor: (line) =>
				line === "/sessions" ? "Loading sessions" : undefined,
		});
		bridge.onUpdate((state) => states.push({ ...state }));

		await bridge.dispatch("/sessions");

		expect(states[0]?.thinkingLabel).toBe("Loading sessions");
		expect(states.at(-1)?.thinkingSince).toBeNull();
		bridge.stop();
	});
});

describe("InkReplBridge conversation poller", () => {
	test("replays early deduplication markers when the poller attaches", () => {
		const { bridge } = makeBridge();
		const markSeen = mock(() => {});
		const markRunSeen = mock(() => {});
		const start = mock(() => {});
		const stop = mock(() => {});
		const poller = {
			markSeen,
			markRunSeen,
			start,
			stop,
		} as unknown as ConversationPoller;

		// Render-first startup lets a quick Home answer settle before its
		// background poller attaches. Those markers must survive that gap.
		bridge.markMessageSeen("run-fast:assistant");
		bridge.markRunSeen("run-fast");
		bridge.startConversationPoller(poller);

		expect(markSeen).toHaveBeenCalledWith("run-fast:assistant");
		expect(markRunSeen).toHaveBeenCalledWith("run-fast");
		expect(start).toHaveBeenCalledTimes(1);
		bridge.stop();
		expect(stop).toHaveBeenCalledTimes(1);
	});

	test("pauses polling before awaiting a remote dispatch", async () => {
		let resolveDispatch: ((value: "dispatched") => void) | undefined;
		const dispatchResult = new Promise<"dispatched">((resolve) => {
			resolveDispatch = resolve;
		});
		const setInflight = mock(() => {});
		const clearInflight = mock(() => {});
		const poller = {
			markSeen: mock(() => {}),
			markRunSeen: mock(() => {}),
			setInflight,
			clearInflight,
			start: mock(() => {}),
			stop: mock(() => {}),
		} as unknown as ConversationPoller;
		const bridge = new InkReplBridge({
			getRegistryCount: () => 0,
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async () => dispatchResult,
			getPanelStates: () => [],
			cancel: async () => undefined,
		});
		bridge.startConversationPoller(poller);

		const dispatching = bridge.dispatch("fast answer");
		expect(setInflight).toHaveBeenCalledTimes(1);
		expect(clearInflight).not.toHaveBeenCalled();

		resolveDispatch?.("dispatched");
		await dispatching;
		expect(clearInflight).toHaveBeenCalledTimes(1);
		bridge.stop();
	});
});

describe("InkReplBridge session picker", () => {
	test("publishes modal state and resumes the selected conversation", async () => {
		const states: ReplState[] = [];
		const dispatched: string[] = [];
		const bridge = new InkReplBridge({
			getRegistryCount: () => 0,
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async (line) => {
				dispatched.push(line);
				return "handled";
			},
			getPanelStates: () => [],
			cancel: async () => undefined,
		});
		bridge.onUpdate((state) => states.push({ ...state }));

		bridge.showSessionPicker(
			[
				{ id: "home:one", title: "One" },
				{ id: "home:two", title: "Two" },
			],
			"home:one",
		);
		expect(states.at(-1)?.sessionPicker?.items).toHaveLength(2);

		await bridge.selectSession("home:two");
		await bridge.selectSession("home:two");

		expect(states.at(-1)?.sessionPicker).toBeNull();
		expect(dispatched).toEqual(["/resume home:two"]);
		bridge.stop();
	});
});

describe("InkReplBridge approval prompt", () => {
	test("resolves once without dispatching a conversational turn", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const { bridge, states } = makeBridge({
			resolveApproval: async (input) => {
				calls.push(input);
			},
		});

		bridge.showApproval({
			homeRunId: "run-approve",
			targetLabel: "CMO",
			detail: "Read current campaign status",
			scope: "delegate:cmo",
			scopeLabel: "CMO delegations",
		});
		expect(states.at(-1)?.approvalPrompt?.resolving).toBe(false);

		await Promise.all([
			bridge.respondApproval("approve", true),
			bridge.respondApproval("approve", true),
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			homeRunId: "run-approve",
			decision: "approve",
			rememberForSession: true,
		});
		expect(states.at(-1)?.approvalPrompt).toBeNull();
		expect(allCommits(states).at(-1)?.lines.join(" ")).toContain(
			"CMO approved for this session",
		);
		bridge.stop();
	});

	test("failed resolution keeps the modal actionable", async () => {
		const { bridge, states } = makeBridge({
			resolveApproval: async () => {
				throw new Error("network lost");
			},
		});
		bridge.showApproval({
			homeRunId: "run-fail",
			targetLabel: "CTO",
			detail: "Run a write",
			scope: "delegate:cto",
			scopeLabel: "CTO delegations",
		});

		await bridge.respondApproval("approve", false);

		expect(states.at(-1)?.approvalPrompt?.resolving).toBe(false);
		expect(allCommits(states).at(-1)?.lines.join(" ")).toContain(
			"Approval failed",
		);
		bridge.stop();
	});
});

describe("InkReplBridge typed lifecycle", () => {
	test("tracks dispatch, settlement, and answer boundaries", async () => {
		const states: ReplState[] = [];
		const bridge = new InkReplBridge({
			getRegistryCount: () => 1,
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async () => "dispatched",
			getPanelStates: () => [],
			cancel: async () => {},
		});
		bridge.onUpdate((state) => states.push(state));

		await bridge.dispatch("summarize this run");
		expect(states.at(-1)?.lifecycle).toBe("contacting_home");

		bridge.markDispatchInflight();
		expect(states.at(-1)?.lifecycle).toBe("awaiting_settlement");

		bridge.commitLines("kernel", ["Settled answer"]);
		expect(states.at(-1)?.lifecycle).toBe("idle");
		bridge.stop();
	});
});

describe("InkReplBridge rendering cadence", () => {
	test("idle bridge publishes no animation frames", async () => {
		const { bridge, states } = makeBridge();

		await Bun.sleep(INK_TICK_MS + 75);

		expect(states).toHaveLength(0);
		bridge.stop();
	});

	test("settled answer clears thinking and commits in one publication", () => {
		const { bridge, states } = makeBridge();
		bridge.markDispatchInflight();
		const beforeCommit = states.length;

		bridge.commitLines("kernel", ["canonical answer"]);

		expect(states).toHaveLength(beforeCommit + 1);
		const settled = states.at(-1);
		expect(settled?.thinkingSince).toBeNull();
		expect(settled?.pendingCommits).toHaveLength(1);
		expect(settled?.pendingCommits[0]?.lines).toEqual(["canonical answer"]);
		bridge.stop();
	});

	test("clearing an already-idle thinking state does not repaint", () => {
		const { bridge, states } = makeBridge();

		bridge.clearDispatchInflight();

		expect(states).toHaveLength(0);
		bridge.stop();
	});

	test("clear-screen lines publish once and are drained", () => {
		const { bridge, states } = makeBridge();

		bridge.clearTranscript(["fresh session"]);
		expect(states.at(-1)?.clearScreenLines).toEqual(["fresh session"]);

		bridge.setConnection("lost");
		expect(states.at(-1)?.clearScreenLines).toEqual([]);
		bridge.stop();
	});

	test("session rebuild clears stale command liveness before the clear frame", async () => {
		const { bridge, states } = makeBridge();
		bridge.markDispatchInflight();

		await bridge.rebuildTranscript(["compacted session"]);

		const rebuilt = states.at(-1);
		expect(rebuilt?.clearScreenLines).toEqual(["compacted session"]);
		expect(rebuilt?.thinkingSince).toBeNull();
		expect(rebuilt?.lifecycle).toBe("idle");
		const preClear = states.at(-2);
		expect(preClear?.clearScreenLines).toEqual([]);
		expect(preClear?.thinkingSince).toBeNull();
		bridge.stop();
	});
});

// ---------------------------------------------------------------------------
// interruptForeground: foreground selection
// ---------------------------------------------------------------------------

describe("InkReplBridge.interruptForeground — foreground selection", () => {
	test("picks the newest (most-recently-started) run when multiple are in flight", async () => {
		// InFlightRegistry.list() sorts ASCENDING by startedAt (oldest first), so
		// the foreground (newest) entry is the LAST element of the array.
		const registryList: RegistryEntry[] = [
			{ homeRunId: "run-oldest", label: "first question", startedAt: 1000 },
			{ homeRunId: "run-middle", label: "second question", startedAt: 2000 },
			{ homeRunId: "run-newest", label: "third question", startedAt: 3000 },
		];
		const cancelCalls: Array<{ homeRunId: string; reason?: string }> = [];
		const { bridge } = makeBridge({
			registryList,
			cancel: async (homeRunId, reason) => {
				cancelCalls.push({ homeRunId, reason });
			},
		});

		await bridge.interruptForeground();

		expect(cancelCalls).toHaveLength(1);
		expect(cancelCalls[0]?.homeRunId).toBe("run-newest");
		bridge.stop();
	});

	test("a single in-flight run is always the foreground", async () => {
		const registryList: RegistryEntry[] = [
			{ homeRunId: "run-only", label: "only question", startedAt: 500 },
		];
		const cancelCalls: string[] = [];
		const { bridge } = makeBridge({
			registryList,
			cancel: async (homeRunId) => {
				cancelCalls.push(homeRunId);
			},
		});

		await bridge.interruptForeground();

		expect(cancelCalls).toEqual(["run-only"]);
		bridge.stop();
	});
});

// ---------------------------------------------------------------------------
// interruptForeground: empty registry no-ops
// ---------------------------------------------------------------------------

describe("InkReplBridge.interruptForeground — empty registry", () => {
	test("no-ops when nothing is in flight: cancel is never called", async () => {
		const cancel = mock(async () => undefined);
		const { bridge } = makeBridge({ registryList: [], cancel });

		await bridge.interruptForeground();

		expect(cancel).not.toHaveBeenCalled();
		bridge.stop();
	});

	test("no-ops when nothing is in flight: no transcript line is committed", async () => {
		const { bridge, states } = makeBridge({ registryList: [] });

		await bridge.interruptForeground();

		expect(allCommits(states)).toHaveLength(0);
		bridge.stop();
	});
});

// ---------------------------------------------------------------------------
// interruptForeground: cancel is called with the correct args
// ---------------------------------------------------------------------------

describe("InkReplBridge.interruptForeground — cancel call args", () => {
	test("cancel is invoked with the foreground homeRunId and reason 'canceled via Esc'", async () => {
		const registryList: RegistryEntry[] = [
			{ homeRunId: "run-abc", label: "do the thing", startedAt: 1 },
		];
		const cancelCalls: Array<{ homeRunId: string; reason?: string }> = [];
		const { bridge } = makeBridge({
			registryList,
			cancel: async (homeRunId, reason) => {
				cancelCalls.push({ homeRunId, reason });
			},
		});

		await bridge.interruptForeground();

		expect(cancelCalls).toEqual([
			{ homeRunId: "run-abc", reason: "canceled via Esc" },
		]);
		bridge.stop();
	});

	test("a cancel RPC rejection does not throw out of interruptForeground", async () => {
		const registryList: RegistryEntry[] = [
			{ homeRunId: "run-fails", label: "flaky", startedAt: 1 },
		];
		const { bridge } = makeBridge({
			registryList,
			cancel: async () => {
				throw new Error("network error");
			},
		});

		await expect(bridge.interruptForeground()).resolves.toBeUndefined();
		bridge.stop();
	});
});

// ---------------------------------------------------------------------------
// interruptForeground: transcript acknowledgment
// ---------------------------------------------------------------------------

describe("InkReplBridge.interruptForeground — transcript acknowledgment", () => {
	test("commits an acknowledgment line naming the foreground run's label", async () => {
		const registryList: RegistryEntry[] = [
			{ homeRunId: "run-1", label: "summarize the budget", startedAt: 1 },
		];
		const { bridge, states } = makeBridge({ registryList });

		await bridge.interruptForeground();

		const commits = allCommits(states);
		expect(commits).toHaveLength(1);
		expect(commits[0]?.speaker).toBe("system");
		expect(commits[0]?.lines.join("\n")).toContain("summarize the budget");
		bridge.stop();
	});

	test("the acknowledgment commits BEFORE the cancel round-trip resolves", async () => {
		const registryList: RegistryEntry[] = [
			{ homeRunId: "run-1", label: "slow cancel", startedAt: 1 },
		];
		let resolveCancel: (() => void) | undefined;
		const cancelPromise = new Promise<void>((resolve) => {
			resolveCancel = resolve;
		});
		const { bridge, states } = makeBridge({
			registryList,
			cancel: async () => cancelPromise,
		});

		const interrupting = bridge.interruptForeground();

		// The cancel RPC has not resolved yet, but the acknowledgment must
		// already be in the transcript — commitLines happens before the await.
		await Promise.resolve();
		expect(allCommits(states)).toHaveLength(1);

		resolveCancel?.();
		await interrupting;
		bridge.stop();
	});

	test("a 'system' acknowledgment does not clear an active thinking spinner", () => {
		// Mirrors the existing banner/output/you non-answer guarantee: the
		// interrupt notice is informational, not the turn's settlement — the
		// real settle path (poller / backgroundSettleInk) still owns clearing
		// the spinner once the run actually reports 'canceled'.
		const { bridge, states } = makeBridge();
		bridge.markDispatchInflight();
		bridge.commitLines("system", ["Interrupting slow cancel…"]);
		expect(states.at(-1)?.thinkingSince).not.toBeNull();
		bridge.stop();
	});
});

describe("InkReplBridge prompt ownership", () => {
	const approval = {
		homeRunId: "run-old",
		targetLabel: "CTO",
		detail: "Original request",
		scope: "delegate:cto",
		scopeLabel: "CTO delegations",
	};
	const question = {
		homeRunId: "run-question",
		prompt: "Which workspace?",
		options: [],
	};

	test("only the most recently shown prompt owns input", () => {
		const { bridge, states } = makeBridge();
		try {
			bridge.showSessionPicker(
				[{ id: "session", title: "Session" }],
				"current",
			);
			bridge.showApproval(approval);
			bridge.showQuestion(question);
			bridge.showSessionPicker([{ id: "next", title: "Next" }], "current");
			for (const state of states) {
				expect(
					[
						state.sessionPicker,
						state.approvalPrompt,
						state.questionPrompt,
					].filter(Boolean),
				).toHaveLength(1);
			}
		} finally {
			bridge.stop();
		}
	});

	for (const next of ["approval", "question", "session"] as const) {
		for (const outcome of ["success", "failure"] as const) {
			test(`late approval ${outcome} preserves the newer ${next}`, async () => {
				let resolve!: () => void;
				let reject!: (error: Error) => void;
				const pending = new Promise<void>((yes, no) => {
					resolve = yes;
					reject = no;
				});
				const { bridge, states } = makeBridge({
					resolveApproval: () => pending,
				});
				try {
					bridge.showApproval(approval);
					const response = bridge.respondApproval("approve", false);
					if (next === "approval")
						bridge.showApproval({ ...approval, detail: "Updated request" });
					else if (next === "question") bridge.showQuestion(question);
					else
						bridge.showSessionPicker(
							[{ id: "session", title: "Session" }],
							"current",
						);
					const newer = states.at(-1)!;
					if (outcome === "success") resolve();
					else reject(new Error("network lost"));
					await response;
					const latest = states.at(-1)!;
					expect(latest.sessionPicker).toBe(newer.sessionPicker);
					expect(latest.approvalPrompt).toBe(newer.approvalPrompt);
					expect(latest.questionPrompt).toBe(newer.questionPrompt);
					expect(
						[
							latest.sessionPicker,
							latest.approvalPrompt,
							latest.questionPrompt,
						].filter(Boolean),
					).toHaveLength(1);
				} finally {
					resolve();
					bridge.stop();
				}
			});
		}
	}

	test("a stale approval failure does not stop a newer turn's thinking state", async () => {
		let reject!: (error: Error) => void;
		const pending = new Promise<void>((_resolve, no) => {
			reject = no;
		});
		const { bridge, states } = makeBridge({ resolveApproval: () => pending });
		try {
			bridge.showApproval(approval);
			const response = bridge.respondApproval("approve", false);
			bridge.showSessionPicker([], "current");
			bridge.dismissSessionPicker();
			bridge.markDispatchInflight();
			const thinking = states.at(-1)!.thinkingSince;
			expect(thinking).not.toBeNull();
			reject(new Error("network lost"));
			await response;
			expect(states.at(-1)!.thinkingSince).toBe(thinking);
			expect(allCommits(states).at(-1)?.lines.join(" ")).toContain("run-old");
		} finally {
			bridge.stop();
		}
	});

	test("a replaced approval cannot receive the active prompt response", async () => {
		const resolveApproval = mock(async () => {});
		const { bridge, states } = makeBridge({ resolveApproval });
		try {
			bridge.showApproval(approval);
			bridge.showQuestion(question);
			await bridge.respondApproval("approve", true);
			expect(resolveApproval).not.toHaveBeenCalled();
			expect(states.at(-1)?.questionPrompt?.homeRunId).toBe("run-question");
		} finally {
			bridge.stop();
		}
	});

	test("dismissing an inactive prompt leaves the active question alone", () => {
		const { bridge, states } = makeBridge();
		try {
			bridge.showApproval(approval);
			bridge.showQuestion(question);
			const active = states.at(-1)!.questionPrompt;
			bridge.dismissApproval();
			bridge.dismissSessionPicker();
			expect(states.at(-1)!.questionPrompt).toBe(active);
			expect(states.at(-1)!.approvalPrompt).toBeNull();
		} finally {
			bridge.stop();
		}
	});
});
