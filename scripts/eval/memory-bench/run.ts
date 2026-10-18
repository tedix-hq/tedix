import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	appendFileSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { detachedGitEnv } from "../../oss/git-env";
import { adapter } from "./adapter";
import { contextFixture, sessionIds } from "./context-fixture";
import {
	corrections,
	facts,
	invalidSources,
	lessonPrompts,
	longMemEval,
	NOW,
	orgs,
	queries,
} from "./fixtures";
import { mean, percentile, retrieval } from "./metrics";

const root = resolve(process.env.MEMORY_BENCH_SOURCE_ROOT ?? process.cwd());
const out = resolve(
	process.env.MEMORY_BENCH_OUT ?? "scripts/eval/memory-bench/results",
);
const label =
	process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? "local";
const git = (...args: string[]) => {
	const p = Bun.spawnSync(["git", "-C", root, ...args], {
		env: detachedGitEnv(),
	});
	if (p.exitCode) throw new Error(p.stderr.toString());
	return p.stdout.toString().trim();
};
const sha = git("rev-parse", "HEAD");
const sourcePaths = [
	"apps/api/src",
	"packages/db/src",
	"packages/db/drizzle",
	"packages/cli/src",
];
if (git("status", "--porcelain", "--", ...sourcePaths))
	throw new Error(
		"Measured production source is dirty; commit it before recording proof.",
	);
const fixtureHash = createHash("sha256")
	.update(readFileSync(new URL("./fixtures.ts", import.meta.url)))
	.digest("hex");
const harnessHash = createHash("sha256")
	.update(
		["adapter.ts", "run.ts", "metrics.ts", "context-fixture.ts"]
			.map((name) =>
				readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
			)
			.join("\n"),
	)
	.digest("hex");
const a = await adapter(root);
a.seed(facts);
for (const fact of facts.filter((f) => f.id.endsWith("-captain"))) {
	const stem = fact.id.slice(0, -8);
	a.edge(fact.id, `${stem}-cargo`, "related_to");
	a.edge(`${stem}-launch`, `${stem}-old`, "supersedes");
	a.edge(`${stem}-launch`, `${stem}-old`, "contradicts");
}
const details: Record<string, unknown[]> = {
	recall: [],
	lessons: [],
	context: [],
	longMemEval: [],
};
for (const q of queries) {
	const r = await a.recall(q.org, q.text),
		top = r.ids.slice(0, 5);
	details.recall!.push({
		id: q.id,
		kind: q.kind,
		expected: q.expected,
		actual: top,
		emitted: r.ids,
		provenance: r.provenance,
		...retrieval(q.expected, r.ids),
		ms: r.ms,
		invalid: r.ids.filter(
			(id: string) => facts.find((f) => f.id === id)?.validTo,
		).length,
		leaks: r.ids.filter(
			(id: string) => facts.find((f) => f.id === id)?.org !== q.org,
		).length,
		forbidden: r.ids.filter((id: string) => q.forbidden.includes(id)),
	});
}
// Sources are valid when distilled; invalidate them only after measuring selection once.
a.seed(
	corrections.flatMap((c) => [
		{ id: c.sourceId, org: c.org, content: c.correction },
		{
			id: c.id,
			org: c.org,
			content: c.lesson,
			topicKey: `learning-feed:decision:fable:codex:${c.id}`,
			metadata: {
				learningFeed: {
					autoConfirmed: true,
					scope: { repo: "fable", harness: "codex", topic: "release" },
					triggers: { keywords: [c.prompt.split(" ")[1]] },
					evidence: {
						version: 1,
						sources: [{ kind: "fact", id: c.sourceId, quote: c.correction }],
						supportCount: 1,
						state: "live",
					},
				},
			},
		},
	]),
);
async function lessonRows(org: string) {
	return a.lessonQueries.listApprovedAgentLessons(a.db, org, "learning-feed:");
}
for (const p of lessonPrompts) {
	const rows = await lessonRows(p.org);
	const selected = a.lessonSelection.selectSessionLessons(rows, {
		harness: "codex",
		repo: "fable",
		topics: [],
		budgetBytes: 2800,
	});
	// The hook ranks the full approved catalog, not the server's byte-trimmed branch result.
	const catalog = a.promptSelector
		? await a.lessonSelection.getSessionLessons(
				{ db: a.db, authType: "user", user: { sub: "fictional-eval-user" } },
				p.org,
				{
					harness: "codex",
					repo: "fable",
					topics: [],
					budgetBytes: 2800,
					catalog: true,
				},
			)
		: selected;
	const r = a.promptSelector
		? await a.promptSelector.selectPromptLessons(catalog.lessons, {
				prompt: p.text,
				repo: "fable",
				budgetBytes: 2800,
			})
		: selected;
	const ids = r.lessons.slice(0, 3).map((l: { id: string }) => l.id);
	details.lessons!.push({
		prompt: p.text,
		expected: p.expected,
		actual: ids,
		selector: a.promptSelector
			? "local-prompt-from-server-catalog"
			: "server-topics-only",
		serverActual: selected.lessons.slice(0, 3).map((l: { id: string }) => l.id),
		top1: p.expected.includes(ids[0]!) ? 1 : 0,
		serverTop1: p.expected.includes(selected.lessons[0]?.id) ? 1 : 0,
		serverPrecision:
			selected.lessons
				.slice(0, 3)
				.filter((l: { id: string }) => p.expected.includes(l.id)).length / 3,
		precision: ids.filter((id: string) => p.expected.includes(id)).length / 3,
		bytes: Buffer.byteLength(
			a.hook.render(
				{
					workspace: "fixture",
					org: p.org,
					projectId: "11111111-1111-4111-8111-111111111111",
					credentialOrganizationId: "22222222-2222-4222-8222-222222222222",
				},
				{
					lessons: {
						organizationId: "22222222-2222-4222-8222-222222222222",
						lessons: r.lessons,
						matched: selected.matched,
						truncated: selected.truncated,
					},
				},
				new Date(NOW),
			),
		),
	});
}
for (const id of invalidSources)
	a.sqlite
		.prepare("UPDATE memory_facts SET valid_to=? WHERE id=?")
		.run(NOW, id);
let held = 0;
for (const org of orgs) {
	const rows = await lessonRows(org);
	for (const c of corrections.filter(
		(c) => c.org === org && invalidSources.includes(c.sourceId),
	)) {
		const absent = !rows.some((r: { id: string }) => r.id === c.id);
		const state = a.sqlite
			.prepare(
				"SELECT json_extract(metadata, '$.learningFeed.evidence.state') AS state FROM memory_facts WHERE id=?",
			)
			.get(c.id) as { state: string };
		if (absent && state.state === "held") held++;
		details.lessons!.push({
			invalidatedSource: c.sourceId,
			lessonId: c.id,
			absent,
			state: state.state,
		});
	}
}
// Execute the real gateway program with fictional local tool doubles, then the real renderer.
const ids = sessionIds;
const scopes = await contextFixture(root);
try {
	for (let n = 0; n < 8; n++) {
		const o = n % 2,
			session = ids[o]!,
			project = ids[o]!,
			org = orgs[o]!,
			repo = `fable-${o}`;
		const rows = [
			{
				id: "unfinished",
				sessionKey: session,
				projectId: project,
				harness: "codex",
				kind: "request",
				text: `UNFINISHED-${o}-${n}`,
				status: "open",
				sourceAt: NOW,
			},
			{
				id: "other-session",
				sessionKey: ids[1 - o],
				projectId: project,
				harness: "codex",
				kind: "request",
				text: "OTHER-SESSION",
				status: "open",
				sourceAt: NOW,
			},
			{
				id: "other-project",
				sessionKey: session,
				projectId: ids[1 - o],
				harness: "codex",
				kind: "request",
				text: "OTHER-PROJECT",
				status: "open",
				sourceAt: NOW,
			},
			{
				id: "fulfilled",
				sessionKey: session,
				projectId: project,
				harness: "codex",
				kind: "request",
				text: "STALE-FULFILLED",
				status: "open",
				sourceAt: "2026-10-18T10:00:00Z",
				evidence: `Work-Item: ${ids[o]}`,
			},
		];
		const binding = {
			...scopes.binding(o),
			ledger: {
				session,
				harness: "codex",
				projectId: project,
				repository: repo,
			},
		};
		const work = {
			list_agent_session_requests: async () => ({ data: rows }),
			get_work_items_by_id: async ({ id }: { id: string }) => ({
				workItem: {
					id,
					projectId: project,
					disposition: "completed",
					completedAt: "2026-10-18T11:58:00Z",
				},
			}),
		};
		const code = a.hook.gatewayCode(binding, undefined, [], true);
		const execute = new Function("work", "os", "agent", `return (${code})()`);
		const data = await execute(work, {}, {});
		const block = a.hook.render(binding, data, new Date(NOW));
		const pass =
			block.includes(`organization=${org}`) &&
			block.includes(`project=${project}`) &&
			block.includes(`UNFINISHED-${o}-${n}`) &&
			!["OTHER-SESSION", "OTHER-PROJECT", "STALE-FULFILLED"].some((s) =>
				block.includes(s),
			);
		details.context!.push({
			session,
			org,
			repo,
			pass,
			block,
			bytes: Buffer.byteLength(block),
		});
	}
} finally {
	scopes.close();
}
a.close();
const lme = await adapter(root);
lme.seed(
	longMemEval.flatMap((item) =>
		item.haystack_sessions.map((messages, j) => ({
			id: item.haystack_session_ids[j]!,
			org: item.org,
			content: messages[0]!.content,
		})),
	),
);
for (const item of longMemEval) {
	const r = await lme.recall(item.org, item.question);
	details.longMemEval!.push({
		id: item.question_id,
		kind: item.question_type,
		expected: item.answer_session_ids,
		actual: r.ids.slice(0, 5),
		...retrieval(item.answer_session_ids, r.ids),
	});
}
lme.close();
// Details remain in JSON; the console is one row per immutable source/fixture pair.
const recall = details.recall as Array<{
	recall: number;
	mrr: number;
	ms: number;
	invalid: number;
	leaks: number;
}>;
const lessons = details.lessons!.filter(
	(r) => "precision" in (r as object),
) as Array<{
	precision: number;
	bytes: number;
	top1: number;
	serverTop1: number;
	serverPrecision: number;
}>;
const context = details.context as Array<{ pass: boolean; bytes: number }>;
const lm = details.longMemEval as Array<{ recall: number; mrr: number }>;
const row = {
	label,
	sha,
	at: new Date().toISOString(),
	fixtureHash,
	harnessHash,
	backend: "local D1 facade; production assembleContext; no remote models",
	recallAt5: mean(recall.map((r) => r.recall)),
	mrr: mean(recall.map((r) => r.mrr)),
	invalidSurfaced: recall.reduce((n, r) => n + r.invalid, 0),
	tenantLeaks: recall.reduce((n, r) => n + r.leaks, 0),
	p50Ms: percentile(
		recall.map((r) => r.ms),
		0.5,
	),
	p95Ms: percentile(
		recall.map((r) => r.ms),
		0.95,
	),
	lessonPrecisionAt3: mean(lessons.map((r) => r.precision)),
	lessonTop1: mean(lessons.map((r) => r.top1)),
	serverLessonPrecisionAt3: mean(lessons.map((r) => r.serverPrecision)),
	serverLessonTop1: mean(lessons.map((r) => r.serverTop1)),
	heldWhenInvalid: held / invalidSources.length,
	injectedBlockBytes: {
		mean: mean(lessons.map((r) => r.bytes)),
		max: Math.max(...lessons.map((r) => r.bytes)),
	},
	contextPass: context.filter((r) => r.pass).length / context.length,
	longMemEvalRecallAt5: mean(lm.map((r) => r.recall)),
};
mkdirSync(out, { recursive: true });
const filename = `${row.at.replace(/[:.]/g, "-")}-${label.replace(/[^a-z0-9_-]/gi, "-")}.json`;
writeFileSync(
	resolve(out, filename),
	JSON.stringify(
		{
			row,
			counts: {
				facts: facts.length,
				queries: queries.length,
				corrections: corrections.length,
				prompts: lessonPrompts.length,
				contextChecks: context.length,
				sessions: 2,
				longMemEval: longMemEval.length,
			},
			details,
		},
		null,
		2,
	) + "\n",
);
appendFileSync(resolve(out, "history.jsonl"), JSON.stringify(row) + "\n");
writeFileSync(
	resolve(out, "longmemeval-synthetic.json"),
	JSON.stringify(longMemEval, null, 2) + "\n",
);
console.table([
	{
		stage: label,
		sha: sha.slice(0, 8),
		"recall@5": row.recallAt5,
		MRR: row.mrr,
		invalid: row.invalidSurfaced,
		leaks: row.tenantLeaks,
		"p50 ms": +row.p50Ms.toFixed(2),
		"p95 ms": +row.p95Ms.toFixed(2),
		"lesson P@3": +row.lessonPrecisionAt3.toFixed(3),
		held: row.heldWhenInvalid,
		"block bytes avg/max": `${Math.round(row.injectedBlockBytes.mean)}/${row.injectedBlockBytes.max}`,
		"context pass": row.contextPass,
		"LME R@5": row.longMemEvalRecallAt5,
	},
]);
console.log(`JSON: ${resolve(out, filename)}`);
