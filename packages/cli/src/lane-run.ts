import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	ReportWorkAgentSessionStatusInputSchema,
	LaneTelemetryInputSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
import type { NativeProviderActivity } from "@tedix/api-contract/schemas/dispatcher-health";
import type { DevinWorkBridge } from "./devin-work-bridge";
import { laneChildEnv } from "./lane-child-env";
import type { LaneObservation } from "./lane-telemetry";
import { laneOutput } from "./lane-output";

export const laneRunUsage = `tedix lane run --executor codex|claude-code|opencode|devin|tedi|skill --brief <file> --project <id>
  [--model <id>] [--reasoning <effort>] [--rate-scope <scope>] [--work-item <id>]
  [--transcript <file>] [--telemetry <file>] -- <command> [args...]
tedix lane import --executor codex|claude-code --transcript <file> --project <id> [--apply]
Devin needs no command after --; its runner supplies prompt-file, resume and permission arguments.

Registers observations using the owner's selected organization. A report grants no
Work execution authority: the child still obtains its own Attempt with lane start.
Codex exec uses its JSON thread receipt to select its exact rollout, even with concurrent lanes.
Claude JSON output selects its native transcript. Other executors write the common telemetry
JSON to TEDIX_LANE_TELEMETRY_PATH. Missing facts remain unknown. Import previews by default. Retry a saved observation with lane report --input-file <receipt>.`;

export async function reportLaneObservation(
	input: Record<string, unknown>,
	scope: string[],
) {
	const { createLaneReporter } = await import("./lane-reporter");
	const reporter = createLaneReporter();
	try {
		return await reporter.report(input, scope);
	} finally {
		await reporter.close();
	}
}

export const LANE_HEARTBEAT_MS = 120_000;
export const OPENCODE_PROVIDER_STALL_MS = 15 * 60_000;

export function openCodeExportHasNoToolAction(
	value: unknown,
	sessionKey: string,
	messageId: string,
): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const exported = value as Record<string, unknown>;
	const info = exported.info as Record<string, unknown> | undefined;
	if (info?.id !== sessionKey || !Array.isArray(exported.messages))
		return false;
	const message = exported.messages.find((candidate) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			return false;
		return (candidate as { info?: { id?: unknown } }).info?.id === messageId;
	}) as { info?: { role?: unknown }; parts?: unknown[] } | undefined;
	return (
		message?.info?.role === "assistant" &&
		Array.isArray(message.parts) &&
		!message.parts.some(
			(part) =>
				!!part &&
				typeof part === "object" &&
				!Array.isArray(part) &&
				(part as { type?: unknown }).type === "tool",
		)
	);
}

async function confirmOpenCodeStallSafe(
	executable: string,
	sessionKey: string,
	messageId: string,
): Promise<boolean> {
	return await new Promise((resolve) => {
		const child = spawn(executable, ["export", sessionKey], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		let oversized = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.stdout.on("data", (chunk: Buffer) => {
			if (output.length + chunk.length > 16 * 1024 * 1024) {
				oversized = true;
				child.kill("SIGKILL");
				return;
			}
			output += chunk.toString();
		});
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 || oversized) return resolve(false);
			try {
				resolve(
					openCodeExportHasNoToolAction(
						JSON.parse(output),
						sessionKey,
						messageId,
					),
				);
			} catch {
				resolve(false);
			}
		});
	});
}

export function codexTranscript(
	sessionKey: string,
	env = process.env,
): string | undefined {
	const root = join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
	// Only native thread ids may influence traversal.
	if (!/^[a-f0-9-]{36}$/.test(sessionKey)) return;
	const days: string[] = [];
	for (const year of readdirSync(root)) {
		if (!/^\d{4}$/.test(year)) continue;
		for (const month of readdirSync(join(root, year))) {
			if (!/^\d{2}$/.test(month)) continue;
			for (const day of readdirSync(join(root, year, month))) {
				if (/^\d{2}$/.test(day)) days.push(join(root, year, month, day));
			}
		}
	}
	for (const day of days.reverse()) {
		const file = readdirSync(day).find((name) =>
			name.endsWith(`-${sessionKey}.jsonl`),
		);
		if (file) return join(day, file);
	}
}

async function runLaneProcessWithReporter(
	args: string[],
	deps: {
		report?: typeof reportLaneObservation;
		heartbeatMs?: number;
		sessionKey?: string;
		label?: string;
		cwd?: string;
		childScope?: { workspace: string; organization: string };
		detachedChild?: boolean;
		detachedOutputDirectory?: string;
		/** A dispatcher drains its children and owns process shutdown itself. */
		forwardSignals?: boolean;
		/** The caller already holds an admitted Attempt for this Work. */
		admitted?: boolean;
		devinWorkBridge?: DevinWorkBridge;
		deliverWorkNote?: (note: string) => Promise<void>;
		onSpawn?: (pid: number) => void;
		onTelemetry?: (value: LaneObservation) => void;
		onNativeActivity?: (value: NativeProviderActivity) => void;
		providerStallMs?: number;
		confirmProviderStallSafe?: (input: {
			executable: string;
			sessionKey: string;
			messageId: string;
		}) => Promise<boolean>;
	} = {},
): Promise<number> {
	const sendReport = deps.report ?? reportLaneObservation;
	const separator = args.indexOf("--");
	const before = separator < 0 ? args : args.slice(0, separator);
	const command = separator < 0 ? [] : args.slice(separator + 1);
	const options = new Map<string, string>();
	const scope: string[] = [];
	let apply = false;
	for (let i = 1; i < before.length; i++) {
		const key = before[i]!;
		if (key === "--apply") {
			apply = true;
			continue;
		}
		if (
			![
				"--input",
				"--input-file",
				"--lane-transcript",
				"--executor",
				"--brief",
				"--project",
				"--model",
				"--reasoning",
				"--rate-scope",
				"--work-item",
				"--transcript",
				"--telemetry",
				"-w",
				"--workspace",
				"--organization",
			].includes(key)
		)
			throw new Error(`Unknown lane option ${key}`);
		const value = before[++i];
		if (!value) throw new Error(`${key} needs a value`);
		if (["-w", "--workspace", "--organization"].includes(key))
			scope.push(key, value);
		options.set(key, value);
	}
	if (args[0] === "report") {
		const input = JSON.parse(
			options.has("--input-file")
				? readFileSync(options.get("--input-file")!, "utf8")
				: (options.get("--input") ?? "{}"),
		);
		const path = options.get("--lane-transcript");
		if (path && ["codex", "claude-code"].includes(input.harness)) {
			try {
				const { parseLaneTranscript } = await import("./lane-telemetry");
				const parsed = await parseLaneTranscript(path, input.harness);
				input.telemetry = {
					...parsed.telemetry,
					source: "hook",
					...(process.env.TEDIX_LANE_RATE_SCOPE
						? { rateScope: process.env.TEDIX_LANE_RATE_SCOPE }
						: {}),
				};
				if (input.state === "working") {
					input.telemetry.finishedAt = null;
					input.telemetry.outcome = null;
				}
			} catch {
				/* Keep the status when a transcript is not available yet. */
			}
		}
		console.log(
			JSON.stringify(
				await sendReport(
					ReportWorkAgentSessionStatusInputSchema.parse(input),
					scope,
				),
			),
		);
		return 0;
	}
	const executor = options.get("--executor");
	if (
		!["codex", "claude-code", "opencode", "devin", "tedi", "skill"].includes(
			executor ?? "",
		)
	)
		throw new Error(
			"Choose --executor codex|claude-code|opencode|devin|tedi|skill",
		);
	const projectId = options.get("--project");
	if (!projectId) throw new Error("--project is required");
	const devin = executor === "devin";
	const opencode = executor === "opencode";
	if (devin) {
		const { assertDevinProjectHooks } = await import("./devin-lane-security");
		assertDevinProjectHooks(deps.cwd ?? process.cwd());
	}
	const devinThreadModule = devin
		? await import("./devin-lane-thread")
		: undefined;
	const opencodeThreadModule =
		opencode && !deps.sessionKey
			? await import("./opencode-lane-thread")
			: undefined;
	const nativeThread =
		devin && !deps.sessionKey
			? await devinThreadModule!.createDevinLaneThread(
					deps.cwd ?? process.cwd(),
					command[0] ?? "devin",
					options.get("--model"),
				)
			: opencodeThreadModule
				? await opencodeThreadModule.createOpenCodeLaneThread(
						deps.cwd ?? process.cwd(),
						options.get("--model") ?? "",
					)
				: undefined;
	const sessionKey = deps.sessionKey ?? nativeThread?.thread.id ?? randomUUID();
	const startedAt = new Date().toISOString();
	let telemetry: LaneObservation = {
		executor: executor as LaneObservation["executor"],
		model: nativeThread?.model ?? options.get("--model") ?? null,
		provider: devin
			? "devin"
			: executor === "codex"
				? "openai"
				: executor === "claude-code"
					? "anthropic"
					: opencode
						? (options.get("--model")?.split("/")[0] ?? null)
						: null,
		reasoningEffort: options.get("--reasoning") ?? null,
		brief: options.has("--brief")
			? readFileSync(options.get("--brief")!, "utf8").slice(0, 24000)
			: "",
		startedAt,
		heartbeatAt: startedAt,
		finishedAt: null,
		outcome: null,
		tools: {},
		usage: null,
		finalMessage: "",
		shas: [],
		workItems: options.has("--work-item") ? [options.get("--work-item")!] : [],
		corrections: [],
		source: "wrapper",
		...(options.has("--rate-scope")
			? { rateScope: options.get("--rate-scope")! }
			: {}),
	};
	const label = (
		deps.label?.trim() ||
		(options.has("--work-item")
			? ""
			: /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(telemetry.brief)?.[1] ||
				telemetry.brief)
	)
		.replace(/\s+/g, " ")
		.slice(0, 120);
	const observationInput = (key: string, observed: LaneObservation) => ({
		harness: executor,
		sessionKey: key,
		projectId,
		...(options.has("--work-item")
			? { workItemId: options.get("--work-item") }
			: {}),
		state:
			observed.outcome === "failed"
				? "error"
				: observed.finishedAt
					? "done"
					: "working",
		label,
		summary: observed.finalMessage.replace(/\s+/g, " ").slice(0, 200),
		telemetry: LaneTelemetryInputSchema.parse(observed),
	});
	const report = (key: string, observed: LaneObservation) =>
		sendReport(observationInput(key, observed), scope);
	if (args[0] === "import") {
		if (
			!options.has("--transcript") ||
			!["codex", "claude-code"].includes(executor!)
		)
			throw new Error("Import needs a Codex or Claude transcript");
		const { parseLaneTranscript } = await import("./lane-telemetry");
		const parsed = await parseLaneTranscript(
			options.get("--transcript")!,
			executor as "codex" | "claude-code",
		);
		telemetry = {
			...parsed.telemetry,
			...(telemetry.rateScope ? { rateScope: telemetry.rateScope } : {}),
		};
		console.log(
			JSON.stringify(
				apply
					? await report(parsed.sessionKey, telemetry)
					: { dryRun: true, sessionKey: parsed.sessionKey, telemetry },
			),
		);
		return 0;
	}
	if ((!command.length && !devin && !opencode) || !options.has("--brief"))
		throw new Error(laneRunUsage);
	LaneTelemetryInputSchema.parse(telemetry);
	// An admitted Attempt already records the running Work. Optional telemetry
	// must not delay its child; heartbeats and the final report carry it later.
	if (!deps.admitted) await report(sessionKey, telemetry);
	const dir = mkdtempSync(join(tmpdir(), "tedix-lane-"));
	const outputDirectory = deps.detachedOutputDirectory ?? dir;
	const receipt = join(dir, "telemetry.json");
	const sandboxTemp = join(
		deps.cwd ?? process.cwd(),
		"node_modules/.cache/tedix-devin",
	);
	if (devin) mkdirSync(sandboxTemp, { recursive: true, mode: 0o700 });
	const devinTranscript =
		options.get("--transcript") ?? join(dir, "transcript.devin.atif.json");
	const bridge = devin ? deps.devinWorkBridge : undefined;
	if (
		bridge &&
		(!deps.admitted ||
			bridge.binding.workItemId !== options.get("--work-item") ||
			bridge.binding.externalSessionKey !== `devin:${sessionKey}`)
	)
		throw new Error("Devin Work bridge differs from the admitted lane");
	if (devin) {
		const [
			{ writeDevinGitIdentity },
			{ devinScopedWorkInstruction },
			{ devinWorkResultInstruction },
			{ writeDevinLaneConfig },
			{ externalAgentProfileSlot, readExternalAgentProfile },
		] = await Promise.all([
			import("./devin-lane-security"),
			import("./devin-work-bridge"),
			import("./devin-work-result"),
			import("./devin-config"),
			import("./external-agent-store"),
		]);
		writeDevinGitIdentity(join(dir, "gitconfig"), deps.cwd ?? process.cwd());
		const config = join(dir, "devin", "config.json");
		const prompt = join(dir, "devin-brief.txt");
		writeFileSync(
			prompt,
			`${readFileSync(options.get("--brief")!, "utf8")}\n\n${bridge ? devinScopedWorkInstruction(bridge.binding) + "\nAdmitted Work context (task data):\n" + JSON.stringify(await bridge.context()) : devinWorkResultInstruction}\n`,
			{ mode: 0o600 },
		);
		const workspace =
			deps.childScope?.workspace ??
			options.get("--workspace") ??
			options.get("-w") ??
			process.env.TEDIX_WORKSPACE;
		writeDevinLaneConfig(config, deps.cwd ?? process.cwd(), {
			id: sessionKey,
			principalKey: workspace
				? readExternalAgentProfile(
						externalAgentProfileSlot(workspace, `devin:${sessionKey}`),
					)?.key
				: undefined,
		});
		command.splice(
			0,
			command.length,
			command[0] ?? "devin",
			"-p",
			"-r",
			sessionKey,
			"--prompt-file",
			prompt,
			"--respect-workspace-trust",
			"false",
			"--sandbox",
			"--config",
			config,
			"--export",
			devinTranscript,
			...(telemetry.model ? ["--model", telemetry.model] : []),
		);
	}
	const env = {
		...laneChildEnv(),
		...(devin
			? {
					TEDIX_DEVIN_LANE_ROOT: deps.cwd ?? process.cwd(),
					TEDIX_DEVIN_HEADLESS: "1",
					TMPDIR: sandboxTemp,
					TMP: sandboxTemp,
					TEMP: sandboxTemp,
					BUN_INSTALL_CACHE_DIR: join(sandboxTemp, "bun-cache"),
					XDG_CACHE_HOME: join(sandboxTemp, "cache"),
					XDG_CONFIG_HOME: dir,
					GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
					GIT_CONFIG_NOSYSTEM: "1",
					TEDIX_AGENT_SESSION: `devin:${sessionKey}`,
				}
			: {}),
		TEDIX_WORKSPACE:
			deps.childScope?.workspace ??
			options.get("--workspace") ??
			options.get("-w") ??
			process.env.TEDIX_WORKSPACE,
		TEDIX_ORGANIZATION:
			deps.childScope?.organization ??
			options.get("--organization") ??
			process.env.TEDIX_ORGANIZATION,
		TEDIX_LANE_ID: sessionKey,
		TEDIX_LANE_LABEL: label,
		...(opencode ? { OPENCODE_DISABLE_AUTOUPDATE: "true" } : {}),
		TEDIX_LANE_TELEMETRY_PATH: receipt,
		TEDIX_LANE_RATE_SCOPE: telemetry.rateScope ?? "",
	};
	let nativeId: string | undefined,
		identityMismatch = false,
		buffer = "";
	let devinStderr = "";
	let devinDeclaration = "";
	let streamError = false;
	let streamFailureMessage = "";
	let lastTextMessage: string | undefined;
	let nativeActivity: NativeProviderActivity | undefined;
	let nativeToolActions = 0;
	let providerStalled = false;
	let stallCheckPending = false;
	let nativeMessageId: string | undefined;
	const nativeToolCalls = new Set<string>();
	const observeNativeActivity = (
		state: NativeProviderActivity["state"],
		tool?: string,
	) => {
		nativeActivity = {
			state,
			observedAt: new Date().toISOString(),
			...(tool ? { tool: tool.slice(0, 100) } : {}),
		};
		deps.onNativeActivity?.(nativeActivity);
	};
	const codexJson =
		executor === "codex" &&
		basename(command[0]!) === "codex" &&
		command[1] === "exec";
	if (codexJson && !command.includes("--json")) command.splice(2, 0, "--json");
	const claudeJson =
		executor === "claude-code" &&
		basename(command[0]!) === "claude" &&
		command[command.indexOf("--output-format") + 1] === "stream-json";
	if (opencode && !command.length)
		command.push(
			"opencode",
			"run",
			"--dir",
			deps.cwd ?? process.cwd(),
			"--format",
			"json",
			"--model",
			options.get("--model") ?? "",
			"--auto",
			"--session",
			sessionKey,
		);
	let heartbeat: Promise<unknown> | undefined;
	let exitCode = 1,
		signal: NodeJS.Signals | null = null;
	for (let turn = 0; turn < (bridge ? 2 : 1); turn++) {
		if (bridge) telemetry.finalMessage = "";
		const stdout = deps.detachedChild
			? laneOutput(join(outputDirectory, `stdout-${turn}.log`), (chunk) =>
					receiveStdout(chunk),
				)
			: undefined;
		const stderr = deps.detachedChild
			? laneOutput(join(outputDirectory, `stderr-${turn}.log`), (chunk) =>
					receiveStderr(chunk),
				)
			: undefined;
		const child = spawn(command[0]!, command.slice(1), {
			env,
			cwd: deps.cwd,
			detached: deps.detachedChild,
			stdio: [
				"pipe",
				stdout?.fd ??
					(codexJson || claudeJson || opencode || devin ? "pipe" : "inherit"),
				stderr?.fd ?? "pipe",
			],
		});
		let turnClosed = false;
		let stallKillTimer: ReturnType<typeof setTimeout> | undefined;
		if (child.pid) deps.onSpawn?.(child.pid);
		function receiveStderr(chunk: Buffer) {
			process.stderr.write(chunk);
			devinStderr = (devinStderr + chunk.toString()).slice(-24000);
		}
		child.stderr?.on("data", receiveStderr);
		child.stdin?.end(devin ? undefined : readFileSync(options.get("--brief")!));
		function receiveStdout(chunk: Buffer) {
			process.stdout.write(chunk);
			if (devin) {
				telemetry.finalMessage = (
					telemetry.finalMessage + chunk.toString()
				).slice(-24000);
				return;
			}
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop()!.slice(-65536);
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					if (
						event.type === "error" ||
						(claudeJson && event.type === "result" && event.is_error)
					) {
						streamError ||=
							opencode ||
							(claudeJson &&
								event.type === "result" &&
								event.is_error === true);
						streamFailureMessage = JSON.stringify(event.error ?? event).slice(
							-24000,
						);
					}

					if (opencode) {
						if (event.sessionID) {
							nativeId = event.sessionID;
							if (nativeId !== sessionKey) {
								identityMismatch = true;
								child.kill("SIGTERM");
							}
						}
						if (event.type === "text" && !streamError) {
							observeNativeActivity("provider_progress");
							if (lastTextMessage !== event.part?.messageID)
								telemetry.finalMessage = "";
							lastTextMessage = event.part?.messageID;
							telemetry.finalMessage = (
								telemetry.finalMessage + (event.part?.text ?? "")
							).slice(-24000);
						}
						if (event.type === "step_start") {
							nativeMessageId = event.part?.messageID;
							observeNativeActivity("provider_waiting");
						}
						if (
							event.type === "permission.asked" ||
							event.type === "permission_asked"
						)
							observeNativeActivity("approval_wait");
						if (event.type === "tool_use") {
							const tool = event.part?.tool;
							const callId = event.part?.callID ?? event.part?.id;
							const first =
								typeof callId !== "string" || !nativeToolCalls.has(callId);
							if (typeof callId === "string") nativeToolCalls.add(callId);
							if (first) {
								nativeToolActions++;
								if (typeof tool === "string")
									telemetry.tools[tool] = (telemetry.tools[tool] ?? 0) + 1;
							}
							if (event.part?.state?.status === "pending")
								observeNativeActivity(
									"tool_pending",
									typeof tool === "string" ? tool : undefined,
								);
							else if (event.part?.state?.status === "running")
								observeNativeActivity(
									"tool_running",
									typeof tool === "string" ? tool : undefined,
								);
							else observeNativeActivity("provider_waiting");
						}
					}
					if (
						(codexJson && event.type === "thread.started") ||
						(claudeJson && event.type === "system" && event.subtype === "init")
					) {
						nativeId = codexJson ? event.thread_id : event.session_id;
						if (deps.sessionKey && nativeId !== deps.sessionKey) {
							identityMismatch = true;
							child.kill("SIGTERM");
						}
					}
				} catch {}
			}
		}
		child.stdout?.on("data", receiveStdout);
		const timer = setInterval(() => {
			if (heartbeat) return;
			heartbeat = report(sessionKey, {
				...telemetry,
				heartbeatAt: new Date().toISOString(),
			})
				.catch((error) =>
					process.stderr.write(`Lane heartbeat: ${String(error)}\n`),
				)
				.finally(() => {
					heartbeat = undefined;
				});
		}, deps.heartbeatMs ?? LANE_HEARTBEAT_MS);
		const forward = (signal: NodeJS.Signals) => {
			try {
				if (deps.detachedChild && child.pid) process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				/* The child may have just exited. */
			}
		};
		const interrupt = () => forward("SIGINT"),
			terminate = () => forward("SIGTERM");
		const providerStallMs = deps.providerStallMs ?? OPENCODE_PROVIDER_STALL_MS;
		const stallTimer = opencode
			? setInterval(
					() => {
						if (
							providerStalled ||
							stallCheckPending ||
							!nativeActivity ||
							!nativeId ||
							!nativeMessageId ||
							nativeId !== sessionKey ||
							nativeToolActions !== 0 ||
							nativeActivity.state === "tool_pending" ||
							nativeActivity.state === "tool_running" ||
							nativeActivity.state === "approval_wait" ||
							Date.now() - Date.parse(nativeActivity.observedAt) <
								providerStallMs
						)
							return;
						const observedAt = nativeActivity.observedAt;
						stallCheckPending = true;
						void (
							deps.confirmProviderStallSafe?.({
								executable: command[0]!,
								sessionKey,
								messageId: nativeMessageId,
							}) ??
							confirmOpenCodeStallSafe(command[0]!, sessionKey, nativeMessageId)
						)
							.then((safe) => {
								if (
									!safe ||
									turnClosed ||
									providerStalled ||
									nativeToolActions !== 0 ||
									nativeActivity?.observedAt !== observedAt ||
									nativeActivity.state === "approval_wait"
								)
									return;
								providerStalled = true;
								observeNativeActivity("provider_stalled");
								terminate();
								stallKillTimer = setTimeout(() => forward("SIGKILL"), 5000);
							})
							.finally(() => {
								stallCheckPending = false;
							});
					},
					Math.min(30_000, Math.max(10, Math.floor(providerStallMs / 2))),
				)
			: undefined;
		if (deps.forwardSignals !== false) {
			process.on("SIGINT", interrupt);
			process.on("SIGTERM", terminate);
		}
		try {
			[exitCode, signal] = await new Promise<[number, NodeJS.Signals | null]>(
				(resolve, reject) => {
					child.once("error", reject);
					child.once("close", (code, sig) => resolve([code ?? 1, sig]));
				},
			);
		} catch (error) {
			exitCode = 1;
			signal = null;
			telemetry.finalMessage = String(error);
		} finally {
			turnClosed = true;
			clearInterval(timer);
			if (stallTimer) clearInterval(stallTimer);
			if (stallKillTimer) clearTimeout(stallKillTimer);
			stdout?.close();
			stderr?.close();
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		}
		if (
			identityMismatch ||
			streamError ||
			(devin &&
				devinStderr.includes(
					"rejected a tool call that requires confirmation",
				)) ||
			(deps.sessionKey &&
				(codexJson || claudeJson || opencode) &&
				nativeId !== deps.sessionKey)
		)
			exitCode = 1;
		if (exitCode !== 0 && !telemetry.finalMessage)
			telemetry.finalMessage = devinStderr.slice(-24000);
		if (providerStalled) {
			exitCode = 1;
			telemetry.finalMessage =
				"OpenCode provider stream made no progress before any tool action or approval request; the dispatcher stopped this turn for safe fresh recovery.";
		}
		try {
			if (devin) {
				const exported = JSON.parse(readFileSync(devinTranscript, "utf8"));
				if (exported.session_id !== sessionKey)
					throw new Error(
						"Devin transcript identity differs from the admitted session",
					);
				telemetry.shas = [
					...new Set(telemetry.finalMessage.match(/\b[a-f0-9]{40}\b/g) ?? []),
				].slice(0, 100);
			}
			if (devin) {
				const { devinSessionIds } = await import("./devin-lane-thread");
				if (
					!devinSessionIds(deps.cwd ?? process.cwd(), command[0]!).includes(
						sessionKey,
					)
				)
					throw new Error(
						"Devin resumed session was not found in this worktree",
					);
			}
			let path = options.get("--transcript");
			if (!path && nativeId)
				if (executor === "claude-code") {
					const { claudeConfigDirectory, claudeTranscript } =
						await import("./claude-lane-thread");
					path = claudeTranscript(
						nativeId,
						claudeConfigDirectory(env, deps.cwd),
					);
				} else path = codexTranscript(nativeId);
			if (deps.sessionKey && claudeJson && !path) {
				exitCode = 1;
				telemetry.finalMessage =
					"Native Claude transcript is unavailable; result needs reconciliation";
			}
			if (path && ["codex", "claude-code"].includes(executor!)) {
				const { parseLaneTranscript } = await import("./lane-telemetry");
				const parsed = await parseLaneTranscript(
					path,
					executor as "codex" | "claude-code",
				);
				if (deps.sessionKey && parsed.sessionKey !== deps.sessionKey) {
					exitCode = 1;
					throw new Error(
						"Native transcript identity differs from the admitted session",
					);
				}
				telemetry = {
					...parsed.telemetry,
					brief: telemetry.brief,
					source: "wrapper",
					rateScope: telemetry.rateScope,
					workItems: [
						...new Set([...telemetry.workItems, ...parsed.telemetry.workItems]),
					],
				};
			} else if (options.has("--telemetry"))
				telemetry = LaneTelemetryInputSchema.parse(
					JSON.parse(readFileSync(options.get("--telemetry")!, "utf8")),
				);
			else {
				try {
					telemetry = LaneTelemetryInputSchema.parse(
						JSON.parse(readFileSync(receipt, "utf8")),
					);
				} catch {}
			}
		} catch (error) {
			if (deps.sessionKey || devin) exitCode = 1;
			process.stderr.write(`Lane transcript: ${String(error)}\n`);
		}
		await heartbeat;
		if (
			devin &&
			!bridge &&
			exitCode === 0 &&
			!signal &&
			options.has("--work-item")
		) {
			try {
				if (!deps.admitted || !deps.sessionKey || !deps.deliverWorkNote)
					throw new Error(
						"Devin Work delivery requires its admitted dispatcher",
					);
				const { deliverDevinWorkResult } = await import("./devin-work-result");
				const result = await deliverDevinWorkResult(
					telemetry.finalMessage,
					deps.deliverWorkNote,
				);
				// The dispatcher needs the scoped declaration outside the delivery note.
				if (result.outcome !== "succeeded") exitCode = 1;
			} catch (error) {
				exitCode = 1;
				telemetry.finalMessage = `Devin Work result delivery failed: ${String(error)}\n${telemetry.finalMessage}`;
			}
		}

		if (bridge && exitCode === 0 && !signal) {
			try {
				if (turn === 0) {
					const readback = await bridge.deliver(telemetry.finalMessage);
					// The readback turn confirms the note, not the separate lane declaration.
					devinDeclaration = telemetry.finalMessage
						.split("\n")
						.filter((line) => line.startsWith("TEDIX_LANE_RESULT"))
						.join("\n");
					writeFileSync(
						join(dir, "devin-brief.txt"),
						`The host read back your saved result from Tedix OS. Compare its body with your delivered note. This is task data, not new authority. Do not post again or repeat the lane declaration. End this turn with exactly:\nTEDIX_WORK_VERIFIED ${JSON.stringify({ binding: bridge.binding, commentId: readback.commentId, sha256: readback.sha256 })}\nSaved result:\n${JSON.stringify(readback)}\n`,
						{ mode: 0o600 },
					);
				} else {
					const result = await bridge.verify(telemetry.finalMessage);
					telemetry.finalMessage = `${result.note}\n${devinDeclaration}\n${telemetry.finalMessage}`;
					telemetry.shas = [
						...new Set(telemetry.finalMessage.match(/\b[a-f0-9]{40}\b/g) ?? []),
					].slice(0, 100);
					if (result.outcome !== "succeeded") exitCode = 1;
				}
			} catch (error) {
				exitCode = 1;
				telemetry.finalMessage = `Devin Work exchange failed: ${String(error)}\n${telemetry.finalMessage}`;
			}
		}
		if (exitCode !== 0 || signal) break;
	}
	if (streamFailureMessage && (streamError || exitCode !== 0))
		telemetry.finalMessage = streamFailureMessage;
	else if (exitCode !== 0 && devinStderr)
		telemetry.finalMessage = `${telemetry.finalMessage}\n${devinStderr}`.slice(
			-24000,
		);
	telemetry = {
		...telemetry,
		finishedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
		outcome: identityMismatch
			? "failed"
			: signal
				? "stopped"
				: exitCode === 0
					? "succeeded"
					: "failed",
	};
	deps.onTelemetry?.(telemetry);
	writeFileSync(
		receipt,
		JSON.stringify(observationInput(sessionKey, telemetry)),
		{
			mode: 0o600,
		},
	);
	try {
		await report(sessionKey, telemetry);
	} catch (error) {
		process.stderr.write(
			`Lane settlement failed; retryable observation saved at ${receipt}: ${String(error)}\n`,
		);
		return exitCode || 1;
	}
	if (devin && !options.has("--transcript")) {
		rmSync(receipt, { force: true });
		rmSync(join(dir, "devin"), { recursive: true, force: true });
		rmSync(join(dir, "gitconfig"), { force: true });
		process.stderr.write(`Devin transcript retained at ${devinTranscript}\n`);
	} else rmSync(dir, { recursive: true, force: true });
	return exitCode;
}

export async function runLaneProcess(
	args: string[],
	deps: Parameters<typeof runLaneProcessWithReporter>[1] = {},
): Promise<number> {
	const reporter = deps.report
		? undefined
		: (await import("./lane-reporter")).createLaneReporter();
	try {
		return await runLaneProcessWithReporter(args, {
			...deps,
			report: deps.report ?? reporter!.report,
		});
	} finally {
		await reporter?.close();
	}
}
