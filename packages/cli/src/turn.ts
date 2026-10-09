import { isAuthError, isConnectionError } from "./operator/runtime-errors";
/**
 * Home turn engine: send one MCP Home turn, wait for settlement with
 * live gateway events, hydrate delegated child results,
 * inspect runs, and build the HomeOps/CommandContext used by every command
 * handler. Extracted verbatim from index.ts.
 */

import { createInterface } from "node:readline/promises";
import {
	activityRowPhase,
	formatActivityRow,
	formatThinkingRow,
	THINKING_ROW_KEY,
	StatusSpinner,
	spinnerLabel,
} from "./activity";
import { createAnswerStream } from "./answer-stream";
import type { CommandContext, HomeOps } from "./commands";
import { streamHomeRunEvents } from "./events";
import {
	errorText,
	type InspectBundle,
	resolveColorMode,
	summaryAnswerText,
} from "./format";
import { renderMarkdown } from "./markdown";
import {
	type HomeRunSummary,
	isRateLimitError,
	isSettledHomeStatus,
	summarizeHomePayload,
	type TedixHomeClient,
} from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { classifyInterrupt } from "./interrupt";
import { appendLocalRepoContext } from "./local-context";
import type { CliOptions } from "./shared";
import { askHomeOnce } from "./home-submission";
import { stripControlChars, type ColorMode } from "./terminal";

export function kernelTurnMetadata(
	options: CliOptions,
	mode: "interactive" | "one-shot",
): Record<string, unknown> {
	return {
		source: "tedix-cli",
		cwd: process.cwd(),
		mode,
		...(options.delegationWorkItemId
			? { workItemId: options.delegationWorkItemId }
			: {}),
		...(options.requireCodeProof ? { requiredProofKind: "code" } : {}),
		...(options.requireWorkstation
			? {
					effortClass: "embodied",
					needsEmbodiedSurface: true,
					requireWorkstation: true,
				}
			: {}),
	};
}

async function readInspectLane<T>(
	read: () => Promise<T>,
): Promise<{ error?: string; payload?: T }> {
	try {
		return { payload: await read() };
	} catch (error) {
		return { error: errorText(error) };
	}
}

async function inspectKernelRun(
	client: TedixHomeClient,
	options: CliOptions,
	homeRunId: string,
): Promise<InspectBundle> {
	const run = await client.readHomeRun(homeRunId);
	const summary = summarizeHomePayload(run);
	const bundle: InspectBundle = { homeRunId, run, summary };

	const traceLane = await readInspectLane(() =>
		client.listKernelTraceBundles({
			limit: options.limit ?? 20,
			runId: homeRunId,
			...(options.harnessVersionId
				? { harnessVersionId: options.harnessVersionId }
				: {}),
		}),
	);
	if (traceLane.payload !== undefined) bundle.traceBundles = traceLane.payload;
	if (traceLane.error) bundle.traceBundlesError = traceLane.error;

	const convergedTraceLane = await readInspectLane(() =>
		client.readHomeTrace(homeRunId),
	);
	if (convergedTraceLane.payload !== undefined) {
		bundle.convergedTrace = convergedTraceLane.payload;
	}
	if (convergedTraceLane.error) {
		bundle.convergedTraceError = convergedTraceLane.error;
	}

	if (summary?.conversationId) {
		const conversationId = summary.conversationId as string;
		const treeLane = await readInspectLane(() =>
			client.readChildRunTree({ conversationId, limit: options.limit }),
		);
		if (treeLane.payload !== undefined) bundle.childTree = treeLane.payload;
		if (treeLane.error) bundle.childTreeError = treeLane.error;
	}

	if (summary?.delegatedTediId && summary.childRunId) {
		const childRunId = summary.childRunId as string;
		const delegatedTediId = summary.delegatedTediId as string;
		const evidenceLane = await readInspectLane(() =>
			client.readChildRunEvidence({
				childRunId,
				delegatedTediId,
				artifactLimit: options.artifactLimit,
				limit: options.limit,
			}),
		);
		if (evidenceLane.payload !== undefined) {
			bundle.childEvidence = evidenceLane.payload;
		}
		if (evidenceLane.error) bundle.childEvidenceError = evidenceLane.error;

		// Fifth lane: the delegated tedi's OWN trace bundles (per-step usage,
		// rationale/artifact ids, bundleUri) — the tedi-side half of the chain.
		// Served via the same gateway's Home MCP surface.
		const tediTraceLane = await readInspectLane(() =>
			client.readDelegatedTediTraces({
				tediId: delegatedTediId,
				runId: childRunId,
				limit: options.limit ?? 10,
			}),
		);
		if (tediTraceLane.payload !== undefined) {
			bundle.tediTraceBundles = tediTraceLane.payload;
		}
		if (tediTraceLane.error) bundle.tediTraceBundlesError = tediTraceLane.error;
	}

	return bundle;
}

/**
 * Wait for a Home run to settle while rendering a live spinner and inline
 * kernel-activity rows. Settlement is driven by an
 * authoritative Task poll (so requires_approval terminates the wait);
 * the event stream feeds decorative activity rows in parallel and never fails
 * the turn.
 */
function makeSpinner(options: CliOptions): StatusSpinner {
	// Fix #7: pass noColor so the spinner respects --no-color (not just --json).
	const color = resolveColorMode({
		json: options.json,
		noColor: options.noColor,
	});
	// Promotion commits answer lines into the SAME stream the settled summary
	// prints to, so it may only engage when that stream is the terminal. Piping
	// stdout (`tedix ask … | tee`) keeps the pre-promotion lane: the whole
	// canonical answer lands on stdout exactly as before.
	const promotes =
		process.stderr.isTTY === true &&
		process.stdout.isTTY === true &&
		!options.json;
	return new StatusSpinner({
		animate: process.stderr.isTTY === true,
		quiet: options.json,
		color,
		...(promotes
			? {
					commit: (line: string) => {
						process.stdout.write(`${line}\n`);
					},
					renderAnswer: (text: string, width: number) =>
						renderMarkdown(text, color, width).split("\n"),
				}
			: {}),
	});
}

function latestAssistantTextFromChildEvidence(
	payload: unknown,
): string | undefined {
	const root = isRecord(payload) ? payload : {};
	const evidence = isRecord(root.childEvidence)
		? root.childEvidence
		: isRecord(root.evidence)
			? root.evidence
			: root;
	const events = Array.isArray(evidence.events) ? evidence.events : [];
	const preview =
		typeof evidence.preview === "string" ? evidence.preview.trim() : "";
	let latest: { text: string; timestamp: number } | undefined;
	for (const event of events) {
		if (!isRecord(event) || event.kind !== "message.completed") continue;
		const eventPayload = isRecord(event.payload) ? event.payload : {};
		if (eventPayload.role !== "assistant") continue;
		const content =
			typeof eventPayload.content === "string"
				? eventPayload.content.trim()
				: "";
		if (!content) continue;
		const timestamp =
			typeof event.createdAt === "string" ? Date.parse(event.createdAt) : 0;
		const safeTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
		if (!latest || safeTimestamp >= latest.timestamp)
			latest = { text: content, timestamp: safeTimestamp };
	}
	return latest?.text ?? (preview || undefined);
}

async function hydrateDelegatedChildResult(
	client: TedixHomeClient,
	summary: HomeRunSummary,
	options: CliOptions,
): Promise<HomeRunSummary> {
	// A child result is canonical only after the parent completed successfully.
	// Canceled/failed parents can still have partial child evidence (or a child
	// that races past a stop request); promoting it would contradict the durable
	// parent outcome and can expose raw tool payloads as a final chat answer.
	if (
		summary.status !== "completed" ||
		!summary.delegatedTediId ||
		!summary.childRunId
	) {
		return summary;
	}
	try {
		const evidence = await client.readChildRunEvidence({
			delegatedTediId: summary.delegatedTediId,
			childRunId: summary.childRunId,
			artifactLimit: options.artifactLimit,
			limit: options.limit,
		});
		const childText = latestAssistantTextFromChildEvidence(evidence);
		if (!childText) return summary;
		return { ...summary, assistantText: childText, childRunPreview: childText };
	} catch {
		return summary;
	}
}

/**
 * P4: install a SIGINT handler for the duration of a running turn.
 *
 * First Ctrl-C prints a one-line prompt and reads a single keypress:
 *   [c]ancel / [s]teer / [w]ait
 * Second Ctrl-C within 1 500 ms calls ac.abort() (hard abort).
 *
 * TTY-only. Non-TTY (piped, --json, --no-poll) is a no-op (returns a noop
 * restore function) so the outer onSignal handler remains in control.
 */
function installTurnInterruptHandler(
	client: TedixHomeClient,
	homeRunId: string,
	ac: AbortController,
): () => void {
	if (!process.stdout.isTTY || !process.stdin.isTTY) return () => {};

	let lastPressTime = 0;

	const handler = () => {
		const now = Date.now();
		const secondPress = now - lastPressTime < 1_500;
		lastPressTime = now;

		const action = classifyInterrupt({
			isTty: true,
			turnRunning: true,
			secondPressWithinWindow: secondPress,
			hasText: false,
		});

		if (action === "abort") {
			process.stdout.write("\nAborting…\n");
			ac.abort();
			return;
		}

		// action === 'prompt': show inline choice, read one raw keypress.
		process.stdout.write("\n[c]ancel / [s]teer / [w]ait: ");

		// Switch stdin to raw mode briefly so we can read a single character.
		const wasRaw = process.stdin.isRaw ?? false;
		try {
			process.stdin.setRawMode(true);
		} catch {
			// Not a real TTY after all — bail out to keep waiting.
			process.stdout.write("\n");
			return;
		}
		process.stdin.resume();

		const onKey = (chunk: Buffer) => {
			process.stdin.removeListener("data", onKey);
			try {
				process.stdin.setRawMode(wasRaw);
			} catch {
				// ignore
			}

			const key = chunk.toString("utf8").toLowerCase().trim();
			process.stdout.write("\n");

			if (key === "c") {
				client
					.cancelHomeRun({ homeRunId, reason: "canceled from tedix-cli" })
					.then(() => {
						process.stdout.write("Cancel requested.\n");
					})
					.catch((err: unknown) => {
						process.stderr.write(`cancel failed: ${errorText(err)}\n`);
					});
			} else if (key === "s") {
				// Read a full steer line with a temporary readline question.
				process.stdout.write("Steer: ");
				const steerRl = createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				steerRl
					.question("")
					.then((instruction: string) => {
						steerRl.close();
						const trimmed = instruction.trim();
						if (trimmed) {
							client
								.steerHomeRun({ homeRunId, instruction: trimmed })
								.then(() => {
									process.stdout.write("Steer sent.\n");
								})
								.catch((err: unknown) => {
									process.stderr.write(`steer failed: ${errorText(err)}\n`);
								});
						}
					})
					.catch(() => {
						steerRl.close();
					});
			}
			// 'w', Esc (\x1b), or anything else → keep waiting (no-op).
		};

		process.stdin.once("data", onKey);
	};

	process.on("SIGINT", handler);
	return () => process.off("SIGINT", handler);
}

export async function waitForSettlement(
	client: TedixHomeClient,
	homeRunId: string,
	initial: HomeRunSummary,
	options: CliOptions,
	color: ColorMode,
	spinner: StatusSpinner,
): Promise<HomeRunSummary> {
	const ac = new AbortController();
	const deadlineTimer = setTimeout(() => ac.abort(), options.pollTimeoutMs);
	let receivedActivity = false;
	// The event tail sees settlement before the next status poll would. When it
	// ends on its own (settled/closed stream, not our abort) it wakes the settle
	// loop so the terminal read happens now instead of after a full interval.
	let tailSettled = false;
	let wakeSettleLoop: (() => void) | null = null;
	const signalTailSettled = () => {
		if (ac.signal.aborted) return;
		if (wakeSettleLoop) wakeSettleLoop();
		else tailSettled = true;
	};
	// One wake per signal: a tail that settled while a status read was in
	// flight skips the next pause only, never every pause after it.
	const waitForPollOrSettle = (ms: number): Promise<void> =>
		new Promise<void>((resolve) => {
			if (tailSettled || ac.signal.aborted) {
				tailSettled = false;
				resolve();
				return;
			}
			const done = () => {
				clearTimeout(timer);
				ac.signal.removeEventListener("abort", done);
				wakeSettleLoop = null;
				resolve();
			};
			const timer = setTimeout(done, ms);
			wakeSettleLoop = done;
			ac.signal.addEventListener("abort", done, { once: true });
		});
	const quietTimer = setTimeout(() => {
		if (!receivedActivity && !ac.signal.aborted)
			spinner.log(
				`No activity received yet. Check this run with: tedix inspect ${homeRunId}`,
			);
	}, 15_000);
	// Tail an event stream (the parent run, or a delegated child run) into the
	// spinner as activity rows. Decorative — failures never break the turn.
	const tailInto = (
		scope: { childRunId?: string; delegatedTediId?: string },
		tediLabel?: string,
	): Promise<void> =>
		(async () => {
			// Additive streamed-answer channel for the PARENT run: batched
			// `message.delta` rows render on the live spinner line while the turn is
			// in flight. The canonical `message.completed` answer is still the only
			// thing printSummary commits — a settled run drops the live fragment. A
			// delegated child tail keeps activity rows only; two answer streams
			// cannot share one live line.
			const answerStream = tediLabel ? null : createAnswerStream();
			// The planner's provisional rationale (`message.reasoning`) is the same
			// sequence-keyed shape; it renders as ONE muted live "thinking" line
			// that the settled run dismisses (the answer supersedes it).
			const rationaleStream = tediLabel
				? null
				: createAnswerStream({ kind: "message.reasoning" });
			try {
				const stream = streamHomeRunEvents(
					client,
					{ homeRunId, ...scope },
					{
						live: true,
						pollIntervalMs: options.pollIntervalMs,
						signal: ac.signal,
						onConnectionChange: (connected) => {
							if (!ac.signal.aborted)
								spinner.log(
									connected
										? "Activity connection restored."
										: "Activity connection interrupted; retrying. Run status is checked separately.",
								);
						},
					},
				);
				for await (const event of stream) {
					receivedActivity = true;
					const streamed = answerStream?.ingest(event);
					if (streamed) {
						spinner.stream(streamed.settled ? "" : streamed.text);
					}
					const thinking = rationaleStream?.ingest(event);
					if (thinking) {
						const row = thinking.settled
							? null
							: formatThinkingRow(thinking.text, color);
						if (row) {
							spinner.log(row, { key: THINKING_ROW_KEY, phase: "start" });
						} else {
							spinner.dismiss(THINKING_ROW_KEY);
						}
					}
					const row = formatActivityRow(event, color, { tediLabel });
					if (row) {
						// An in-flight tool is one live line replaced in place; the
						// matching completion commits it. Key by tedi so a delegated
						// child's rows never overwrite the parent's.
						const phase = activityRowPhase(event);
						spinner.log(
							row,
							phase
								? { ...phase, key: `${tediLabel ?? ""}:${phase.key}` }
								: undefined,
						);
					}
				}
				// The stream returns on its own only once the run is settled or the
				// terminal page drained; a tail we aborted says nothing.
				signalTailSettled();
			} catch {
				clearTimeout(quietTimer);
				if (!ac.signal.aborted)
					spinner.log(
						"Activity updates unavailable; continuing to check run status.",
					);
			}
		})();

	const tails: Promise<void>[] = [tailInto({})];
	let childTailStarted = false;

	// P4: install turn-running interrupt handler (TTY-only; no-op on non-TTY).
	// Must be removed before the outer onSignal (teardown) handler re-takes over.
	const removeTurnInterrupt = installTurnInterruptHandler(
		client,
		homeRunId,
		ac,
	);

	let summary = initial;
	const deadline = Date.now() + options.pollTimeoutMs;
	// Poll at once, then back off 1s -> 2s -> `--poll-interval` (the ceiling).
	// Most turns settle within a few seconds of submission; a fixed 5s pause
	// before the first read was pure wait. The first pause is one event-loop
	// tick so the tail issues its long-poll before the status read.
	const backoffMs = [0, 1_000, 2_000];
	let pollCount = 0;
	try {
		while (Date.now() < deadline) {
			const step = backoffMs[pollCount] ?? options.pollIntervalMs;
			await waitForPollOrSettle(Math.min(step, options.pollIntervalMs));
			pollCount++;
			if (ac.signal.aborted) break;
			try {
				const task = await client.getTask(homeRunId, ac.signal);
				const taskResult =
					task.result && typeof task.result === "object"
						? (task.result as Record<string, unknown>)
						: {};
				const taskSummary = summarizeHomePayload({
					run: {
						id: task.taskId,
						status:
							task.status === "working"
								? "running"
								: task.status === "input_required"
									? "requires_approval"
									: task.status === "cancelled"
										? "canceled"
										: task.status,
						metadata: {
							kernelRoute: taskResult.kernelRoute,
						},
					},
					assistantMessage: { content: taskResult.assistantText },
				});
				if (task.status === "working") {
					summary = {
						...summary,
						status: "running",
						progressLabel:
							task.statusMessage &&
							!/^(working|running)$/i.test(task.statusMessage)
								? stripControlChars(task.statusMessage)
								: summary.progressLabel,
						kernelRoute: taskSummary?.kernelRoute ?? summary.kernelRoute,
					};
				} else {
					// Task state owns lifecycle status. Hydrate the richer Home product
					// record once at a terminal/input boundary for answer, approval, and
					// delegation metadata that the protocol Task intentionally omits. Do
					// not commit the local terminal state before this read succeeds: a
					// transient read failure must keep polling, not exit with an empty answer.
					const hydrated = summarizeHomePayload(
						await client.readHomeRun(homeRunId, ac.signal),
					);
					summary = hydrated
						? {
								...hydrated,
								assistantText:
									hydrated.assistantText || taskSummary?.assistantText || "",
							}
						: (taskSummary ?? summary);
				}
			} catch (error) {
				// A transient connection blip should not fail a healthy turn — keep
				// the last summary and keep polling until the deadline. The event
				// tails already tolerate the same; only non-connection errors abort.
				if (ac.signal.aborted) break;
				if (!isConnectionError(error) && !isRateLimitError(error)) throw error;
				spinner.update(
					isRateLimitError(error)
						? "Run status rate-limited; retrying…"
						: "Run status connection interrupted; retrying…",
				);
				continue;
			}
			spinner.update(spinnerLabel(summary, color));
			// Once delegation dispatches a child run, tail its events inline too.
			if (!childTailStarted && summary.childRunId && summary.delegatedTediId) {
				childTailStarted = true;
				tails.push(
					tailInto(
						{
							childRunId: summary.childRunId,
							delegatedTediId: summary.delegatedTediId,
						},
						summary.targetTediLabel ?? "tedi",
					),
				);
			}
			if (isSettledHomeStatus(summary.status)) break;
		}
	} finally {
		removeTurnInterrupt();
		clearTimeout(deadlineTimer);
		clearTimeout(quietTimer);
		ac.abort();
		await Promise.allSettled(tails);
	}

	summary = await hydrateDelegatedChildResult(client, summary, options);

	return summary;
}

async function sendOne(
	client: TedixHomeClient,
	options: CliOptions,
	color: ColorMode,
	content: string,
): Promise<HomeRunSummary> {
	const contentWithContext = options.repoContext
		? appendLocalRepoContext(content)
		: content;
	// Start the spinner before ask so submission is visible during the initial
	// round-trip too — fast answer_in_home turns settle in that call.
	const spinner = makeSpinner(options);
	spinner.start("Submitting to Home…");
	try {
		let summary: HomeRunSummary;
		try {
			({ summary } = await askHomeOnce({
				client,
				content: contentWithContext,
				conversationId: options.conversationId,
				delegateToTediId: options.delegateToTediId,
				verifyCommand: options.verifyCommand,
				metadata: kernelTurnMetadata(
					options,
					options.prompt ? "one-shot" : "interactive",
				),
				timeoutMs: options.pollTimeoutMs,
				onRecover: () => spinner.update("Reconnecting to the run…"),
			}));
		} catch (error) {
			if (isAuthError(error)) {
				throw new Error(
					"Authentication failed — your token is invalid or expired. Run `tedix login`, or check TEDIX_MCP_BEARER_TOKEN / TEDIX_MCP_API_KEY.",
				);
			}
			throw error;
		}
		spinner.update(spinnerLabel(summary, color));
		const settled =
			!options.poll || isSettledHomeStatus(summary.status)
				? await hydrateDelegatedChildResult(client, summary, options)
				: await waitForSettlement(
						client,
						summary.homeRunId,
						summary,
						options,
						color,
						spinner,
					);
		// Commit whatever the live region still holds, reconciled against the
		// canonical answer, and record how much of it is already in scrollback so
		// the summary does not reprint text the user has read.
		const rendered = spinner.settleStream(summaryAnswerText(settled));
		return rendered ? { ...settled, renderedAnswerPrefix: rendered } : settled;
	} finally {
		spinner.stop();
	}
}

export function buildOps(
	client: TedixHomeClient,
	options: CliOptions,
	color: ColorMode,
): HomeOps {
	return {
		childEvidence: (input) =>
			client.readChildRunEvidence({
				...input,
				artifactLimit: options.artifactLimit,
				limit: options.limit,
			}),
		childTree: (conversationId) =>
			client.readChildRunTree({ conversationId, limit: options.limit }),
		inspect: (homeRunId) => inspectKernelRun(client, options, homeRunId),
		send: (content) => sendOne(client, options, color, content),
	};
}

export function buildContext(
	client: TedixHomeClient,
	ops: HomeOps,
	options: CliOptions,
	color: ColorMode,
): CommandContext {
	return {
		channel: options.channel,
		client,
		color,
		conversationId: options.conversationId,
		cursor: options.cursor,
		offset: options.offset,
		follow: options.follow,
		goalBudgetUsd: options.goalBudgetUsd,
		goalCondition: options.goalCondition,
		goalEvaluator: options.goalEvaluator,
		goalMaxTurns: options.goalMaxTurns,
		goalObjectiveId: options.goalObjectiveId,
		harnessVersionId: options.harnessVersionId,
		includeArchived: options.includeArchived,
		inspectView: options.inspectView,
		json: options.json,
		limit: options.limit,
		ops,
		poll: options.poll,
		pollIntervalMs: options.pollIntervalMs,
		search: options.search,
	};
}
