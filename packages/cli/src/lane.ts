import { runLaneProcess, laneRunUsage } from "./lane-run";
import { createHash } from "node:crypto";
import { briefRepository } from "@tedix/context-core/situational-recall";
import { repoSlug } from "./hooks/prompt-context";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCurrentWorkspace } from "./credential-store";
import { selfCommand } from "./shared";
import { cliRead } from "./hooks/hook-io";
import { recallForSituation } from "./hooks/situational-recall";

export async function prefixLaneBrief(
	brief: string,
	scope: string[],
	harness: string,
	expectedOrganizationId?: string,
): Promise<{ brief: string; recall: string; recallStatus: string }> {
	try {
		const recall = await recallForSituation(
			{
				env: process.env,
				stdin: "{}",
				cwd: process.cwd(),
				read: cliRead,
				write: () => {},
			},
			{ text: brief },
			{ scope, harness, expectedOrganizationId },
		);
		return {
			brief: recall ? `${recall}\n\n${brief}` : brief,
			recall,
			recallStatus: recall ? "matched" : "none",
		};
	} catch {
		return { brief, recall: "", recallStatus: "unavailable" };
	}
}

export const laneUsage = `${laneRunUsage}

tedix lane start "<title>" --project <id> [--work-item <id>]
tedix lane brief <brief-file> [--host codex|claude]  # enriched brief for launchers
tedix lane done|fail "<note>" [--commit <sha> ...] [--needs-user "<next click>"] [--request-id <ledger-id>]

Run inside the lane's own Codex/Claude session after tedix agent start.
Uses normal Work admission and a session-scoped pointer; never inherits a launcher's
Attempt. --work-item attaches an existing accepted item. Report liveness with
lane heartbeat while working; capture-stop also reports it. Tedix detects stale
and expired lanes on its server tick, independently of this local session.
Workspace and organization must stay the same on start and settlement.`;

export function laneSession(env: NodeJS.ProcessEnv): string {
	if (env.TEDIX_AGENT_SESSION) return env.TEDIX_AGENT_SESSION;
	// A Codex child can inherit the launcher's Claude id.
	if (env.CODEX_THREAD_ID) return `codex:${env.CODEX_THREAD_ID}`;
	if (env.CLAUDE_CODE_SESSION_ID)
		return `claude-code:${env.CLAUDE_CODE_SESSION_ID}`;
	throw new Error(
		"lane needs its own host session id; set TEDIX_AGENT_SESSION",
	);
}

type Lane = {
	id: string;
	scope: string[];
	session: string;
	phase?: "created" | "accepted" | "running" | "settled";
	result?: Record<string, unknown>;
	projectId?: string;
	attemptId?: string;
	repo?: string;
};
function lanePath(session: string, scope: string[], env: NodeJS.ProcessEnv) {
	const dir = join(env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"), "lanes");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return join(
		dir,
		`${createHash("sha256")
			.update(JSON.stringify([session, scope]))
			.digest("hex")}.json`,
	);
}
function command(args: string[], env: NodeJS.ProcessEnv) {
	const [executable, prefix] = selfCommand();
	return spawnSync(executable, [...prefix, ...args], {
		env,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 4_194_304,
	});
}
function work(args: string[], lane: Pick<Lane, "scope" | "session">) {
	const result = command([...lane.scope, "work", ...args, "--json"], {
		...process.env,
		TEDIX_AGENT_SESSION: lane.session,
	});
	if (result.status !== 0)
		throw new Error(result.stderr || result.stdout || "Work command failed");
	return JSON.parse(result.stdout) as Record<string, unknown>;
}

export async function runLane(args: string[]): Promise<number> {
	let verbIndex = 0;
	while (
		["-w", "--workspace", "--organization"].includes(args[verbIndex] ?? "")
	)
		verbIndex += 2;
	if (
		["run", "import", "report"].includes(args[verbIndex] ?? "") &&
		!args
			.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"))
			.includes("--help")
	)
		return runLaneProcess([
			args[verbIndex]!,
			...args.slice(0, verbIndex),
			...args.slice(verbIndex + 1),
		]);
	if (!args.length || args.includes("--help")) {
		console.log(laneUsage);
		return 0;
	}
	const positional: string[] = [],
		scope: string[] = [],
		commits: string[] = [];
	let project: string | undefined,
		existing: string | undefined,
		briefFile: string | undefined,
		host: string | undefined;
	let needsUser: string | undefined, requestId: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (
			[
				"-w",
				"--workspace",
				"--organization",
				"--project",
				"--work-item",
				"--commit",
				"--needs-user",
				"--request-id",
				"--brief-file",
				"--host",
			].includes(arg)
		) {
			const value = args[++i];
			if (!value || value.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			if (arg === "--project") project = value;
			else if (arg === "--work-item") existing = value;
			else if (arg === "--commit") commits.push(value);
			else if (arg === "--needs-user") {
				needsUser = value.trim();
				if (!needsUser)
					throw new Error("--needs-user needs an exact next click");
			} else if (arg === "--request-id") requestId = value;
			else if (arg === "--brief-file") briefFile = value;
			else if (arg === "--host") host = value;
			else scope.push(arg === "-w" ? "--workspace" : arg, value);
		} else if (arg.startsWith("--"))
			throw new Error(`Unknown lane option ${arg}`);
		else positional.push(arg);
	}
	const session = laneSession(process.env);
	// Include environment selectors in the pointer fence, including calls from hooks.
	if (!scope.includes("--workspace")) {
		const workspace = process.env.TEDIX_WORKSPACE || getCurrentWorkspace();
		if (!workspace) throw new Error("Select a workspace with --workspace");
		scope.push("--workspace", workspace);
	}
	if (!scope.includes("--organization") && process.env.TEDIX_ORGANIZATION)
		scope.push("--organization", process.env.TEDIX_ORGANIZATION);
	const selectors = new Map<string, string>();
	for (let i = 0; i < scope.length; i += 2)
		selectors.set(scope[i]!, scope[i + 1]!);
	scope.splice(
		0,
		scope.length,
		...[...selectors].sort(([a], [b]) => a.localeCompare(b)).flat(),
	);
	if (positional[0] === "brief") {
		const file = positional[1];
		if (!file || positional.length !== 2)
			throw new Error("lane brief requires one brief file");
		const brief = readFileSync(file, "utf8");
		if (brief.length > 1_048_576) throw new Error("Lane brief exceeds 1 MB");
		const result = await prefixLaneBrief(
			brief,
			scope,
			host === "claude" ? "claude-code" : "codex",
		);
		console.log(result.brief);
		return 0;
	}
	const path = lanePath(session, scope, process.env);
	let lane: Lane | undefined;
	try {
		lane = JSON.parse(readFileSync(path, "utf8")) as Lane;
	} catch {}
	const [verb, ...words] = positional;
	const brief = briefFile ? readFileSync(briefFile, "utf8") : words.join(" ");
	if (brief.length > 1_048_576) throw new Error("Lane brief exceeds 1 MB");
	const recalled =
		verb === "start"
			? await prefixLaneBrief(
					brief,
					scope,
					session.startsWith("codex:") ? "codex" : "claude-code",
				)
			: undefined;
	const note =
		words.join(" ").trim() || (needsUser ? "Lane result ready." : "");
	if (verb === "start") {
		if (!note || !project)
			throw new Error("lane start requires a title and --project");
		if (lane) {
			if (!lane.id)
				throw new Error(
					"Another lane start is unfinished; inspect the session's Work before retrying",
				);
			if (!lane.phase || lane.phase === "running") {
				work(["heartbeat", lane.id], lane);
				console.log(JSON.stringify({ ...lane, ...recalled }));
				return 0;
			}
			if (lane.phase === "settled")
				throw new Error("Finish lane done before starting another lane");
		} else {
			// Keep an ambiguous creation receipt for inspection rather than duplicate it.
			writeFileSync(path, JSON.stringify({ starting: true }), {
				flag: "wx",
				mode: 0o600,
			});
			const target = { scope, session };
			const id =
				existing ||
				String(
					work(
						["create", note, "--kind", "coding", "--project", project],
						target,
					).id,
				);
			lane = { id, scope, session, phase: existing ? "accepted" : "created" };
			writeFileSync(path, JSON.stringify(lane), { mode: 0o600 });
		}
		const context = work(["context", lane.id], lane);
		if (context.projectId !== project)
			throw new Error("The lane's Work belongs to another project");
		if (lane.phase === "created") {
			if (context.disposition === "proposed")
				work(["accept", lane.id, "--done-when", note], lane);
			lane.phase = "accepted";
			writeFileSync(path, JSON.stringify(lane), { mode: 0o600 });
		}
		const started = work(["start", lane.id, "--lane"], lane);
		lane.projectId = project;
		lane.attemptId = String(
			(started.attempt as Record<string, unknown> | undefined)?.id ?? lane.id,
		);
		lane.repo =
			repoSlug(
				spawnSync("git", ["config", "--get", "remote.origin.url"], {
					encoding: "utf8",
					timeout: 1000,
				}).stdout,
			) ?? briefRepository(brief);
		lane.phase = "running";
		writeFileSync(path, JSON.stringify(lane), { mode: 0o600 });
		console.log(JSON.stringify({ ...lane, ...recalled }));
	} else if (verb === "done" || verb === "fail") {
		if (!lane?.id || !note)
			throw new Error("lane settlement needs a registered lane and note");
		if (lane.phase !== "settled") {
			lane.result = work(
				[
					"settle",
					lane.id,
					"--outcome",
					verb === "done" ? "succeeded" : "failed",
					"--note",
					note,
					...commits.flatMap((sha) => ["--commit", sha]),
					...(needsUser ? ["--needs-user", needsUser] : []),
					...(requestId ? ["--request-id", requestId] : []),
				],
				lane,
			);
			lane.phase = "settled";
			writeFileSync(path, JSON.stringify(lane), { mode: 0o600 });
		}
		if (verb === "fail" && lane.projectId) {
			const input = {
				eventId: `${lane.attemptId ?? lane.id}:fail`,
				reason: note,
				occurredAt: new Date().toISOString(),
				projectId: lane.projectId,
				repo: lane.repo,
				actor: {
					sessionId: lane.session,
					harness: lane.session.split(":")[0],
					hookTrust: "unknown",
					dispatchPath: "tedix lane start",
					delivery: "unknown",
				},
			};
			const result = command(
				[
					...lane.scope,
					"code",
					`async () => await agent.record_lesson_incident(${JSON.stringify(input)})`,
				],
				{ ...process.env, TEDIX_AGENT_SESSION: lane.session },
			);
			if (result.status !== 0)
				console.error(
					"Incident recall unavailable; lane failure is still settled.",
				);
		}
		unlinkSync(path);
		console.log(
			JSON.stringify({ id: lane.id, outcome: verb, result: lane.result }),
		);
	} else if (verb === "heartbeat") {
		if (lane?.id) work(["heartbeat", lane.id], lane);
	} else throw new Error(laneUsage);
	return 0;
}

/** Only a lane explicitly registered by this host session is heartbeated. */
export function heartbeatLaneSession(
	session: string,
	env: NodeJS.ProcessEnv,
): void {
	const dir = join(env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"), "lanes");
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return;
	}
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const lane = JSON.parse(readFileSync(join(dir, file), "utf8")) as Lane;
			if (lane.session === session && lane.id)
				work(["heartbeat", lane.id], lane);
		} catch {
			/* A hook cannot revive an expired or replaced Attempt. */
		}
	}
}
