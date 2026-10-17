import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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

export const laneUsage = `tedix lane start "<title>" --project <id> [--work-item <id>]
tedix lane done|fail "<note>" [--commit <sha> ...]

Run inside the lane's own Codex/Claude session after tedix agent start.
Uses normal Work admission and a session-scoped pointer; never inherits a Lead's
Attempt. --work-item attaches an existing accepted item. A detached heartbeat
renews the same Attempt for at most one hour; capture-stop also heartbeats it.
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
	if (!args.length || args.includes("--help")) {
		console.log(laneUsage);
		return 0;
	}
	const positional: string[] = [],
		scope: string[] = [],
		commits: string[] = [];
	let project: string | undefined, existing: string | undefined;
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
			].includes(arg)
		) {
			const value = args[++i];
			if (!value || value.startsWith("--"))
				throw new Error(`${arg} needs a value`);
			if (arg === "--project") project = value;
			else if (arg === "--work-item") existing = value;
			else if (arg === "--commit") commits.push(value);
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
	const path = lanePath(session, scope, process.env);
	let lane: Lane | undefined;
	try {
		lane = JSON.parse(readFileSync(path, "utf8")) as Lane;
	} catch {}
	const [verb, ...words] = positional;
	const note = words.join(" ").trim();
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
				console.log(JSON.stringify(lane));
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
		work(["start", lane.id], lane);
		lane.phase = "running";
		writeFileSync(path, JSON.stringify(lane), { mode: 0o600 });
		const [executable, prefix] = selfCommand();
		const child = spawn(
			executable,
			[
				...prefix,
				...scope,
				"work",
				"heartbeat",
				lane.id,
				"--watch",
				"3600",
				"--json",
			],
			{
				env: { ...process.env, TEDIX_AGENT_SESSION: session },
				detached: true,
				stdio: "ignore",
			},
		);
		child.unref();
		console.log(JSON.stringify(lane));
	} else if (verb === "done" || verb === "fail") {
		if (!lane?.id || !note)
			throw new Error("lane settlement needs a registered lane and note");
		if (lane.phase !== "settled") {
			work(
				[
					"settle",
					lane.id,
					"--outcome",
					verb === "done" ? "succeeded" : "failed",
					"--note",
					note,
					...commits.flatMap((sha) => ["--commit", sha]),
				],
				lane,
			);
			lane.phase = "settled";
			writeFileSync(path, JSON.stringify(lane), { mode: 0o600 });
		}
		if (verb === "done") work(["complete", lane.id], lane);
		unlinkSync(path);
		console.log(JSON.stringify({ id: lane.id, outcome: verb }));
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
