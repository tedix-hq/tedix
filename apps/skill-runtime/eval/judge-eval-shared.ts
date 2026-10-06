/**
 * Shared plumbing for the judge calibration harnesses.
 *
 * One copy of: the gold-set loader, the live `run_tedi_turn` judge transport
 * (with the production blind-session prefix), the reply parser, and the scorer.
 * `run-judge-eval.ts` (single judge), `run-judge-vote-eval.ts` (self-consistency
 * voting), and `run-judge-workersai-eval.ts` (Workers AI stage-2 candidates) all
 * import from here so they measure the same contract with the same ruler.
 *
 * Gold labels come from a human reading the passage. Never regenerate them with
 * a model — that measures agreement with a model, not correctness.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVIDENCE_JUDGE_SESSION_PREFIX } from "@tedix/api-contract/utils/runtime-identity";
import {
	buildJudgePrompt,
	type EntailmentJudgeItem,
	type EntailmentVerdict,
	type EvidenceStatus,
} from "../src/evidence-core";
import type { GoldItem } from "./judge-gold-types";
export type { GoldItem } from "./judge-gold-types";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(EVAL_DIR, "../../..");
export const GOLD_PATH = path.join(EVAL_DIR, "judge-gold.json");

export interface JudgeModelIdentity {
	provider: string;
	model: string;
}

export interface JudgeMcpExchange {
	verdicts: Record<string, EntailmentVerdict>;
	modelIdentity: JudgeModelIdentity | null;
}

export function loadGold(): GoldItem[] {
	return JSON.parse(fs.readFileSync(GOLD_PATH, "utf8")) as GoldItem[];
}

/**
 * Parse a judge reply into verdicts keyed by item id. Tolerates markdown fences
 * and leading/trailing prose — the same salvage the single-judge harness has
 * always applied. Unparseable replies return `{}` (a missing verdict, recovered
 * or under-counted by the ladder — never guessed).
 */
export function parseVerdictReply(
	reply: string,
): Record<string, EntailmentVerdict> {
	let text = reply.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
	if (fenced?.[1]) text = fenced[1];
	const open = text.indexOf("{");
	const close = text.lastIndexOf("}");
	if (open >= 0 && close > open) text = text.slice(open, close + 1);
	try {
		const parsed = JSON.parse(text) as { verdicts?: EntailmentVerdict[] };
		const out: Record<string, EntailmentVerdict> = {};
		for (const v of parsed.verdicts ?? []) {
			if (v && typeof v.id === "string") out[v.id] = v;
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Ask one tedi to judge a batch, via the same `run_tedi_turn` path production
 * uses. The session key must carry the production blind-verification prefix so
 * the judge runs exactly as it runs in production: no cognitive addenda, no
 * memory writes. `tag` individuates the turn — distinct tags mean distinct
 * session keys AND distinct client_request_ids, which is what makes two calls
 * independent samples rather than one idempotent call replayed.
 */
export function askJudgeViaMcp(
	tedi: string,
	items: EntailmentJudgeItem[],
	tag: string,
): JudgeMcpExchange {
	if (!/^[a-z][a-z0-9_]*$/.test(tedi)) {
		throw new Error(`Invalid tedi namespace: ${tedi}`);
	}
	const workspace = process.env.TEDIX_WORKSPACE?.trim();
	if (!workspace)
		throw new Error("Set TEDIX_WORKSPACE to the evaluation workspace.");
	const prompt = buildJudgePrompt(items);
	const b64 = Buffer.from(prompt, "utf8").toString("base64");
	const sessionKey = `${EVIDENCE_JUDGE_SESSION_PREFIX}eval:${tag}`;
	const js = `async () => { const dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0))); const r = await ${tedi}.run_tedi_turn({ session_key: ${JSON.stringify(sessionKey)}, text: dec("${b64}"), client_request_id: ${JSON.stringify(`eval-judge:${tag}`)} }); const outer = r || {}; const inner = outer.result || {}; const assistant = outer.assistant || inner.assistant || null; const task = outer.task || inner.task || null; const runId = outer.run_id || inner.run_id || (task && String(task.id || "").split(":").slice(2).join(":")) || null; const pending = Boolean(outer.pending || inner.pending || (!assistant && task)); let failure = outer.error || inner.error || null; if (pending && runId) { const tediId = String(runId).split(":")[0]; const eventResult = await cognitive.list_cognitive_runtime_events({ tediId, runId: String(runId), limit: 20 }); const events = (eventResult && (eventResult.items || eventResult.events)) || eventResult || []; const failed = Array.isArray(events) && events.find((event) => event && event.kind === "run.failed"); failure = failure || (failed && String((failed.data && failed.data.error) || (failed.payload && failed.payload.error) || failed.error || failed.message || "judge run failed")); } const t = String((assistant && assistant.content) || outer.text || inner.text || outer.reply || inner.reply || ""); const bytes = new TextEncoder().encode(t); let s = ""; for (const x of bytes) s += String.fromCharCode(x); return { reply: btoa(s), modelIdentity: outer.model_identity || inner.model_identity || null, pending, failure }; }`;
	type JudgeWire = {
		reply?: unknown;
		modelIdentity?: unknown;
		pending?: unknown;
		failure?: unknown;
	};
	const deadline = Date.now() + 240_000;
	let wire: JudgeWire;
	while (true) {
		try {
			const line = execFileSync(
				"tedix",
				["code", js, "-w", workspace, "--json"],
				{
					cwd: REPO,
					encoding: "utf8",
					timeout: 90_000,
				},
			).trim();
			wire = JSON.parse(line) as JudgeWire;
		} catch (error) {
			throw new Error(`Judge MCP call failed for ${tag}`, { cause: error });
		}
		if (typeof wire.failure === "string" && wire.failure) {
			throw new Error(`Judge run failed for ${tag}: ${wire.failure}`);
		}
		if (!wire.pending) break;
		if (Date.now() >= deadline) {
			throw new Error(`Judge run remained pending for ${tag}`);
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
	}
	let reply: string;
	try {
		reply = Buffer.from(String(wire.reply ?? ""), "base64").toString("utf8");
	} catch {
		return { verdicts: {}, modelIdentity: null };
	}
	const identity = wire.modelIdentity as
		| { provider?: unknown; model?: unknown }
		| null
		| undefined;
	const modelIdentity =
		typeof identity?.provider === "string" &&
		typeof identity?.model === "string"
			? { provider: identity.provider, model: identity.model }
			: null;
	return { verdicts: parseVerdictReply(reply), modelIdentity };
}

/** The minimum a scorer needs: what the judge SAID and what production would DO. */
export interface ScorableVerdict {
	/** The judge's raw label, lowercased — what it said, before the span check. */
	label: string;
	/** The post-span-check status — what `verify()` would have recorded. */
	status: EvidenceStatus;
}

export interface Score {
	resolved: number;
	labelCorrect: number;
	labelAccuracy: number;
	/** What production would do — the judge's label after the span check. */
	grantedAttributable: number;
	falseAttributable: number;
	missedAttributable: number;
	spanRejected: number;
	confusion: Record<string, number>;
}

export function scoreVerdicts(
	gold: GoldItem[],
	verdicts: Map<string, ScorableVerdict>,
): Score {
	const confusion: Record<string, number> = {};
	let resolved = 0;
	let labelCorrect = 0;
	let granted = 0;
	let falseGrant = 0;
	let missed = 0;
	let spanRejected = 0;

	for (const item of gold) {
		const verdict = verdicts.get(item.id);
		if (!verdict) continue;
		resolved++;

		// The ladder already applied the span check: an `attributable` label whose
		// span is not in the passage never becomes an attributable STATUS.
		const effective = verdict.status;
		const rawLabel = String(verdict.label ?? "").toLowerCase();

		if (rawLabel === "attributable" && effective !== "attributable") {
			spanRejected++;
		}
		if (rawLabel === item.goldLabel) labelCorrect++;

		const key = `${item.goldLabel} -> ${effective}`;
		confusion[key] = (confusion[key] ?? 0) + 1;

		if (effective === "attributable") {
			granted++;
			if (item.goldLabel !== "attributable") falseGrant++;
		} else if (item.goldLabel === "attributable") {
			missed++;
		}
	}

	return {
		resolved,
		labelCorrect,
		labelAccuracy: resolved ? +(labelCorrect / resolved).toFixed(3) : 0,
		grantedAttributable: granted,
		falseAttributable: falseGrant,
		missedAttributable: missed,
		spanRejected,
		confusion,
	};
}
