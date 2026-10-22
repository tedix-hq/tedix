/**
 * `tedix learn profile`: read a member's whole local agent history and write
 * "What Tedix knows about you", a document in their own Tedix space, plus
 * up to three inbox proposals they can accept in one click.
 *
 * 1. Facts (local, no model): every transcript, sub-agents folded into their
 *    session, read by learn-facts.ts.
 * 2. Per session (local model): a short structured summary (goal, outcome,
 *    status, artifacts, open loops, workstream), batched and cached by a
 *    hash of the session's digest, so a re-run only summarises new or
 *    changed sessions.
 * 3. Per workstream (local model): sessions grouped into bodies of work,
 *    linked to the board's projects and Work (read-only), with where each
 *    stands and what is next.
 * 4. Person (local model): role, focus, working style, recurring workflows,
 *    people and organisations, tools, and three things to do now.
 * 5. Upload: the document (to the member's private workspace: it may name
 *    people and customers, so only they can see it) and the three
 *    actions as proposals addressed to the member (names taken out, since an
 *    accepted proposal becomes shared Work). Raw transcripts never leave the
 *    machine; every uploaded string is scrubbed of secrets, email addresses
 *    and phone numbers.
 */
import { unknownOptionError } from "./unknown-option";
import {
	type ContextDeps,
	stateDirectory,
	cachedModel,
	caller,
	codexGoals,
	askedFor,
} from "./learn-context";
import {
	withoutNames,
	type Candidate,
	words,
	THRESHOLDS,
	type Proposal,
} from "./learn-context-candidates";
import { matchBoard } from "./learn-context-board";
import { memoryNotes } from "./learn-context-notes";
import { type TranscriptFile, transcriptFiles, trivial } from "./learn-facts";
import type { RunModel } from "./learn-analyze";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type OrganizationTarget,
	defaultOrganizationTarget,
} from "./agent-context";
import { cliRead } from "./hooks/hook-io";
import {
	type AskedProposal,
	listProposalsSource,
	withdrawSource,
	proposalRequest,
	publishSource,
} from "./learn-proposals";
import type { ProposalStart } from "@tedix/api-contract/schemas/work-interactions";
import { mkdirSync, writeFileSync } from "node:fs";
import {
	readProfileState,
	writeProfileState,
	readAllFacts,
} from "./learn-profile-state";
import {
	countMap,
	sha,
	sessionDigest,
	SUMMARY_BATCH,
	summarise,
	day,
	publicText,
} from "./learn-profile-digest";
import {
	usageStats,
	buildProfile,
	planNow,
	priorities,
	CUSTOMER,
	groundWeek,
	weekCorpus,
} from "./learn-profile-insights";
import { newMeter, profileModel, type Json } from "./learn-profile-model";
import {
	groupWorkstreams,
	mergeWorkstreams,
	describeWorkstreams,
	stabilizeWorkstreams,
} from "./learn-profile-workstreams";
import { type Board, readBoard, TEAM_SOURCE } from "./learn-profile-board";
import {
	type ActionLink,
	OS_URL,
	renderDocument,
	markdown,
	publishDocSource,
} from "./learn-profile-document";

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export interface ProfileDeps extends ContextDeps {
	transcripts?: TranscriptFile[];
	model?: { name: string; run: RunModel } | null;
	notes?: string[];
	/** Goals set in Codex threads, by thread id. */
	goals?: Map<string, string>;
	now?: () => Date;
}

function profileOptions(args: string[]) {
	const options = {
		dryRun: false,
		noUpload: false,
		json: false,
		since: "",
		space: "",
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const value = () => {
			const v = args[++i];
			if (!v || v.startsWith("--")) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--no-upload") options.noUpload = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--since") options.since = new Date(value()).toISOString();
		else if (arg === "--space") options.space = value();
		else if (arg === "--no-model")
			throw new Error(
				"learn profile needs your local model; use --dry-run to count without it",
			);
		else
			throw unknownOptionError("learn profile", arg, [
				"--dry-run",
				"--no-upload",
				"--json",
				"--since",
				"--space",
				"--no-model",
			]);
	}
	return options;
}

export async function runProfile(
	args: string[],
	deps: ProfileDeps = {},
): Promise<number> {
	const write = deps.write ?? ((line: string) => console.log(line));
	const options = profileOptions(args);
	const started = Date.now();
	const now = deps.now?.() ?? new Date();
	const today = now.toISOString().slice(0, 10);
	const home = deps.home ?? homedir();
	const stateDir = join(deps.stateDir ?? stateDirectory(), "profile");
	const statePath = join(stateDir, "state.json");
	const state = readProfileState(statePath);
	const save = () => {
		if (!options.dryRun) writeProfileState(statePath, state);
	};
	const files = deps.transcripts ?? transcriptFiles(home);
	write(
		`Reading ${files.length} transcript files (${Math.round(files.reduce((n, f) => n + f.bytes, 0) / 1e6)} MB) on this machine...`,
	);
	const all = await readAllFacts(files, state, home);
	save();
	const sessions = all.filter(
		(f) => !trivial(f) && (!options.since || f.to >= options.since),
	);
	const kinds = countMap(sessions.map((f) => `${f.harness} ${f.kind}`));
	write(
		`  ${sessions.length} sessions worth reading (${kinds.map(([k, v]) => `${v} ${k}`).join(", ")}); ${all.length - sessions.length} trivial or older skipped; ${sessions.reduce((n, f) => n + f.subagents, 0)} sub-agent runs folded in.`,
	);
	if (!sessions.length) {
		write("  No sessions to learn from on this machine; nothing written.");
		return 0;
	}
	if (options.dryRun) {
		const stats = usageStats(sessions);
		const pending = sessions.filter(
			(f) => state.summaries[f.key]?.hash !== sha(sessionDigest(f, 0)),
		).length;
		const report = {
			files: files.length,
			sessions: sessions.length,
			kinds: Object.fromEntries(kinds),
			pendingSummaries: pending,
			modelCalls: Math.ceil(pending / SUMMARY_BATCH) + 3,
			commits: stats.commits,
			workItems: stats.workItems,
			from: stats.from,
			to: stats.to,
		};
		write(
			options.json
				? JSON.stringify(report)
				: `  ${pending} need a summary (about ${report.modelCalls} model calls); ${stats.commits} commits and ${stats.workItems} Work Items seen. Dry run: nothing sent.`,
		);
		return 0;
	}
	const meter = newMeter();
	const model =
		deps.model !== undefined
			? deps.model
			: deps.runModel
				? { name: "local model", run: deps.runModel }
				: profileModel(meter);
	if (!model) {
		write(
			"learn profile needs your local claude or codex CLI to summarise sessions; neither is installed.",
		);
		return 2;
	}
	const rollups = cachedModel(
		model.run,
		join(stateDir, "model-cache.json"),
		true,
	);
	write(`  Summarising with ${model.name}...`);
	const summaries = await summarise(
		sessions,
		state,
		model.run,
		meter,
		save,
		write,
	);
	write(
		`  ${summaries.size} sessions summarised (${meter.cached} reused). Grouping into workstreams...`,
	);
	const read = sessions.filter((f) => summaries.has(f.key));
	const threads = await groupWorkstreams(read, summaries, rollups.run);
	rollups.save();
	const target: OrganizationTarget | undefined =
		"defaultTarget" in deps ? deps.defaultTarget : defaultOrganizationTarget();
	const upload = !options.noUpload && Boolean(target);
	const call = target ? caller(deps.read ?? cliRead, target) : null;
	let board: Board = { me: null, items: new Map(), projects: [] };
	if (call) {
		write(
			`  ${threads.length} threads of work. Reading the board (read-only)...`,
		);
		board = await readBoard(read, call, write);
	}
	const me = board.me;
	const merged = await mergeWorkstreams(
		threads,
		summaries,
		board,
		rollups.run,
		state.workstreams,
	);
	rollups.save();
	write(`  Merged into ${merged.length} workstreams. Describing them...`);
	await describeWorkstreams(merged, summaries, rollups.run, today);
	rollups.save();
	const { workstreams, registry } = stabilizeWorkstreams(
		merged,
		state.workstreams,
	);
	state.workstreams = registry;
	save();
	write("  Writing your profile...");
	const notes = deps.notes ?? memoryNotes(home).map((n) => n.text);
	const profile = await buildProfile({
		sessions,
		summaries,
		workstreams,
		notes,
		run: rollups.run,
	});
	// Your inbox first: an open proposal from an earlier run is kept while it still fits.
	let asked: AskedProposal[] = [];
	let inboxRead = false;
	if (call && upload)
		try {
			const r = await call(listProposalsSource(false));
			if (r.ok === false || !Array.isArray(r.rows))
				throw new Error(r.error ?? "No inbox data");
			asked = r.rows;
			inboxRead = true;
		} catch (error) {
			write(
				`  reading your inbox failed: ${(error as Error).message.slice(0, 160)}`,
			);
		}
	let team: Array<{ slug: string; name: string }> = [];
	if (call && upload)
		try {
			const r = await call(TEAM_SOURCE);
			team = Array.isArray(r.team) ? r.team : [];
		} catch {
			/* Without the roster, a delegated start goes to the default tedi. */
		}
	const goals = deps.goals ?? (await codexGoals(home));
	const names = new Set(
		[
			...profile.people.map((x) => x.name),
			...[...summaries.values()].flatMap((s) => s.people),
		]
			.flatMap((n) => n.split(/\s+/))
			.map((n) => n.toLowerCase())
			.filter((n) => n.length > 1),
	);
	const plan = await planNow({
		team,
		// Answered before (accepted, declined or withdrawn): never offered again.
		answered: (title) => {
			const prior = askedFor(
				{
					key: `profile:${sha(title.toLowerCase())}`,
					title: withoutNames(title, names),
				},
				asked,
			);
			return Boolean(prior && prior.state !== "open");
		},
		pending: asked
			.filter((row) => row.key.startsWith("profile:") && row.state === "open")
			.map((row) => row.title),
		ranked: priorities(
			workstreams,
			summaries,
			today,
			profile.orgs.filter((o) => CUSTOMER.test(o.context)).map((o) => o.name),
		),
		goals: [
			...new Set(
				[...sessions]
					.sort((a, b) => (a.to < b.to ? 1 : -1))
					.map((f) => goals.get(f.sessionId))
					.filter((g): g is string => Boolean(g)),
			),
		],
		notes,
		run: rollups.run,
		today,
	});
	profile.week = groundWeek(
		plan.week,
		weekCorpus(sessions, summaries, workstreams, board),
		[sessions.length, new Set(sessions.map((f) => day(f.to))).size],
	);
	profile.actions = plan.actions;
	rollups.save();
	const actions: ActionLink[] = [];
	const proposalsMade: Json = {};
	const withdrawn: string[] = [];
	if (call && upload && me && inboxRead) {
		const open = asked.filter(
			(row) => row.key.startsWith("profile:") && row.state === "open",
		);
		// Missing from this plan (or the sampled history) is not evidence of
		// resolution. Only a known finished workstream retires its proposals.
		const relevant = open.filter(
			(row) =>
				!workstreams.some(
					(w) => w.key === row.workstreamId && w.status === "done",
				),
		);
		const retained = new Set(relevant.slice(0, 3).map((row) => row.id));
		const superseded = open.filter((row) => !retained.has(row.id));
		if (superseded.length) {
			try {
				const r = await call(withdrawSource(superseded));
				withdrawn.push(
					...superseded.filter((row) => r[row.id]?.ok).map((row) => row.id),
				);
			} catch (error) {
				write(
					`  withdrawing superseded proposals failed: ${(error as Error).message.slice(0, 160)}`,
				);
			}
		}
		const remaining = open.filter((row) => !withdrawn.includes(row.id));
		const candidates: Candidate[] = profile.actions.map((a) => ({
			key: `profile:${sha(a.title.toLowerCase())}`,
			kind: "task",
			title: withoutNames(a.title, names),
			confidence: 0.8,
			sessions: [],
			from: today,
			to: today,
			goal: false,
			context: withoutNames(a.why, names),
		}));
		let found: Awaited<ReturnType<typeof matchBoard>> = {
			me,
			scanned: {},
			matches: {},
		};
		try {
			if (candidates.length) found = await matchBoard(candidates, call);
		} catch {
			/* Proposing without the check would risk a duplicate; skip below. */
		}
		const publish: Array<{ key: string; request: Json }> = [];
		profile.actions.forEach((a, i) => {
			const c = candidates[i]!;
			const ws =
				workstreams.find(
					(w) => w.name.toLowerCase() === a.workstream.toLowerCase(),
				) ??
				workstreams.find((w) =>
					words(w.name).some((x) => words(a.workstream).includes(x)),
				);
			if (ws?.status === "done") return;
			const covering = found.matches[c.key]?.w.find(
				(m) =>
					m[5] >= THRESHOLDS.same &&
					(m[3] === "proposed" || m[3] === "accepted"),
			);
			if (covering) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: `${OS_URL}/work/items/${covering[0]}`,
					state: "on-board",
				});
				return;
			}
			const prior = askedFor(
				c,
				remaining.filter(
					(row) =>
						(!row.workstreamId || row.workstreamId === ws?.key) &&
						(!row.startKind || row.startKind === a.kind),
				),
			);
			if (prior) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: `${OS_URL}/work/interactions/${prior.id}`,
					state: "asked",
				});
				return;
			}
			if (remaining.length + publish.length >= 3) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: null,
					state: "not-filed",
					note: "Three profile proposals are already open in your inbox; answer one to make room.",
				});
				return;
			}
			if (!found.matches[c.key]) {
				actions.push({
					title: a.title,
					why: a.why,
					kind: a.kind,
					start: a.start,
					link: null,
					state: "not-filed",
					note: "The board could not be checked, so nothing was filed; ask me in chat to start it.",
				});
				return;
			}
			const proposal: Proposal = {
				key: c.key,
				kind: "task",
				title: publicText(c.title, 300),
				confidence: 0.8,
				sessions: ws?.sessions.length ?? 0,
				from: day(ws?.from ?? today),
				to: day(ws?.to ?? today),
				action: "create",
				...(ws?.project
					? { projectId: ws.project.id, projectKey: ws.project.key }
					: {}),
				reason: publicText(c.context ?? "", 600).replace(/[.\s]+$/, ""),
				citations: (ws?.sessions ?? []).slice(0, 4).map((f) => ({
					harness: f.harness,
					session: f.sessionId,
					title: f.title ? publicText(withoutNames(f.title, names), 140) : null,
					at: day(f.to),
				})),
			};
			const brief = publicText(
				withoutNames(a.start || a.title, names),
				600,
			).replace(/[.\s]+$/, "");
			const tedi = team.find((t) => t.slug === a.tedi);
			const plan: ProposalStart | null =
				brief.length < 10
					? null
					: a.kind === "delegate"
						? { kind: "delegate", brief, ...(tedi ? { tedi: tedi.slug } : {}) }
						: a.kind === "factory"
							? {
									kind: "factory",
									brief,
									...(ws ? { name: ws.name.slice(0, 60) } : {}),
								}
							: {
									kind: "doc",
									brief,
									...(state.space?.workspaceId
										? { workspaceId: state.space.workspaceId }
										: {}),
								};
			const request = proposalRequest(
				proposal,
				me!.name || "you",
				me!.id,
				plan ? { plan, ...(tedi ? { tediName: tedi.name } : {}) } : undefined,
			);
			if (ws) request.metadata.profile = { workstreamId: ws.key };
			publish.push({ key: c.key, request });
			actions.push({
				title: a.title,
				why: a.why,
				kind: a.kind,
				start: a.start,
				link: null,
				state: "proposed",
			});
		});
		if (publish.length) {
			try {
				Object.assign(proposalsMade, await call(publishSource(publish)));
			} catch (error) {
				write(
					`  filing proposals failed: ${(error as Error).message.slice(0, 160)}`,
				);
			}
			for (const a of actions) {
				if (a.state !== "proposed") continue;
				const key = `profile:${sha(a.title.toLowerCase())}`;
				const made = proposalsMade[key];
				if (made?.id) a.link = `${OS_URL}/work/interactions/${made.id}`;
				else {
					a.state = "not-filed";
					a.note = `Not filed (${made?.skipped ?? made?.error ?? "no answer"}); ask me in chat to start it.`;
				}
			}
		}
	} else
		for (const a of profile.actions)
			actions.push({
				title: a.title,
				why: a.why,
				kind: a.kind,
				start: a.start,
				link: null,
				state: "not-filed",
				note: "Not filed (no upload); ask me in chat to start it.",
			});
	const blocks = renderDocument({
		who: me?.name || "you",
		sessions,
		files: files.length,
		summaries,
		workstreams,
		profile,
		actions,
		model: model.name,
		meter,
		seconds: (Date.now() - started) / 1000,
		today,
	});
	const preview = join(stateDir, "what-tedix-knows.md");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	writeFileSync(preview, `${markdown(blocks)}\n`, { mode: 0o600 });
	const report: Json = {
		files: files.length,
		sessions: sessions.length,
		workstreams: workstreams.length,
		active: workstreams.filter((w) => w.status !== "done").length,
		openLoops: workstreams.reduce(
			(n, w) => n + (w.status === "done" ? 0 : w.openLoops.length),
			0,
		),
		workflows: profile.workflows.length,
		people: profile.people.length,
		proposals: actions.filter((a) => a.state === "proposed").length,
		withdrawn,
		actions: actions.map((a) => ({
			title: a.title,
			state: a.state,
			link: a.link,
		})),
		model: model.name,
		modelCalls: meter.calls,
		failedCalls: meter.failed,
		reused: meter.cached,
		costUsd: Math.round(meter.costUsd * 100) / 100,
		seconds: Math.round((Date.now() - started) / 1000),
		preview,
	};
	if (call && upload) {
		try {
			const result = await call(
				publishDocSource({
					workspaceId: options.space || state.space?.workspaceId,
					outputId:
						options.space && options.space !== state.space?.workspaceId
							? undefined
							: state.space?.outputId,
					spaceName: `${(me?.name || "My").split(/\s+/)[0]} (private)`,
					blocks,
				}),
			);
			state.space = {
				organization: target!.organization ?? target!.org,
				workspaceId: result.workspaceId,
				outputId: result.outputId,
			};
			save();
			report.document = `${OS_URL}/outputs/${result.outputId}`;
			report.workspaceId = result.workspaceId;
		} catch (error) {
			report.documentError = (error as Error).message.slice(0, 300);
		}
	}
	report.seconds = Math.round((Date.now() - started) / 1000);
	if (options.json) write(JSON.stringify(report));
	else {
		write(
			`  ${report.workstreams} workstreams (${report.active} active), ${report.openLoops} open loops, ${report.workflows} workflows, ${report.proposals} new proposals; ${report.modelCalls} model calls, $${report.costUsd}, ${report.seconds}s.`,
		);
		write(
			report.document
				? `What Tedix knows about you: ${report.document}`
				: `Not uploaded${report.documentError ? ` (${report.documentError})` : ""}; local preview: ${preview}`,
		);
	}
	return report.documentError ? 1 : 0;
}
