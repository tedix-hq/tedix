import type { SessionFacts } from "./learn-facts";
import { words } from "./learn-context-candidates";
import { asciiJson } from "./hooks/agent-status";
import { type PersonProfile, usageStats } from "./learn-profile-insights";
import { day, type SessionSummary, publicText } from "./learn-profile-digest";
import {
	type Workstream,
	workstreamOrder,
	weigh,
} from "./learn-profile-workstreams";
import type { Meter } from "./learn-profile-model";

export const OS_URL = "https://os.tedix.dev";

const DOC_TITLE = "What Tedix knows about you";

const SPACE_MARKER = "tedix learn personal space";

// ---------------------------------------------------------------------------
// 5. Document and proposals
// ---------------------------------------------------------------------------

export type Block =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "list"; ordered?: boolean; items: string[] };

export interface ActionLink {
	title: string;
	why: string;
	kind: PersonProfile["actions"][number]["kind"];
	start: string;
	/** Where to act: an inbox proposal, an existing item, or nothing yet. */
	link: string | null;
	state: "proposed" | "asked" | "on-board" | "not-filed";
	note?: string;
}

const resume = (f: SessionFacts) =>
	f.harness === "codex"
		? `codex resume ${f.sessionId}`
		: `claude --resume ${f.sessionId}`;

function sessionRef(f: SessionFacts): string {
	const commit = f.commits.find((c) => c.sha);
	return `${f.harness === "codex" ? "Codex" : "Claude Code"} session ${f.sessionId.slice(0, 8)} on ${day(f.to)}${f.repository ? ` in ${f.repository}` : ""} (resume: ${resume(f)})${commit && f.repoUrl ? `; last commit ${f.repoUrl}/commit/${commit.sha}` : ""}`;
}

export function renderDocument(input: {
	who: string;
	sessions: SessionFacts[];
	files: number;
	summaries: Map<string, SessionSummary>;
	workstreams: Workstream[];
	profile: PersonProfile;
	actions: ActionLink[];
	model: string;
	meter: Meter;
	seconds: number;
	today: string;
}): Block[] {
	const { profile, workstreams, summaries } = input;
	const stats = usageStats(input.sessions);
	const t = (text: string, limit = 1900) => publicText(text, limit);
	const blocks: Block[] = [];
	const h = (level: number, text: string) =>
		blocks.push({ type: "heading", level, text: t(text, 300) });
	const p = (text: string) =>
		text.trim() && blocks.push({ type: "paragraph", text: t(text, 4000) });
	const list = (items: string[], ordered = false) => {
		const clean = items.map((i) => t(i)).filter(Boolean);
		if (clean.length)
			blocks.push({ type: "list", ordered, items: clean.slice(0, 60) });
	};
	h(1, DOC_TITLE);
	if (profile.week) {
		h(2, "Your week in Tedix");
		p(profile.week);
	}
	if (profile.role) p(profile.role);

	h(2, "3 things I can do for you right now");
	const how = {
		delegate: "I hand it to a tedi",
		factory: "I set up a factory",
		doc: "I draft it",
	} as const;
	list(
		input.actions.map((a) => {
			const where =
				a.state === "proposed" || a.state === "asked"
					? `Accept it in your inbox and I start at once: ${a.link}`
					: a.state === "on-board"
						? `Already on the board: ${a.link}`
						: (a.note ?? "Ask me in chat to start it.");
			const first = a.start
				? ` ${how[a.kind]}: ${a.start.replace(/[.\s]+$/, "")}.`
				: "";
			return `${a.title}. ${a.why}${first} ${where}`;
		}),
		true,
	);

	const open = workstreams
		.filter((w) => w.status !== "done")
		.sort(workstreamOrder);
	h(2, "Your active projects");
	for (const w of open) {
		h(3, w.name);
		p(w.state || w.description);
		const repos = [
			...new Set(w.sessions.map((f) => f.repository).filter(Boolean)),
		].slice(0, 3);
		const facts = [
			`${w.status === "paused" ? "Paused" : "Active"}: worked on ${w.days} day${w.days === 1 ? "" : "s"} between ${day(w.from)} and ${day(w.to)}; ${w.shipped} of ${w.sessions.length} sessions shipped something${repos.length ? `; in ${repos.join(", ")}` : ""}.`,
			w.project
				? `Tedix project ${w.project.key} (${w.project.name}): ${OS_URL}/work/projects/${w.project.id}`
				: w.spread
					? `No board link: its Work is spread over ${w.spread} projects, none clearly its own.`
					: "No board link: none of its sessions named a Tedix project or touched Work in one.",
		];
		for (const item of w.items.slice(0, 3))
			facts.push(
				`Work: ${item.title} (${item.disposition}): ${OS_URL}/work/items/${item.id}`,
			);
		if (w.next) facts.push(`Next: ${w.next}`);
		list(facts);
		if (w.parts.length > 1)
			list(
				w.parts
					.slice(0, 6)
					.map(
						(part) =>
							`${part.name} (${weigh(part.sessions, summaries).days} days, last ${day(part.sessions[0]?.to ?? "")})${part.line ? `: ${part.line}` : ""}`,
					),
			);
	}
	const finished = workstreams
		.filter((w) => w.status === "done")
		.sort(workstreamOrder);
	if (finished.length) {
		h(3, "Finished");
		list(
			finished.map(
				(w) =>
					`${w.name}: ${w.days} day${w.days === 1 ? "" : "s"}, ${day(w.from)} to ${day(w.to)}.${w.state ? ` ${w.state}` : ""}`,
			),
		);
	}

	h(2, "Open loops you left unfinished");
	// Two per workstream at most, taken in turn, so one busy day does not crowd out the rest.
	const queues = open.map((w) =>
		w.openLoops.slice(0, 2).map((loop) => {
			const source =
				w.sessions.find((f) =>
					summaries
						.get(f.key)
						?.openLoops.some((l) =>
							words(l).some((x) => words(loop).includes(x)),
						),
				) ?? w.sessions[0];
			return `${loop} [${w.name}]${source ? ` From ${sessionRef(source)}.` : ""}`;
		}),
	);
	const loops: string[] = [];
	for (let round = 0; round < 2; round++)
		for (const queue of queues) if (queue[round]) loops.push(queue[round]!);
	list(loops.slice(0, 30));
	if (!loops.length) p("None found.");

	h(2, "Workflows Tedix could take over");
	list(
		profile.workflows.map(
			(w) =>
				`${w.name} (${w.kind === "factory" ? "a scheduled factory" : "a skill"}): ${w.proposal} Seen: ${w.evidence}`,
		),
	);

	h(2, "People and customers you work with");
	list(profile.people.map((x) => `${x.name}: ${x.context}`));
	list(profile.orgs.map((x) => `${x.name}: ${x.context}`));

	h(2, "How you like to work");
	list(profile.style);
	const busy = stats.hours
		.map((n, hour) => [hour, n] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([hour]) => `${hour}:00`)
		.sort();
	p(
		`You ran ${stats.byKind.map(([k, v]) => `${v} ${k}`).join(", ")} sessions, delegated to ${stats.subagents} sub-agents, and typed most around ${busy.join(", ")} (this machine's time).`,
	);

	h(2, "Tools you rely on");
	list(profile.tools);
	if (stats.skills) p(`Skills used most: ${stats.skills}.`);
	if (stats.mcp) p(`Tedix and MCP calls used most: ${stats.mcp}.`);
	if (stats.friction.length) {
		h(3, "Where your tools keep failing");
		list(stats.friction.slice(0, 6));
	}

	h(2, "Where this came from");
	p(
		`Built for ${input.who} on ${input.today} from ${stats.sessions} agent sessions on this machine (${stats.byHarness.map(([k, v]) => `${v} ${k}`).join(", ")}; ${stats.subagents} sub-agent runs folded in), ${day(stats.from)} to ${day(stats.to)}: ${stats.asks} things you typed, ${stats.toolCalls} tool calls, ${stats.commits} commits, ${stats.workItems} Tedix Work Items touched. Run tedix learn profile again to refresh it.`,
	);
	p(
		`${input.files} transcript files read in full (sub-agents and supervisor runs included). ${input.sessions.length} sessions summarised by your local model (${input.model}): ${input.meter.calls} model calls, ${input.meter.cached} sessions reused from the last run, about $${input.meter.costUsd.toFixed(2)}, ${Math.round(input.seconds / 60)} minutes in all. Nothing here is shared with your team until you accept a proposal; this document lives in your own space.`,
	);
	return blocks.slice(0, 480);
}

/** Markdown of the same blocks, kept on the machine as a preview. */
export function markdown(blocks: Block[]): string {
	return blocks
		.map((b) =>
			b.type === "heading"
				? `${"#".repeat(b.level)} ${b.text}`
				: b.type === "paragraph"
					? b.text
					: b.items
							.map((item, i) => `${b.ordered ? `${i + 1}.` : "-"} ${item}`)
							.join("\n"),
		)
		.join("\n\n");
}

/** Code Mode program: find or make the member's space and write the document. */
export function publishDocSource(input: {
	workspaceId?: string;
	outputId?: string;
	spaceName: string;
	blocks: Block[];
}): string {
	return `async () => {
	const input = ${asciiJson(input)};
	const me = await user.get_mine({});
	if (!me || !me.id) return { ok: false, error: "could not read who you are" };
	const marker = ${JSON.stringify(SPACE_MARKER)} + " for " + me.id;
	let workspaceId = input.workspaceId;
	let space;
	if (workspaceId) {
		const w = await os.get_os_workspace({ workspaceId });
		space = w && (w.workspace || w);
		if (!w || w.ok === false || !space.id) workspaceId = undefined;
	}
	if (!workspaceId) {
		const list = await os.list_os_workspaces({ status: "active", limit: 200 });
		space = (list.items || []).find((w) => String(w.description || "").includes(marker));
		if (space) workspaceId = space.id;
	}
	if (!workspaceId) {
		const made = await os.create_os_workspace({ name: input.spaceName, visibility: "private", description: "Your own space: what Tedix learned from your agent sessions. Only you can see it. (" + marker + ")" });
		space = made && (made.workspace || made);
		workspaceId = space && space.id;
		if (!workspaceId) return { ok: false, error: "creating your space failed: " + JSON.stringify(made).slice(0, 300) };
	}
	if (space && space.visibility !== "private") {
		// The document names people and customers: it lives where only you can see it.
		const r = await os.update_os_workspace({ workspaceId, visibility: "private" });
		const updated = r && (r.workspace || r);
		if (!updated || updated.visibility !== "private") return { ok: false, error: "making your space private failed: " + JSON.stringify(r).slice(0, 300) };
		if (String(updated.name || "").endsWith("(personal)")) await os.update_os_workspace({ workspaceId, name: input.spaceName }).catch(() => undefined);
	}
	const content = { kind: "document", blocks: input.blocks };
	let outputId = input.outputId;
	if (outputId) {
		const current = await os.get_os_output({ outputId });
		const output = current && (current.output || current);
		if (!output || current.ok === false || !output.id || output.workspaceId && output.workspaceId !== workspaceId) outputId = undefined;
	}
	if (outputId) {
		const r = await os.revise_os_output({ outputId, content });
		if (r && r.ok === false) return { ok: false, error: "updating the document failed: " + String(r.error).slice(0, 300) };
		return { workspaceId, outputId, revised: true };
	}
	const made = await os.create_os_output({ kind: "document", title: ${JSON.stringify(DOC_TITLE)}, workspaceId, content });
	outputId = made && (made.output || made).id;
	if (!outputId) return { ok: false, error: "creating the document failed: " + JSON.stringify(made).slice(0, 300) };
	return { workspaceId, outputId, revised: false };
}`;
}
