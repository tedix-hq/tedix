/**
 * Proposals from `tedix learn` as Work interactions: each one is a `handoff`
 * addressed to the member, so it waits in their Tedix inbox beside every other
 * request and can be answered in Tedix OS, in chat or with `tedix learn
 * review`. Accepting it makes the server create the proposed Work (see
 * `WORK_PROPOSAL_SCHEMA`); declining it is the remembered rejection. The
 * server-side list is the only record, so a re-run on any machine sees what
 * was already asked.
 */
import { WORK_PROPOSAL_SCHEMA } from "@tedix/api-contract/schemas/work-interactions";
import { asciiJson } from "./hooks/agent-status";
import type { Proposal } from "./learn-context";

type Json = Record<string, any>;

/** A session a proposal came from, as the member's host named it. */
export interface Citation {
	harness: string;
	session: string;
	title: string | null;
	at: string;
}

/** A proposal already in the member's inbox, in any state. */
export interface AskedProposal {
	id: string;
	version: number;
	state: string;
	key: string;
	title: string;
	subject: string;
	prompt: string;
}

export function intentId(userId: string | null, key: string): string {
	return `learn-context:${userId ?? "anonymous"}:${key}`;
}

function sessionsLine(p: Proposal): string {
	return `${p.sessions} session${p.sessions === 1 ? "" : "s"} between ${p.from} and ${p.to}`;
}

/** The Work Item description: where the proposal came from. */
export function proposalDescription(proposal: Proposal, who: string): string {
	return [
		`Proposed from ${who}'s local agent sessions by tedix learn: ${sessionsLine(proposal)} (${proposal.kind}, confidence ${proposal.confidence.toFixed(2)}).`,
		proposal.nearest
			? `Closest existing item when proposed: ${proposal.nearest.title} (${proposal.nearest.id.slice(0, 8)}, similarity ${proposal.nearest.score}).`
			: "No similar existing item when proposed.",
		"Only a short paraphrase left the machine; no transcript was uploaded.",
	].join("\n\n");
}

function citationLines(citations: Citation[] | undefined): string[] {
	return (citations ?? [])
		.slice(0, 8)
		.map(
			(c) =>
				`- ${c.at.slice(0, 10)} ${c.harness} session ${c.session.slice(0, 8)}${c.title ? `: ${c.title}` : ""}`,
		);
}

/** The inbox request a member reads: what, where, why, and the evidence. */
export function proposalRequest(
	p: Proposal,
	who: string,
	userId: string,
): Json {
	const children = p.children ?? [];
	const where = p.projectKey
		? `project ${p.projectKey}`
		: "no project (none on the board fits)";
	const subject = (
		children.length
			? `New epic for the board: ${p.title} (${children.length} tasks)`
			: `Add to the board: ${p.title}`
	).slice(0, 300);
	const prompt = [
		children.length
			? `Your agent sessions show a body of work the board has no project or epic for. Accept to create it as one epic in ${where}, with its tasks under it:`
			: `Your agent sessions show work the board does not have yet. Accept to create it in ${where}${p.parentTitle ? `, under "${p.parentTitle}"` : ""}.`,
		...(children.length ? children.map((c) => `- ${c.title}`) : []),
		`Why: ${p.reason}. Seen in ${sessionsLine(p)}.`,
		p.nearest
			? `Closest item already on the board: "${p.nearest.title}" (${p.nearest.id.slice(0, 8)}, similarity ${p.nearest.score}); it was checked and is not the same work.`
			: "Nothing similar is on the board.",
		...(p.citations?.length
			? ["Sessions it came from:", ...citationLines(p.citations)]
			: []),
		"Decline and it is never proposed again.",
	].join("\n");
	const item = (q: Pick<Proposal, "key" | "title">, description: string) => ({
		title: q.title.slice(0, 300),
		description,
		sourceIntentId: intentId(userId, q.key),
	});
	return {
		...(p.projectId ? { projectId: p.projectId } : {}),
		kind: "handoff",
		subject,
		prompt: prompt.slice(0, 20_000),
		requestedFrom: { type: "user", id: userId },
		metadata: {
			schema: WORK_PROPOSAL_SCHEMA,
			source: "tedix learn",
			proposal: {
				key: p.key,
				...(p.projectId ? { projectId: p.projectId } : {}),
				...(p.parentId ? { parentWorkItemId: p.parentId } : {}),
				item: item(p, proposalDescription(p, who)),
				children: children.map((c) => item(c, proposalDescription(c, who))),
			},
			evidence: {
				sessions: p.sessions,
				from: p.from,
				to: p.to,
				confidence: p.confidence,
				citations: (p.citations ?? []).slice(0, 8).map((c) => ({ ...c })),
				...(p.nearest ? { nearest: { ...p.nearest } } : {}),
			},
		},
	};
}

/**
 * Code Mode program: the member's own work proposals, newest first (open
 * only, or every state). Reads only.
 */
export function listProposalsSource(openOnly: boolean): string {
	return `async () => {
	const SCHEMA = ${JSON.stringify(WORK_PROPOSAL_SCHEMA)};
	let me = null;
	try { const p = await user.get_mine({}); if (p && p.id) me = { id: p.id, name: String(p.name || "") }; } catch {}
	const rows = [];
	let cursor;
	for (let page = 0; page < 30; page++) {
		const r = await work.list_work_interactions({ kinds: ["handoff"], ${openOnly ? 'states: ["open"], ' : ""}limit: 100, ...(cursor ? { cursor } : {}) });
		if (r?.ok === false || !Array.isArray(r?.data)) return { ok: false, error: "listing your inbox failed: " + String(r?.error ?? "no data") };
		for (const row of r.data) {
			const q = row.request || {};
			const m = q.metadata || {};
			if (m.schema !== SCHEMA || !m.proposal || !row.canRespond && row.effectiveState === "open") continue;
			rows.push({ id: q.id, version: q.version, state: row.effectiveState, key: String(m.proposal.key || ""), title: String(m.proposal.item?.title || q.subject || ""), subject: String(q.subject || ""), prompt: String(q.prompt || "").slice(0, 1500) });
		}
		if (!r.hasMore || !r.nextCursor) break;
		cursor = r.nextCursor;
	}
	return { me, rows };
}`;
}

/**
 * Code Mode program: put each proposal in the member's inbox. A proposal
 * with no project is anchored to the shared session-analysis item, the one
 * place on the board that is about these sessions; without it, it is skipped.
 */
export function publishSource(requests: Array<{ key: string; request: Json }>) {
	return `async () => {
	const input = ${asciiJson(requests)};
	const out = {};
	let anchor;
	const anchorId = async () => {
		if (anchor !== undefined) return anchor;
		anchor = null;
		const page = await work.list_work_items({ titleContains: "Session analysis", limit: 100 });
		if (page?.ok !== false && Array.isArray(page?.data)) {
			const row = page.data.find((r) => r.sourceIntentId === "session-analysis:repeated-requests:v1" && r.disposition !== "cancelled");
			anchor = row ? row.id : null;
		}
		return anchor;
	};
	for (const { key, request } of input) {
		const context = request.projectId ? {} : { workItemId: await anchorId() };
		if (!request.projectId && !context.workItemId) { out[key] = { skipped: "no project fits and there is no session-analysis item to file it beside" }; continue; }
		const made = await work.create_work_interaction({ ...request, ...context });
		if (made?.ok === false || !made?.id) { out[key] = { error: String(made?.error ?? "creating the inbox item failed") }; continue; }
		out[key] = { id: made.id };
	}
	return out;
}`;
}

/** Code Mode program: accept or decline proposals as the member. */
export function respondSource(
	answers: Array<{ id: string; version: number; accept: boolean }>,
): string {
	return `async () => {
	const input = ${asciiJson(answers)};
	const out = {};
	for (const a of input) {
		const r = await work.respond_work_interaction({ requestId: a.id, expectedRequestVersion: a.version, responseKind: a.accept ? "handoff_accepted" : "handoff_declined", body: a.accept ? "Accepted with tedix learn review." : "Declined with tedix learn review.", resolvesRequest: true, metadata: { source: "tedix learn review" } });
		if (r?.ok === false || !r?.response) { out[a.id] = { error: String(r?.error ?? "answering failed") }; continue; }
		out[a.id] = { workItemIds: Array.isArray(r.response.metadata?.workItemIds) ? r.response.metadata.workItemIds : [] };
	}
	return out;
}`;
}
