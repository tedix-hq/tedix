import { isAuthError } from "./operator/runtime-errors";
/**
 * readline-based interactive REPL (non-TTY / --json) plus the shared
 * interactive line dispatcher and inline approval prompt. The TTY path
 * delegates to the ink REPL in interactive-ink.ts. Extracted verbatim from
 * index.ts.
 */

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { StatusSpinner } from "./activity";
import {
	type CommandContext,
	commandNames,
	findCommand,
	firstWord,
	formatCommandHelp,
	reportSendResult,
	formatSendResult,
} from "./commands";
import {
	approvalScopeKey,
	completeInput,
	composeMultiline,
	expandFileMentions,
} from "./composer";
import { dim, errorText, printUnknownPayload } from "./format";
import type { ColorMode } from "./terminal";
import {
	DEFAULT_TEDIX_MCP_URL,
	type HomeRunSummary,
	isSettledHomeStatus,
	summarizeHomePayload,
	type TedixHomeClient,
} from "./home-client";
import { InFlightRegistry } from "./inflight";
import { printInFlightRunSnapshot, runInteractiveInk } from "./interactive-ink";
import { classifyInterrupt } from "./interrupt";
import { LiveActivityPanel } from "./live-panel";
import { type CliOptions, withTimeout } from "./shared";
import { faint, muted, warn } from "./theme";
import { waitForSettlement } from "./turn";

// ─── CLEAR_LINE mirror so printAbovePrompt can erase the prompt line ─────────
const CLEAR_LINE = "\r[K";

/**
 * Print a settled result ABOVE the live readline prompt without corrupting it —
 * the non-TTY / --json readline fallback (the ink REPL commits to its transcript
 * instead). CLEAR_LINE erases the prompt line, we write the content, then
 * repaint the prompt + partial input so the operator sees what they were typing.
 */
function printAbovePrompt(
	label: string,
	lines: string[],
	rl: ReturnType<typeof createInterface>,
): void {
	const stream = process.stdout;
	stream.write(CLEAR_LINE);
	stream.write(`↳ [${label}]\n`);
	for (const line of lines) {
		stream.write(`${line}\n`);
	}
	const partial = (rl.line ?? "").slice(0, rl.cursor ?? 0);
	stream.write(`tedix> ${partial}`);
}

/**
 * Background settler for a non-blocking dispatched run.
 *
 * Polls until the run settles (or the abort signal fires), then:
 *  1. Marks it settled in the registry (double-print guard).
 *  2. Calls `onSettled` to print the result above the live prompt.
 *
 * Never throws — all errors are swallowed after logging so a background
 * failure doesn't crash the REPL.
 */
async function backgroundSettle(opts: {
	client: TedixHomeClient;
	homeRunId: string;
	initialSummary: HomeRunSummary;
	options: CliOptions;
	color: ColorMode;
	registry: InFlightRegistry;
	rl: ReturnType<typeof createInterface>;
	panel: LiveActivityPanel | undefined;
	signal: AbortSignal;
}): Promise<void> {
	const {
		client,
		homeRunId,
		initialSummary,
		options,
		color,
		registry,
		rl,
		panel,
		signal,
	} = opts;
	try {
		// Create a per-run spinner that writes to stdout (not stderr) so we can
		// redirect its log() output; we keep it quiet because printAbovePrompt
		// handles all the visible output.
		const quietSpinner = new StatusSpinner({ animate: false, quiet: true });
		const summary = await waitForSettlement(
			client,
			homeRunId,
			initialSummary,
			{ ...options, pollTimeoutMs: options.pollTimeoutMs },
			color,
			quietSpinner,
		);
		if (signal.aborted) return;
		const entry = registry.settle(homeRunId);
		if (!entry) return; // double-settle guard
		// Drop from panel before printing so the panel repaints correctly.
		panel?.settle(homeRunId);
		const result = formatSendResult(summary, {
			json: options.json,
			color,
			poll: options.poll,
		});
		if (options.json) {
			for (const line of result.stdout) console.log(line);
			for (const line of result.stderr) console.error(line);
		} else {
			printAbovePrompt(entry.label, [...result.stdout, ...result.stderr], rl);
		}
		registry.remove(homeRunId);
	} catch (error) {
		// A background poller error is logged but never crashes the REPL.
		const entry = registry.settle(homeRunId);
		if (entry) {
			panel?.settle(homeRunId);
			printAbovePrompt(entry.label, [`Error: ${errorText(error)}`], rl);
			registry.remove(homeRunId);
		}
	}
}

/**
 * When an interactive turn parks on requires_approval, drive the decision inline
 * instead of telling the operator to leave for Tedix OS. Supports a session-scoped
 * "always approve" cache (a common pattern): `[a]lways` approves this card AND
 * auto-approves future cards with the same scope key (e.g. the same write
 * capability or delegation target) for the rest of the REPL session. The cache
 * is in-memory only — never persisted, never cross-session.
 */
async function promptApproval(
	summary: HomeRunSummary,
	ctx: CommandContext,
	rl: ReturnType<typeof createInterface>,
	alwaysApprove: Set<string>,
): Promise<void> {
	const scope = approvalScopeKey(summary);
	const respond = async (decision: "approve" | "reject", always: boolean) => {
		printUnknownPayload(
			await ctx.client.respondHomeApproval({
				decision,
				homeRunId: summary.homeRunId,
				note: `${decision}${always ? ` (always:${scope})` : ""} from tedix-cli`,
			}),
			ctx.json,
		);
	};

	if (alwaysApprove.has(scope)) {
		console.log(dim(`  ↳ auto-approved (always: ${scope})`, ctx.color));
		await respond("approve", true);
		return;
	}

	let answer: string;
	try {
		answer = (
			await rl.question(
				`Approve this run? [y]es / [n]o / [a]lways (${scope}) / Enter to skip: `,
			)
		)
			.trim()
			.toLowerCase();
	} catch {
		return;
	}
	const always = answer === "a" || answer === "always";
	const decision =
		answer === "y" || answer === "yes" || always
			? "approve"
			: answer === "n" || answer === "no"
				? "reject"
				: undefined;
	if (!decision) return; // skip — leave it parked for later /approve
	if (always) {
		alwaysApprove.add(scope);
		console.log(
			dim(`  ↳ will auto-approve "${scope}" for this session`, ctx.color),
		);
	}
	await respond(decision, always);
}

/**
 * Dispatch one interactive line without touching readline. Returns "exit" for
 * `/exit`/`/quit`, "handled" for slash commands (including /help and unknown
 * /name), and the HomeRunSummary for plain lines (so the caller can drive the
 * inline approval prompt). A throwing handler is caught; the loop survives.
 */
export async function dispatchInteractiveLine(
	line: string,
	ctx: CommandContext,
): Promise<"exit" | "handled" | HomeRunSummary> {
	if (line === "/exit") return "exit";
	if (line === "/help") {
		console.log(formatCommandHelp());
		return "handled";
	}
	if (line.startsWith("/")) {
		const [name, rest] = firstWord(line.slice(1));
		const spec = findCommand(name);
		if (spec) {
			try {
				await spec.handler(rest, ctx);
			} catch (error) {
				console.error(errorText(error));
			}
			return "handled";
		}
		console.error(`Unknown command /${name}. Type /help for commands.`);
		return "handled";
	}
	// Expand `@path` file mentions into fenced <file> blocks so the remote kernel
	// sees the content (the CLI is a thin client; the kernel can't read local disk).
	// Plain lines (no resolvable @token) pass through unchanged → zero I/O.
	const { text, attached, skipped } = expandFileMentions(line);
	// Fix #8: route human-text notices to stderr in --json mode to avoid
	// corrupting the JSON stdout stream.
	if (attached.length > 0) {
		const msg = dim(
			`  ↳ attached ${attached.length} file(s): ${attached.join(", ")}`,
			ctx.color,
		);
		if (ctx.json) console.error(msg);
		else console.log(msg);
	}
	if (skipped.length > 0) {
		const msg = dim(
			`  ↳ skipped @${skipped.join(", @")} (not a readable file — missing, a directory, binary, or >64KB)`,
			ctx.color,
		);
		if (ctx.json) console.error(msg);
		else console.log(msg);
	}
	const summary = await ctx.ops.send(text);
	reportSendResult(summary, ctx);
	return summary;
}

/**
 * Read one logical input line with `\`-continuation multiline. Gated to an
 * interactive TTY: over a non-TTY pipe, node:readline
 * won't deliver the continuation line to a second `question`, so we keep the
 * line literal there (composeMultiline is null-safe so a dropped continuation
 * never throws + drops the turn).
 */
async function readComposedLine(
	rl: ReturnType<typeof createInterface>,
	prompt: string,
): Promise<string> {
	return composeMultiline(
		(p) => rl.question(p),
		prompt,
		Boolean(process.stdin.isTTY),
	);
}

/**
 * Non-interactive surfacing of a parked approval (the inline [y]/[n]/[a] prompt
 * needs a TTY). Print the exact resolve commands so a scripted/piped operator
 * isn't left with a silently-skipped safety gate.
 *
 * Fix #8: in --json mode the message goes to stderr so it doesn't corrupt the
 * JSON stdout stream.
 */
function printApprovalCommands(
	summary: HomeRunSummary,
	color: ColorMode,
	json = false,
): void {
	const id = summary.homeRunId;
	const detail = summary.assistantText?.trim() ?? "";
	if (json) {
		console.error(
			`Run ${id} is parked for approval — resolve with: tedix approve ${id} / tedix reject ${id}`,
		);
		return;
	}
	const lines = [
		`${warn("●", color)} ${warn("Approval required", color)}  ${faint(`run ${id}`, color)}`,
		...(detail ? [`  ${muted(detail.slice(0, 240), color)}`] : []),
		`  ${faint("approve", color)} tedix approve ${id}    ${faint("reject", color)} tedix reject ${id}    ${faint("steer", color)} tedix steer ${id} "…"`,
	];
	console.log(lines.join("\n"));
}

export async function runInteractive(
	ctx: CommandContext,
	conversationId: string,
	options?: CliOptions,
) {
	const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);

	// TTY + non-json: delegate to the ink REPL for scrollable transcript. This
	// MUST branch out BEFORE createInterface() below: readline grabs
	// process.stdin (and a later rl.close() leaves it paused), which kills ink's
	// raw-mode input and makes ink unmount immediately on startup. So the ink
	// path must run before any readline touches stdin.
	if (isTty && !ctx.json) {
		await runInteractiveInk(ctx, conversationId, options);
		return;
	}

	// History recall (↑/↓), bumped from readline's default 30 to 200. The
	// completer handles BOTH `/command` and `@file` tokens (composer.ts).
	const rl = createInterface({
		completer: (line) => completeInput(line, commandNames()),
		historySize: 200,
		input,
		output,
	});
	// Session-scoped "always approve" cache (a common pattern). In-memory only —
	// never persisted, cleared when the REPL exits.
	const alwaysApprove = new Set<string>();

	// Non-blocking multiplexer: only active in TTY mode (non-TTY keeps serial
	// behavior for scripted/piped callers and --json).
	const registry = new InFlightRegistry();
	const muxAbort = new AbortController();

	// Live activity panel (TTY-only; no-op panel created for non-TTY).
	const panel = new LiveActivityPanel({
		isTty: isTty && !ctx.json,
		ops: ctx.client as unknown as import("./live-panel").PanelHomeOps,
	});

	// P4 idle-REPL SIGINT: prepend so it fires before the outer teardown handler.
	// TTY-only: on non-TTY we leave the outer handler alone.
	let exitRequested = false;
	const idleInterruptHandler = isTty
		? () => {
				const action = classifyInterrupt({
					isTty: true,
					turnRunning: false,
					hasText: (rl.line ?? "").length > 0,
					secondPressWithinWindow: false,
				});
				if (action === "clear") {
					process.stdout.write("\r\x1B[2K");
					rl.write("", { ctrl: true, name: "u" });
				} else {
					// empty line → close the REPL; the outer teardown still runs.
					exitRequested = true;
					rl.close();
				}
			}
		: null;

	if (idleInterruptHandler) {
		process.prependListener("SIGINT", idleInterruptHandler);
	}

	/** Build the prompt string, including in-flight count when > 0. */
	const buildPrompt = (): string => {
		const n = registry.count;
		// When the panel is active (TTY + non-json), the count is shown in the panel
		// header above the prompt, but we still include it in the prompt itself for
		// clarity and to keep the readComposedLine prompt consistent.
		return n > 0 ? `tedix [${n} running]> ` : "tedix> ";
	};

	/**
	 * Non-blocking dispatch for TTY mode.
	 *
	 * Plain text lines → askHome immediately, register in-flight, kick off a
	 * background settler, return "dispatched" so the loop can re-prompt.
	 * Slash commands (including /runs and /wait) are handled inline.
	 * Returns "exit" to quit, "dispatched" for a non-blocking send, or
	 * "handled" for slash commands.
	 */
	const dispatchNonBlockingLine = async (
		line: string,
	): Promise<"exit" | "dispatched" | "handled"> => {
		if (line === "/exit") return "exit";

		// ── /runs: list in-flight ──────────────────────────────────────────────
		if (line === "/runs" || line.startsWith("/runs ")) {
			const arg = line.startsWith("/runs ") ? line.slice(6).trim() : "";
			if (arg) {
				// /runs <prefix>: inspect a specific run by id prefix.
				const state = panel.findByPrefix(arg);
				if (!state) {
					// Fall back to registry for a plain label match.
					const inFlight = registry.list();
					const match = inFlight.find(
						(e) => e.homeRunId.startsWith(arg) || e.label.startsWith(arg),
					);
					if (match) {
						console.log(
							`  ${match.homeRunId}  ${match.label}  (${registry.elapsed(match)} elapsed)`,
						);
					} else {
						console.log(`No in-flight run matching "${arg}".`);
					}
					return "handled";
				}
				const snap = panel.snapshot();
				const row = snap.find((l) => l.includes(state.entry.label));
				if (row) console.log(row);
				const entry = state.entry;
				console.log(
					`  homeRunId=${entry.homeRunId}  conversationId=${entry.conversationId}  elapsed=${registry.elapsed(entry)}`,
				);
				if (state.summary?.status) {
					console.log(`  status=${state.summary.status}`);
				}
				if (state.tokens !== undefined) {
					console.log(`  tokens=${state.tokens}`);
				}
				if (state.childTotal !== undefined && state.childTotal > 0) {
					console.log(
						`  children=${state.childDone}/${state.childTotal} done  failed=${state.childFailed ?? 0}`,
					);
				}
				return "handled";
			}
			// /runs (no arg): static snapshot from the panel.
			printInFlightRunSnapshot(panel);
			return "handled";
		}

		// ── /wait: block until all settle ─────────────────────────────────────
		if (line === "/wait" || line.startsWith("/wait ")) {
			const n = registry.count;
			if (n === 0) {
				console.log("No in-flight runs to wait for.");
			} else {
				console.log(`Waiting for ${n} in-flight run(s)…`);
				await registry.waitAll({ signal: muxAbort.signal });
				panel.stop();
				console.log("All runs settled.");
			}
			return "handled";
		}

		// ── /help augmented with mux commands ─────────────────────────────────
		if (line === "/help") {
			console.log(formatCommandHelp());
			console.log(
				"  /runs                                 List in-flight runs (non-blocking mode)",
			);
			console.log(
				"  /wait                                 Wait until all in-flight runs settle",
			);
			return "handled";
		}

		// ── Other slash commands → blocking inline (same as before) ───────────
		if (line.startsWith("/")) {
			const [name, rest] = firstWord(line.slice(1));
			const spec = findCommand(name);
			if (spec) {
				try {
					await spec.handler(rest, ctx);
				} catch (error) {
					console.error(errorText(error));
				}
				return "handled";
			}
			console.error(`Unknown command /${name}. Type /help for commands.`);
			return "handled";
		}

		// ── Plain text → non-blocking dispatch ────────────────────────────────
		const { text, attached, skipped } = expandFileMentions(line);
		if (attached.length > 0) {
			console.log(
				`  ↳ attached ${attached.length} file(s): ${attached.join(", ")}`,
			);
		}
		if (skipped.length > 0) {
			console.log(
				`  ↳ skipped @${skipped.join(", @")} (not a readable file — missing, a directory, binary, or >64KB)`,
			);
		}

		const contentWithContext = ctx.ops
			? // build content — only add repo context if the outer options had it
				text
			: text;

		// Fire askHome and immediately return to the prompt.
		// If ask itself times out or fails, we surface the error inline.
		let summary: HomeRunSummary | null = null;
		try {
			const asked = await withTimeout(
				ctx.client.askHome({
					content: contentWithContext,
					conversationId: ctx.conversationId,
					metadata: {
						source: "tedix-cli",
						cwd: process.cwd(),
						mode: "interactive",
					},
				}),
				// Use a shorter timeout for the initial ask (not the full poll budget)
				// so the operator gets a fast error if auth/network is broken.
				30_000,
				"ASK_HOME_TIMEOUT",
			);
			summary = summarizeHomePayload(asked);
		} catch (error) {
			if (isAuthError(error)) {
				console.error(
					"Authentication failed. Run `tedix login` or check your gateway credentials.",
				);
				return "handled";
			}
			console.error(`Dispatch failed: ${errorText(error)}`);
			return "handled";
		}

		if (!summary) {
			console.error("ask returned no homeRunId");
			return "handled";
		}

		// Already settled synchronously (fast answer_in_home turn)?
		if (isSettledHomeStatus(summary.status)) {
			reportSendResult(summary, ctx);
			// Drive approval inline even in non-blocking mode for fast-settle turns.
			if (summary.status === "requires_approval") {
				await promptApproval(summary, ctx, rl, alwaysApprove);
			}
			return "dispatched";
		}

		// Register the run and start a background poller.
		const label = line.slice(0, 40);
		const inflightEntry = registry.add({
			homeRunId: summary.homeRunId,
			label,
			conversationId: ctx.conversationId,
		});
		panel.add(inflightEntry);

		// Fire and forget — the settler prints results above the prompt.
		void backgroundSettle({
			client: ctx.client,
			homeRunId: summary.homeRunId,
			initialSummary: summary,
			options: {
				conversationId: ctx.conversationId,
				follow: true,
				includeArchived: false,
				json: ctx.json,
				noColor: !ctx.color.enabled,
				poll: true,
				pollIntervalMs: ctx.pollIntervalMs,
				pollTimeoutMs: 120_000,
				repoContext: false, // already applied above
				requireCodeProof: false,
				requireWorkstation: false,
				url: ctx.client
					? ((ctx.client as unknown as { url?: string }).url ??
						DEFAULT_TEDIX_MCP_URL)
					: DEFAULT_TEDIX_MCP_URL,
			},
			color: ctx.color,
			registry,
			rl,
			panel,
			signal: muxAbort.signal,
		});

		return "dispatched";
	};

	/** Blocking line handler for non-TTY / serial paths. */
	const runLine = async (line: string): Promise<"exit" | "continue"> => {
		try {
			const result = await dispatchInteractiveLine(line, ctx);
			if (result === "exit") return "exit";
			if (result !== "handled" && result.status === "requires_approval") {
				if (isTty) {
					await promptApproval(result, ctx, rl, alwaysApprove);
				} else {
					// Non-TTY: the inline prompt is unanswerable (rl.question after EOF
					// throws), so surface the resolve commands instead of silently
					// skipping the approval.
					// Fix #8: pass json flag so the message goes to stderr in --json mode.
					printApprovalCommands(result, ctx.color, ctx.json);
				}
			}
		} catch (error) {
			console.error(errorText(error));
			// Fix #10: record a non-zero exit code so piped callers can detect failure.
			process.exitCode = process.exitCode || 1;
		}
		return "continue";
	};

	try {
		if (isTty) {
			// TTY + json: use the readline loop (json mode doesn't benefit from ink).
			console.log(`Tedix Home CLI (${conversationId})`);
			console.log(
				"Type /help for commands, @path to attach a file, end a line with \\ to continue,",
			);
			console.log(
				"/exit or Ctrl-D to quit. /runs lists in-flight, /wait blocks until settled.\n",
			);
			while (!exitRequested) {
				let line: string;
				try {
					line = (await readComposedLine(rl, buildPrompt())).trim();
				} catch {
					// readline closed: Ctrl-D (EOF), /exit, or our idle handler → quit.
					// Wait for in-flight runs before exiting gracefully.
					if (registry.count > 0) {
						console.log(
							`\nWaiting for ${registry.count} in-flight run(s) to settle before exit…`,
						);
						await registry.waitAll({ signal: muxAbort.signal }).catch(() => {});
					}
					console.log("");
					break;
				}
				if (!line) continue;
				try {
					const result = await dispatchNonBlockingLine(line);
					if (result === "exit") {
						// Wait for any in-flight runs before quitting.
						if (registry.count > 0) {
							console.log(
								`Waiting for ${registry.count} in-flight run(s) to settle…`,
							);
							await registry
								.waitAll({ signal: muxAbort.signal })
								.catch(() => {});
						}
						break;
					}
				} catch (error) {
					console.error(errorText(error));
					process.exitCode = process.exitCode || 1;
				}
			}
		} else {
			// Non-TTY (piped / scripted): iterate with `for await`, which DELIVERS
			// EVERY line. A `rl.question` loop only ever yields the FIRST line over a
			// pipe and silently drops the rest (exit 0) — the structural bug behind
			// scripted multi-turn chat and inline approvals failing.
			for await (const rawLine of rl) {
				const line = rawLine.trim();
				if (!line) continue;
				if ((await runLine(line)) === "exit") break;
			}
		}
	} finally {
		panel.stop();
		muxAbort.abort();
		if (idleInterruptHandler) {
			process.off("SIGINT", idleInterruptHandler);
		}
		rl.close();
	}
}
