import {
	type SessionFacts,
	type TranscriptFile,
	codexFacts,
	claudeFacts,
	foldSubagents,
} from "./learn-facts";
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { codexGoals, codexThreadNames } from "./learn-context";
import type { SessionSummary } from "./learn-profile-digest";
import type { WorkstreamIdentity } from "./learn-profile-workstreams";

// ---------------------------------------------------------------------------
// 1. Facts, cached by file size and time
// ---------------------------------------------------------------------------

export interface ProfileState {
	version: 1;
	facts: Record<string, { sig: string; facts: SessionFacts | null }>;
	summaries: Record<string, { hash: string; summary: SessionSummary }>;
	workstreams?: Record<string, WorkstreamIdentity>;
	space?: { organization: string; workspaceId: string; outputId?: string };
}

export function readProfileState(path: string): ProfileState {
	try {
		const state = JSON.parse(readFileSync(path, "utf8"));
		if (state?.version === 1) return state;
	} catch {
		/* First run. */
	}
	return { version: 1, facts: {}, summaries: {} };
}

export function writeProfileState(path: string, state: ProfileState) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
	renameSync(temp, path);
}

export async function readAllFacts(
	files: TranscriptFile[],
	state: ProfileState,
	home = homedir(),
): Promise<SessionFacts[]> {
	const goals = await codexGoals(home);
	const names = codexThreadNames(home);
	const out: SessionFacts[] = [];
	const live = new Set<string>();
	for (const file of files) {
		live.add(file.path);
		const sig = `${file.bytes}:${Math.round(file.mtimeMs)}`;
		const hit = state.facts[file.path];
		let facts: SessionFacts | null;
		if (hit && hit.sig === sig) facts = hit.facts;
		else {
			try {
				facts =
					file.harness === "codex"
						? await codexFacts(file, undefined, goals, names)
						: await claudeFacts(file);
			} catch {
				facts = null;
			}
			state.facts[file.path] = { sig, facts };
		}
		if (facts) out.push(facts);
	}
	for (const path of Object.keys(state.facts))
		if (!live.has(path)) delete state.facts[path];
	// A forked Codex rollout repeats its root session: keep the fullest copy.
	const byKey = new Map<string, SessionFacts>();
	for (const f of out) {
		const prior = byKey.get(f.key);
		if (!prior || f.toolCalls + f.askCount > prior.toolCalls + prior.askCount)
			byKey.set(f.key, structuredClone(f));
	}
	return foldSubagents([...byKey.values()]);
}
