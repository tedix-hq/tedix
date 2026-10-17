import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdtempSync,
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
import { selfCommand } from "./shared";
import { AGENT_IDENTITY_ENV } from "./hooks/hook-io";
import { parseLaneTranscript, type LaneObservation } from "./lane-telemetry";

export const laneRunUsage = `tedix lane run --executor codex|claude-code|tedi|skill --brief <file> --project <id>
  [--model <id>] [--reasoning <effort>] [--rate-scope <scope>] [--work-item <id>]
  [--transcript <file>] [--telemetry <file>] -- <command> [args...]
tedix lane import --executor codex|claude-code --transcript <file> --project <id> [--apply]

Registers observations using the owner's selected organization. A report grants no
Work execution authority: the child still obtains its own Attempt with lane start.
Codex exec uses its JSON thread receipt to select its exact rollout, even with concurrent lanes.
Claude hooks report to the wrapper's lane id. Other executors write the common telemetry
JSON to TEDIX_LANE_TELEMETRY_PATH. Missing facts remain unknown. Import previews by default. Retry a saved observation with lane report --input-file <receipt>.`;

export async function reportLaneObservation(
	input: Record<string, unknown>,
	scope: string[],
) {
	const [command, prefix] = selfCommand();
	const env = { ...process.env };
	for (const key of AGENT_IDENTITY_ENV) delete env[key];
	const child = spawn(
		command,
		[
			...prefix,
			...scope,
			"work",
			"agent-session-report",
			"--input",
			JSON.stringify(input),
			"--json",
		],
		{ env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
	try {
		const status = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		if (status !== 0) throw new Error(stderr || stdout || "Lane report failed");
		return JSON.parse(stdout);
	} finally {
		clearTimeout(timer);
	}
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

export async function runLaneProcess(
	args: string[],
	deps: {
		report?: typeof reportLaneObservation;
		heartbeatMs?: number;
		sessionKey?: string;
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
		else options.set(key, value);
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
	if (!["codex", "claude-code", "tedi", "skill"].includes(executor ?? ""))
		throw new Error("Choose --executor codex|claude-code|tedi|skill");
	const projectId = options.get("--project");
	if (!projectId) throw new Error("--project is required");
	const sessionKey = deps.sessionKey ?? randomUUID();
	const startedAt = new Date().toISOString();
	let telemetry: LaneObservation = {
		executor: executor as LaneObservation["executor"],
		model: options.get("--model") ?? null,
		provider:
			executor === "codex"
				? "openai"
				: executor === "claude-code"
					? "anthropic"
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
		label: observed.brief.replace(/\s+/g, " ").slice(0, 120),
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
	if (!command.length || !options.has("--brief")) throw new Error(laneRunUsage);
	LaneTelemetryInputSchema.parse(telemetry);
	await report(sessionKey, telemetry);
	const dir = mkdtempSync(join(tmpdir(), "tedix-lane-"));
	const receipt = join(dir, "telemetry.json");
	const env = {
		...process.env,
		TEDIX_WORKSPACE: deps.childScope?.workspace ?? process.env.TEDIX_WORKSPACE,
		TEDIX_ORGANIZATION:
			deps.childScope?.organization ?? process.env.TEDIX_ORGANIZATION,
		TEDIX_LANE_ID: sessionKey,
		TEDIX_LANE_TELEMETRY_PATH: receipt,
		TEDIX_LANE_RATE_SCOPE: telemetry.rateScope ?? "",
	};
	// A child must never act under its launcher's session identity or Attempt cache.
	for (const key of [
		"CODEX_THREAD_ID",
		"CODEX_SESSION_ID",
		"CLAUDE_CODE_SESSION_ID",
		...AGENT_IDENTITY_ENV,
	])
		delete env[key as keyof typeof env];
	let nativeId: string | undefined,
		identityMismatch = false,
		buffer = "";
	const codexJson =
		executor === "codex" &&
		basename(command[0]!) === "codex" &&
		command[1] === "exec";
	if (codexJson && !command.includes("--json")) command.splice(2, 0, "--json");
	const child = spawn(command[0]!, command.slice(1), {
		env,
		detached: deps.detachedChild,
		stdio: ["pipe", codexJson ? "pipe" : "inherit", "inherit"],
	});
	if (child.pid) deps.onSpawn?.(child.pid);
	child.stdin?.end(readFileSync(options.get("--brief")!));
	child.stdout?.on("data", (chunk) => {
		process.stdout.write(chunk);
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop()!.slice(-65536);
		for (const line of lines) {
			try {
				const event = JSON.parse(line);
				if (event.type === "thread.started") {
					nativeId = event.thread_id;
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
	}, deps.heartbeatMs ?? 30_000);
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
				child.once("exit", (code, sig) => resolve([code ?? 1, sig]));
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
		(deps.sessionKey && codexJson && nativeId !== deps.sessionKey)
	)
		exitCode = 1;
	try {
		const path =
			options.get("--transcript") ??
			(nativeId ? codexTranscript(nativeId) : undefined);
		if (path && ["codex", "claude-code"].includes(executor!)) {
			const parsed = await parseLaneTranscript(
				path,
				executor as "codex" | "claude-code",
			);
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
		process.stderr.write(`Lane transcript: ${String(error)}\n`);
	}
	await heartbeat;
	telemetry = {
		...telemetry,
		finishedAt: new Date().toISOString(),
		heartbeatAt: new Date().toISOString(),
		outcome: signal ? "stopped" : exitCode === 0 ? "succeeded" : "failed",
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
	rmSync(dir, { recursive: true, force: true });
	return exitCode;
}
