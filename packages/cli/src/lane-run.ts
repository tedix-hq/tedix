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
import { createLaneReporter } from "./lane-reporter";
import { createOpenCodeLaneThread } from "./opencode-lane-thread";
import { createDevinLaneThread, devinSessionIds } from "./devin-lane-thread";
import { writeDevinLaneConfig } from "./devin-config";
import {
	assertDevinProjectHooks,
	writeDevinGitIdentity,
} from "./devin-lane-security";
import { readExternalAgentProfile } from "./external-agent-store";
import { laneChildEnv } from "./lane-child-env";
import { claudeConfigDirectory, claudeTranscript } from "./claude-lane-thread";
import { parseLaneTranscript, type LaneObservation } from "./lane-telemetry";

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
	const reporter = createLaneReporter();
	try {
		return await reporter.report(input, scope);
	} finally {
		await reporter.close();
	}
}

export const LANE_HEARTBEAT_MS = 120_000;

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
		onSpawn?: (pid: number) => void;
		onTelemetry?: (value: LaneObservation) => void;
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
	if (devin) assertDevinProjectHooks(deps.cwd ?? process.cwd());
	const nativeThread =
		devin && !deps.sessionKey
			? await createDevinLaneThread(
					deps.cwd ?? process.cwd(),
					command[0] ?? "devin",
					options.get("--model"),
				)
			: opencode && !deps.sessionKey
				? await createOpenCodeLaneThread(
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
	await report(sessionKey, telemetry);
	const dir = mkdtempSync(join(tmpdir(), "tedix-lane-"));
	const receipt = join(dir, "telemetry.json");
	const sandboxTemp = join(
		deps.cwd ?? process.cwd(),
		"node_modules/.cache/tedix-devin",
	);
	if (devin) mkdirSync(sandboxTemp, { recursive: true, mode: 0o700 });
	const devinTranscript =
		options.get("--transcript") ?? join(dir, "transcript.devin.atif.json");
	if (devin) {
		writeDevinGitIdentity(join(dir, "gitconfig"), deps.cwd ?? process.cwd());
		const config = join(dir, "devin.json");
		const workspace =
			deps.childScope?.workspace ??
			options.get("--workspace") ??
			options.get("-w") ??
			process.env.TEDIX_WORKSPACE;
		writeDevinLaneConfig(config, deps.cwd ?? process.cwd(), {
			id: sessionKey,
			principalKey: workspace
				? readExternalAgentProfile(workspace)?.key
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
			options.get("--brief")!,
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
	let streamError = false;
	let streamFailureMessage = "";
	let lastTextMessage: string | undefined;
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
	const child = spawn(command[0]!, command.slice(1), {
		env,
		cwd: deps.cwd,
		detached: deps.detachedChild,
		stdio: [
			"pipe",
			codexJson || claudeJson || opencode || devin ? "pipe" : "inherit",
			"pipe",
		],
	});
	if (child.pid) deps.onSpawn?.(child.pid);
	child.stderr?.on("data", (chunk) => {
		process.stderr.write(chunk);
		devinStderr = (devinStderr + chunk.toString()).slice(-24000);
	});
	child.stdin?.end(devin ? undefined : readFileSync(options.get("--brief")!));
	child.stdout?.on("data", (chunk) => {
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
						(claudeJson && event.type === "result" && event.is_error === true);
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
						if (lastTextMessage !== event.part?.messageID)
							telemetry.finalMessage = "";
						lastTextMessage = event.part?.messageID;
						telemetry.finalMessage = (
							telemetry.finalMessage + (event.part?.text ?? "")
						).slice(-24000);
					}
					if (event.type === "tool_use") {
						const tool = event.part?.tool;
						if (typeof tool === "string")
							telemetry.tools[tool] = (telemetry.tools[tool] ?? 0) + 1;
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
	});
	let heartbeat: Promise<unknown> | undefined;
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
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", terminate);
	let exitCode: number, signal: NodeJS.Signals | null;
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
		clearInterval(timer);
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
		if (
			devin &&
			!devinSessionIds(deps.cwd ?? process.cwd(), command[0]!).includes(
				sessionKey,
			)
		)
			throw new Error("Devin resumed session was not found in this worktree");
		const path =
			options.get("--transcript") ??
			(nativeId
				? executor === "claude-code"
					? claudeTranscript(nativeId, claudeConfigDirectory(env, deps.cwd))
					: codexTranscript(nativeId)
				: undefined);
		if (deps.sessionKey && claudeJson && !path) {
			exitCode = 1;
			telemetry.finalMessage =
				"Native Claude transcript is unavailable; result needs reconciliation";
		}
		if (path && ["codex", "claude-code"].includes(executor!)) {
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
		rmSync(join(dir, "devin.json"), { force: true });
		rmSync(join(dir, "gitconfig"), { force: true });
		process.stderr.write(`Devin transcript retained at ${devinTranscript}\n`);
	} else rmSync(dir, { recursive: true, force: true });
	return exitCode;
}

export async function runLaneProcess(
	args: string[],
	deps: Parameters<typeof runLaneProcessWithReporter>[1] = {},
): Promise<number> {
	const reporter = deps.report ? undefined : createLaneReporter();
	try {
		return await runLaneProcessWithReporter(args, {
			...deps,
			report: deps.report ?? reporter!.report,
		});
	} finally {
		await reporter?.close();
	}
}
