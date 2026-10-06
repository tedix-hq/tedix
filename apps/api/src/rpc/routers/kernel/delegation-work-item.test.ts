import type { kernelRuntimeRuns } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	autoDispatchDeferredAssignment,
	classifyDelegationFailureRecovery,
	createDelegationWorkItem,
	delegationCompletionProofBody,
	delegationProofTranscriptPreview,
	delegationTerminalCommentId,
	delegationWorkItemHeartbeatBody,
	delegationWorkItemHeartbeatCommentId,
	directDelegationDispatchContent,
	extractDelegationProofRefs,
	isStaleDelegationDispatchRow,
	isWorkstationDispatchedRunRow,
	KERNEL_DELEGATE_ENQUEUE_BUDGET_MS,
	KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS,
	KERNEL_WORKSTATION_DISPATCH_TIMEOUT_MS,
	recordDelegationWorkItemHeartbeat,
	resolveDelegationWorkItemId,
} from "./delegation-work-item";

vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/admissions")
		>();
	return {
		...original,
		evaluateAndRecordWorkAdmission: vi.fn(async (_db, input) => ({
			id: `admission:${input.workItemId}:${input.executorId}`,
			decision: "admitted" as const,
		})),
	};
});

type RunRow = typeof kernelRuntimeRuns.$inferSelect;

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
	const now = new Date().toISOString();
	return {
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "running",
		delegatedTediId: "tedi-cto",
		childRunId: "child-1",
		startedAt: now,
		updatedAt: now,
		createdAt: now,
		metadata: {},
		runtimeMetadata: {},
		...overrides,
	} as unknown as RunRow;
}

describe("isWorkstationDispatchedRunRow", () => {
	it("is true when runtimeMetadata.dispatch is workstation-dispatched", () => {
		expect(
			isWorkstationDispatchedRunRow(
				makeRunRow({ runtimeMetadata: { dispatch: "workstation-dispatched" } }),
			),
		).toBe(true);
	});

	it("is false for isolate dispatch or missing runtimeMetadata", () => {
		expect(isWorkstationDispatchedRunRow(makeRunRow())).toBe(false);
		expect(
			isWorkstationDispatchedRunRow(
				makeRunRow({ runtimeMetadata: { dispatch: "isolate" } }),
			),
		).toBe(false);
		expect(
			isWorkstationDispatchedRunRow(makeRunRow({ runtimeMetadata: null })),
		).toBe(false);
	});
});

describe("isStaleDelegationDispatchRow", () => {
	it("is false for terminal / non-active statuses", () => {
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({
					status: "completed",
					startedAt: new Date(Date.now() - 600_000).toISOString(),
				}),
			),
		).toBe(false);
	});

	it("is false when the row lacks a delegated tedi or child run", () => {
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({
					delegatedTediId: null,
					startedAt: new Date(Date.now() - 600_000).toISOString(),
				}),
			),
		).toBe(false);
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({
					childRunId: null,
					startedAt: new Date(Date.now() - 600_000).toISOString(),
				}),
			),
		).toBe(false);
	});

	it("is false for an unparseable reference timestamp", () => {
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({
					startedAt: "not-a-date",
					updatedAt: "also-bad",
					createdAt: "still-bad",
				}),
			),
		).toBe(false);
	});

	it("is false for a fresh isolate dispatch and true once past the first-event window", () => {
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({ startedAt: new Date(Date.now() - 10_000).toISOString() }),
			),
		).toBe(false);
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({ startedAt: new Date(Date.now() - 120_000).toISOString() }),
			),
		).toBe(true);
	});

	it("leaves a child alone while its own start watchdog may still repair it", () => {
		// The child runtime's start watchdog first looks at 60s
		// (apps/tedi-runtime/src/workflow-start-watchdog.ts). A parent window
		// inside that would seal a run the child is still recovering, which is
		// what the old shared 45s constant did.
		expect(KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS).toBeGreaterThan(60_000);
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({ startedAt: new Date(Date.now() - 61_000).toISOString() }),
			),
		).toBe(false);
	});

	it("gives each delegation attempt its own terminal comment id", () => {
		// Attempt 0 keeps the historical id so existing rows still match...
		expect(delegationTerminalCommentId("wi-1", "failed")).toBe(
			"wi-1:terminal:failed",
		);
		expect(delegationTerminalCommentId("wi-1", "failed", 0)).toBe(
			"wi-1:terminal:failed",
		);
		// ...but a retried-then-refailed delegation must not collide with it,
		// or onConflictDoNothing silently drops the second real failure.
		expect(delegationTerminalCommentId("wi-1", "failed", 1)).toBe(
			"wi-1:terminal:failed:1",
		);
		expect(delegationTerminalCommentId("wi-1", "failed", 1)).not.toBe(
			delegationTerminalCommentId("wi-1", "failed", 0),
		);
	});

	it("stays stable for repeated reconciles of the same attempt", () => {
		// The race guard the deterministic id exists for: two reconciles of the
		// SAME attempt still produce one row.
		expect(delegationTerminalCommentId("wi-2", "failed", 2)).toBe(
			delegationTerminalCommentId("wi-2", "failed", 2),
		);
		expect(delegationTerminalCommentId("wi-2", "done", 2)).not.toBe(
			delegationTerminalCommentId("wi-2", "failed", 2),
		);
	});

	it("keeps the enqueue budget well inside the first-event window", () => {
		// Two clocks, two constants: the enqueue budget bounds the apps/api ->
		// child accept leg, the first-event window bounds the child's silence.
		// Collapsing them measured the child's first row against the operator's
		// request time.
		expect(KERNEL_DELEGATE_ENQUEUE_BUDGET_MS).toBeLessThan(
			KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS,
		);
		expect(KERNEL_DELEGATE_ENQUEUE_BUDGET_MS).toBe(20_000);
		expect(KERNEL_DELEGATE_FIRST_EVENT_TIMEOUT_MS).toBeLessThan(
			KERNEL_WORKSTATION_DISPATCH_TIMEOUT_MS,
		);
	});

	it("gives workstation dispatches the wider 180s window", () => {
		// 120s stale is over the 90s isolate window but under the 180s workstation one.
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({
					runtimeMetadata: { dispatch: "workstation-dispatched" },
					startedAt: new Date(Date.now() - 60_000).toISOString(),
				}),
			),
		).toBe(false);
		expect(
			isStaleDelegationDispatchRow(
				makeRunRow({
					runtimeMetadata: { dispatch: "workstation-dispatched" },
					startedAt: new Date(Date.now() - 200_000).toISOString(),
				}),
			),
		).toBe(true);
	});
});

describe("directDelegationDispatchContent", () => {
	it("embeds the trimmed request, work item, and home run refs", () => {
		const content = directDelegationDispatchContent({
			content: "  ship the fix  ",
			delegateToTediId: "tedi-cto",
			homeRunId: "home-run-9",
			workItemId: "wi-42",
		});
		expect(content).toContain("Request: ship the fix");
		expect(content).toContain("Work Item: wi-42");
		expect(content).toContain("Home run: home-run-9");
		expect(content).toContain("Home owns the linked Work Item lifecycle");
		expect(content).toContain("You may read\nWork projects and items");
		expect(content).toContain("Do NOT create");
		expect(content).toContain("performs the only terminal settlement");
		expect(content).toContain("Outcome: succeeded");
		expect(content).not.toContain("Verification:");
	});

	it("adds the verification requirement when the delegation carries a verify command", () => {
		const verify = `tedix -w tedix work approval-list --input '{"limit":5}'`;
		const content = directDelegationDispatchContent({
			content: "fix the approval inbox read",
			delegateToTediId: "tedi-cto",
			homeRunId: "home-run-9",
			workItemId: "wi-42",
			verifyCommand: verify,
		});
		expect(content).toContain("Verification:");
		expect(content).toContain(
			`run this exact command in your own environment: ${verify}`,
		);
		expect(content).toContain("Verification output:");
		expect(content).toContain("treated as partial by Home");
	});
});

describe("delegation Work Item heartbeats", () => {
	it("buckets noisy child events into one Work Item pulse per minute", () => {
		expect(
			delegationWorkItemHeartbeatCommentId("wi-42", "2026-07-18T21:05:12.869Z"),
		).toBe("wi-42:heartbeat:2026-07-18T21:05:00.000Z");
		expect(
			delegationWorkItemHeartbeatCommentId("wi-42", "2026-07-18T21:05:59.999Z"),
		).toBe("wi-42:heartbeat:2026-07-18T21:05:00.000Z");
	});

	it("renders status only and never copies raw child previews into the board", () => {
		expect(
			delegationWorkItemHeartbeatBody({
				progress: { current: 48, label: "Running" },
			}),
		).toBe("Delegated tedi progress: Running.");
		expect(delegationWorkItemHeartbeatBody({ progress: null })).toBe(
			"Delegated tedi is making progress.",
		);
	});

	function makeHeartbeatDb(commentInserted: boolean) {
		const updates: unknown[] = [];
		const insertChain = {
			values: () => insertChain,
			onConflictDoNothing: () => insertChain,
			returning: () =>
				Promise.resolve(commentInserted ? [{ id: "comment-1" }] : []),
		};
		const updateChain = {
			set: (value: unknown) => {
				updates.push(value);
				return updateChain;
			},
			where: () => updateChain,
			returning: () => Promise.resolve([{ id: "attempt-1" }]),
		};
		const attempts = [
			{ id: "attempt-1", runId: "child-9", runtimeState: "running" },
		];
		let selectCall = 0;
		const selectChain = {
			from: () => selectChain,
			where: () => selectChain,
			limit: () =>
				Promise.resolve(
					!commentInserted
						? [{ id: "comment-1" }]
						: selectCall++ === 0
							? []
							: selectCall === 2
								? [{ id: "wi-42" }]
								: attempts,
				),
			orderBy: () => selectChain,
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(attempts).then(resolve),
		};
		const db = {
			batch: (queries: PromiseLike<unknown>[]) => Promise.all(queries),
			insert: () => insertChain,
			update: () => updateChain,
			select: () => selectChain,
		};
		return { updates, context: { db } as unknown as BaseContext };
	}

	const heartbeatInput = {
		childRunId: "child-9",
		createdAt: "2026-08-03T21:05:12.869Z",
		delegatedTediId: "tedi-cto",
		latestEventAt: "2026-08-03T21:05:12.869Z",
		latestEventKind: "tool",
		organizationId: "org-1",
		progress: null,
		workItemId: "wi-42",
	};

	// Narrative heartbeats are reporting only; active execution owns authority.
	it("records the child run on the narrative heartbeat", async () => {
		let inserted: Record<string, unknown> | undefined;
		let limitCall = 0;
		const insertChain = {
			values: (row: Record<string, unknown>) => {
				inserted = row;
				return insertChain;
			},
			onConflictDoNothing: () => insertChain,
			returning: () => Promise.resolve([{ id: "comment-1" }]),
		};
		const context = {
			db: {
				insert: () => insertChain,
				select: () => {
					const chain = {
						from: () => chain,
						where: () => chain,
						limit: () =>
							Promise.resolve(limitCall++ === 0 ? [] : [{ id: "wi-42" }]),
						orderBy: () => Promise.resolve([]),
					};
					return chain;
				},
			},
		} as unknown as BaseContext;
		await recordDelegationWorkItemHeartbeat(context, heartbeatInput);
		expect(
			(inserted?.metadata as Record<string, unknown> | undefined)?.childRunId,
		).toBe("child-9");
	});

	it("does not renew execution authority when reporting fresh progress", async () => {
		const { updates, context } = makeHeartbeatDb(true);
		await recordDelegationWorkItemHeartbeat(context, heartbeatInput);
		// Reading progress must not keep a dead runtime authoritative.
		expect(updates).toHaveLength(0);
	});

	// Without this the touch would fire on every child event rather than on the
	// documented one-per-minute bucket.
	it("skips the attempt heartbeat when the minute bucket already has a pulse", async () => {
		const { updates, context } = makeHeartbeatDb(false);
		await recordDelegationWorkItemHeartbeat(context, heartbeatInput);
		expect(updates).toHaveLength(0);
	});

	// A settled or replaced attempt rejects its stale fence. That refusal must
	// never take down run progress reporting.
	it("does not touch attempt storage during progress reporting", async () => {
		let limitCall = 0;
		const selectChain = {
			from: () => selectChain,
			where: () => selectChain,
			limit: () =>
				Promise.resolve(
					limitCall++ === 0
						? []
						: limitCall === 2
							? [{ id: "wi-42" }]
							: [
									{
										id: "attempt-1",
										runId: "child-9",
										runtimeState: "running",
									},
								],
				),
			orderBy: () => selectChain,
		};
		const context = {
			db: {
				select: () => selectChain,
				insert: () => ({
					values: () => ({
						onConflictDoNothing: () => ({
							returning: () => Promise.resolve([{ id: "comment-1" }]),
						}),
					}),
				}),
				update: () => {
					throw new Error("stale lease");
				},
			},
		} as unknown as BaseContext;
		await expect(
			recordDelegationWorkItemHeartbeat(context, heartbeatInput),
		).resolves.toBeUndefined();
	});
});

describe("delegation completion proof comment", () => {
	it("references the child trace instead of copying a full transcript", () => {
		const body = delegationCompletionProofBody({
			childRunId: "child-123",
			proof: {
				hasProof: true,
				evidenceState: "verified",
				repoCommitSha: null,
				prRef: null,
				artifactRefs: [],
				rationaleRef: null,
				transcript: `Raw result: ${"x".repeat(20_000)}`,
			},
		});
		expect(body).toBe(
			"Delegated tedi reported completion. Result references: child_run child-123. Exact output remains in the child-run trace.",
		);
		expect(body).not.toContain("Raw result:");
	});
});

describe("extractDelegationProofRefs", () => {
	it.each([false, true])(
		"bookkeeping cannot override absent execution (unclassified=%s)",
		(hasUnclassifiedToolCall) => {
			const proof = extractDelegationProofRefs({
				metadata: {},
				transcript:
					"What would you like me to work on?\n[artifact:turn_summary/run.json]",
				liveness: {
					toolCallCount: 1,
					hasExecutionEvidence: false,
					hasTerminalExecutionEvidence: false,
					hasUnclassifiedToolCall,
				},
			});
			expect(proof.artifactRefs).toEqual([]);
			expect(proof.hasProof).toBe(false);
			expect(proof.evidenceState).toBe(
				hasUnclassifiedToolCall ? "unknown" : "missing",
			);
		},
	);

	it.each(["turn_summary", "turn_summary/run.json"])(
		"a bookkeeping-only transcript is not answer proof: %s",
		(label) => {
			expect(
				extractDelegationProofRefs({
					metadata: {},
					transcript: `[artifact:${label}]`,
				}),
			).toMatchObject({ hasProof: false, artifactRefs: [] });
		},
	);

	it("has no proof for empty metadata and a null transcript", () => {
		const proof = extractDelegationProofRefs({
			metadata: undefined,
			transcript: null,
		});
		expect(proof.hasProof).toBe(false);
		expect(proof.repoCommitSha).toBeNull();
		expect(proof.prRef).toBeNull();
		expect(proof.artifactRefs).toEqual([]);
	});

	it("reads repo commit + PR refs across their metadata aliases", () => {
		expect(
			extractDelegationProofRefs({
				metadata: { commitSha: "abc123", prUrl: "https://pr/1" },
				transcript: null,
			}),
		).toMatchObject({
			hasProof: true,
			repoCommitSha: "abc123",
			prRef: "https://pr/1",
		});
		expect(
			extractDelegationProofRefs({
				metadata: { commit_sha: "def456", pullRequestUrl: "https://pr/2" },
				transcript: null,
			}),
		).toMatchObject({
			hasProof: true,
			repoCommitSha: "def456",
			prRef: "https://pr/2",
		});
	});

	it("reads explicit repo_commit and GitHub PR refs from the child transcript", () => {
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript:
					"Outcome: succeeded\nrepo_commit 0123456789abcdef0123456789abcdef01234567",
			}),
		).toMatchObject({
			hasProof: true,
			repoCommitSha: "0123456789abcdef0123456789abcdef01234567",
		});
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript:
					"Outcome: succeeded\nhttps://github.com/tedix-hq/tedix/pull/42",
			}),
		).toMatchObject({
			hasProof: true,
			prRef: "https://github.com/tedix-hq/tedix/pull/42",
		});
	});

	it("does not treat an explicit follow-up outcome and its tool trace as proof", () => {
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript:
				"Outcome: needs_follow_up — attempt admission conflicted. [tool:cto.work_item_comment]",
			liveness: {
				toolCallCount: 1,
				hasExecutionEvidence: true,
				hasTerminalExecutionEvidence: false,
				hasUnclassifiedToolCall: false,
			},
		});
		expect(proof.hasProof).toBe(false);
	});

	it("does not promote a Markdown partial-result heading to successful settlement", () => {
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript:
				"**Partial result — fail closed. No repository or production mutation was performed.**\n\n[tool:workstation_status] provisioning failed",
			liveness: {
				toolCallCount: 1,
				hasExecutionEvidence: true,
				hasTerminalExecutionEvidence: false,
				hasUnclassifiedToolCall: false,
			},
		});
		expect(proof.hasProof).toBe(false);
		expect(proof.evidenceState).toBe("missing");
	});

	it("does not treat a runtime budget early-stop and its partial tool trace as proof", () => {
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript:
				"[tool:tedix_mcp_code]\npartial discovery\n[Turn stopped early: daily inference token budget exhausted mid-turn (503077/500000 tokens for 2026-07-26, operator class). Partial results above; remaining work was not attempted.]",
			liveness: {
				toolCallCount: 1,
				hasExecutionEvidence: true,
				hasTerminalExecutionEvidence: false,
				hasUnclassifiedToolCall: false,
			},
		});
		expect(proof.hasProof).toBe(false);
		expect(proof.evidenceState).toBe("missing");
	});

	it("rejects a structured partial stop even when prose was truncated away", () => {
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript: "[tool:tedix_mcp_code]\ninspectable output",
			stopReason: "step_ceiling",
			liveness: {
				toolCallCount: 1,
				hasExecutionEvidence: true,
				hasTerminalExecutionEvidence: false,
				hasUnclassifiedToolCall: false,
			},
		});
		expect(proof.hasProof).toBe(false);
		expect(proof.evidenceState).toBe("missing");
	});

	it("collects [artifact:...] refs from the transcript and counts prose as proof", () => {
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript: "did the work [artifact:report.md] and [artifact:diff.patch]",
		});
		expect(proof.artifactRefs).toEqual(["report.md", "diff.patch"]);
		expect(proof.hasProof).toBe(true);
	});

	it("does NOT treat whitespace or empty-assistant transcripts as proof", () => {
		expect(
			extractDelegationProofRefs({ metadata: {}, transcript: "   " }).hasProof,
		).toBe(false);
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript: "EMPTY_ASSISTANT_MESSAGE",
			}).hasProof,
		).toBe(false);
	});

	it("DISCOVERY STALL: tool calls but no execution evidence is NOT proof, even with a stub transcript", () => {
		// The observed failure: a tedi that discovered github_tedix (search_tools +
		// a discover-only tedix_mcp_code) then emitted "Completed 2 actions".
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript:
					"Completed 2 actions: tedix_mcp_code, tedix_mcp_search_tools.",
				liveness: {
					toolCallCount: 2,
					hasExecutionEvidence: false,
					hasTerminalExecutionEvidence: false,
					hasUnclassifiedToolCall: false,
				},
			}).hasProof,
		).toBe(false);
	});

	it("EXECUTED: tool calls WITH execution evidence keep the transcript as proof", () => {
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript: "Here are the 5 most recent commits: …",
				liveness: {
					toolCallCount: 3,
					hasExecutionEvidence: true,
					hasTerminalExecutionEvidence: false,
					hasUnclassifiedToolCall: false,
				},
			}).hasProof,
		).toBe(true);
	});

	it("ANSWER-ONLY: a real answer with zero tool calls is NOT a stall (stays proof)", () => {
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript: "The CTO reports the pipeline is green.",
				liveness: {
					toolCallCount: 0,
					hasExecutionEvidence: false,
					hasTerminalExecutionEvidence: false,
					hasUnclassifiedToolCall: false,
				},
			}).hasProof,
		).toBe(true);
	});

	it("BLIND SPOT: an unclassified tool call is UNKNOWN and cannot auto-complete", () => {
		// The direct-path telemetry gap: step.completed reports toolCallCount:1 but
		// the tedix_mcp_code tool.started was dropped, so hasExecutionEvidence reads
		// false while hasUnclassifiedToolCall is true. The tool may have executed,
		// but missing observability is not positive proof of execution.
		const proof = extractDelegationProofRefs({
			metadata: {},
			transcript: "Here is the requested summary from the scraped page: …",
			liveness: {
				toolCallCount: 2,
				hasExecutionEvidence: false,
				hasTerminalExecutionEvidence: false,
				hasUnclassifiedToolCall: true,
			},
		});
		expect(proof.hasProof).toBe(false);
		expect(proof.evidenceState).toBe("unknown");
	});

	it("hard proof refs override UNKNOWN runtime evidence", () => {
		const proof = extractDelegationProofRefs({
			metadata: { prRef: "https://github.test/pr/42" },
			transcript: "tool telemetry was incomplete",
			liveness: {
				toolCallCount: 1,
				hasExecutionEvidence: false,
				hasTerminalExecutionEvidence: false,
				hasUnclassifiedToolCall: true,
			},
		});
		expect(proof.hasProof).toBe(true);
		expect(proof.evidenceState).toBe("verified");
	});

	it("hard proof refs override a discovery stall (a commit IS execution evidence)", () => {
		expect(
			extractDelegationProofRefs({
				metadata: { commitSha: "abc123" },
				transcript: "Completed 1 action: tedix_mcp_search_tools.",
				liveness: {
					toolCallCount: 1,
					hasExecutionEvidence: false,
					hasTerminalExecutionEvidence: false,
					hasUnclassifiedToolCall: false,
				},
			}).hasProof,
		).toBe(true);
	});

	it("fail-soft: absent liveness preserves the prior non-empty-transcript behavior", () => {
		expect(
			extractDelegationProofRefs({
				metadata: {},
				transcript: "some output",
				liveness: null,
			}).hasProof,
		).toBe(true);
	});
});

describe("delegationProofTranscriptPreview", () => {
	it("returns null for a null transcript", () => {
		expect(delegationProofTranscriptPreview(null)).toBeNull();
	});

	it("passes short transcripts through unchanged", () => {
		expect(delegationProofTranscriptPreview("short")).toBe("short");
	});

	it("truncates transcripts longer than the 1600-char preview ceiling", () => {
		const long = "x".repeat(2000);
		const preview = delegationProofTranscriptPreview(long);
		expect(preview).toHaveLength(1600);
	});
});

describe("resolveDelegationWorkItemId", () => {
	// The fast path returns the stamped id without touching the db — a db that
	// throws on any access proves no query is issued.
	const throwingDb = new Proxy(
		{},
		{
			get() {
				throw new Error("db must not be queried on the fast path");
			},
		},
	);
	const fastPathContext = { db: throwingDb } as unknown as BaseContext;

	it("returns the work item id stamped on run metadata", async () => {
		await expect(
			resolveDelegationWorkItemId(
				fastPathContext,
				makeRunRow({ metadata: { workItemId: "wi-stamped" } }),
			),
		).resolves.toBe("wi-stamped");
	});

	it("falls back to the runtimeMetadata stamp", async () => {
		await expect(
			resolveDelegationWorkItemId(
				fastPathContext,
				makeRunRow({
					metadata: {},
					runtimeMetadata: { workItemId: "wi-runtime" },
				}),
			),
		).resolves.toBe("wi-runtime");
	});

	it("returns null when unstamped and there is no child run to look up", async () => {
		await expect(
			resolveDelegationWorkItemId(
				fastPathContext,
				makeRunRow({ metadata: {}, runtimeMetadata: {}, childRunId: null }),
			),
		).resolves.toBeNull();
	});

	it("resolves via the sourceIntentId=childRunId fallback query", async () => {
		let queried = false;
		const chain = {
			from: () => chain,
			where: () => chain,
			orderBy: () => chain,
			limit: () => {
				queried = true;
				return Promise.resolve([
					{ id: "wi-by-child", sourceIntentId: "child-1" },
				]);
			},
		};
		const context = {
			db: { select: () => chain },
		} as unknown as BaseContext;
		await expect(
			resolveDelegationWorkItemId(
				context,
				makeRunRow({ metadata: {}, runtimeMetadata: {} }),
			),
		).resolves.toBe("wi-by-child");
		expect(queried).toBe(true);
	});
});

describe("createDelegationWorkItem", () => {
	it("fails closed when the work-item write throws", async () => {
		const throwingDb = new Proxy(
			{},
			{
				get() {
					throw new Error("db unavailable");
				},
			},
		);
		const context = { db: throwingDb } as unknown as BaseContext;
		await expect(
			createDelegationWorkItem(context, {
				assigneeTediId: "tedi-cto",
				childRunId: "child-1",
				content: "do the thing",
				conversationId: "home:main",
				createdAt: new Date().toISOString(),
				executionRequirement: {
					surface: "native",
					requiredCapabilities: [],
					fallbackSurface: null,
					prohibitedSurfaces: [],
					satisfiable: true,
					reason: "test",
				},
				homeRunId: "home-run-1",
				organizationId: "org-1",
			}),
		).rejects.toThrow("db unavailable");
	});
});

describe("autoDispatchDeferredAssignment", () => {
	const baseInput = {
		blockerWorkItemId: "wi-blocker",
		createdAt: "2026-07-14T00:00:00.000Z",
		dependentWorkItemId: "wi-dependent",
		organizationId: "org-1",
	};
	const neverEnqueue = () => {
		throw new Error("enqueue must not be called");
	};

	/** select() chain whose limit() resolves each queued result in order. */
	function selectChain(results: unknown[][]) {
		let call = 0;
		const chain = {
			from: () => chain,
			where: () => chain,
			orderBy: () => chain,
			limit: () => Promise.resolve(results[call++] ?? []),
			then: (resolve: (value: unknown[]) => unknown) =>
				Promise.resolve(results[call++] ?? []).then(resolve),
		};
		return chain;
	}

	it("returns no-deferral when the dependent has no blocked_by_dependency comment", async () => {
		const context = {
			db: { select: () => selectChain([[]]) },
		} as unknown as BaseContext;
		await expect(
			autoDispatchDeferredAssignment(context, {
				...baseInput,
				enqueue: neverEnqueue,
			}),
		).resolves.toEqual({ dispatched: false, reason: "no-deferral" });
	});

	it("returns not-eligible when the assignment already has a child run", async () => {
		const deferral = [
			{
				metadata: {
					assignmentId: "a-1",
					homeRunId: "run-1",
					source: "kernelRuntime.approvePlanAssignments",
				},
			},
		];
		const run = [
			{
				id: "run-1",
				conversationId: "conv-1",
				metadata: {
					homePlan: {
						id: "plan-1",
						assignments: [
							{ id: "a-1", status: "approved", childRunId: "already-spawned" },
						],
					},
				},
			},
		];
		const chain = selectChain([
			deferral,
			run,
			[{ id: "wi-dependent:autodispatch" }],
		]);
		const context = {
			db: { select: () => chain },
		} as unknown as BaseContext;
		await expect(
			autoDispatchDeferredAssignment(context, {
				...baseInput,
				enqueue: neverEnqueue,
			}),
		).resolves.toEqual({ dispatched: false, reason: "not-eligible" });
	});

	it("skips dispatch when another reconcile already holds the latch", async () => {
		const deferral = [
			{
				metadata: {
					assignmentId: "a-1",
					homeRunId: "run-1",
					source: "kernelRuntime.approvePlanAssignments",
				},
			},
		];
		const run = [
			{
				id: "run-1",
				conversationId: "conv-1",
				metadata: {
					homePlan: {
						id: "plan-1",
						assignments: [{ id: "a-1", status: "approved", childRunId: null }],
					},
				},
			},
		];
		const insertChain = {
			values: () => insertChain,
			onConflictDoNothing: () => insertChain,
			// Empty returning(): the latch insert conflicted — a prior reconcile won.
			returning: () => Promise.resolve([]),
		};
		const chain = selectChain([
			deferral,
			run,
			[{ id: "wi-dependent:autodispatch" }],
		]);
		const context = {
			db: {
				select: () => chain,
				insert: () => insertChain,
			},
		} as unknown as BaseContext;
		await expect(
			autoDispatchDeferredAssignment(context, {
				...baseInput,
				enqueue: neverEnqueue,
			}),
		).resolves.toEqual({ dispatched: false, reason: "already-latched" });
	});

	it("is fail-soft: a thrown db error becomes a dispatch-error outcome", async () => {
		const throwingDb = new Proxy(
			{},
			{
				get() {
					throw new Error("db unavailable");
				},
			},
		);
		const context = { db: throwingDb } as unknown as BaseContext;
		const outcome = await autoDispatchDeferredAssignment(context, {
			...baseInput,
			enqueue: neverEnqueue,
		});
		expect(outcome.dispatched).toBe(false);
		if (!outcome.dispatched) expect(outcome.reason).toBe("dispatch-error");
	});
});

describe("classifyDelegationFailureRecovery", () => {
	it("separates a dispatch that never landed from a silent child", () => {
		// The child never received the work order, so its liveness is not the
		// question and the fix is simply to dispatch again. Reporting this as a
		// child-runtime timeout makes a dispatch failure read as a tedi fault.
		expect(
			classifyDelegationFailureRecovery(
				"dispatch_never_landed: Delegated child dispatch never reached the target runtime",
			),
		).toEqual({
			failureReason: "dispatch_never_landed",
			recoveryHints: ["redispatch_same_work_order", "verify_dispatch_ledger"],
		});
	});

	it("keeps the child-silent case pointing at runtime liveness", () => {
		expect(
			classifyDelegationFailureRecovery(
				"dispatch_timeout: Delegated child dispatch timed out before the child runtime published events",
			),
		).toEqual({
			failureReason: "dispatch_timeout",
			recoveryHints: ["redispatch_same_work_order", "verify_runtime_liveness"],
		});
	});

	it("falls back to an in-loop delegation failure", () => {
		for (const value of [undefined, null, "", "isolate dispatch unavailable"]) {
			expect(classifyDelegationFailureRecovery(value)).toEqual({
				failureReason: "delegation_failed",
				recoveryHints: ["redispatch_same_work_order", "reroute_to_home"],
			});
		}
	});
});
