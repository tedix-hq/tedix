import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { fixture } from "./fixture.mjs";
import { markdown, measure } from "./measure.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
/** @param {(ancestor: string, descendant: string) => boolean} ancestor */
export function deploymentContains(sha, required, ancestor) {
	if (
		!/^[a-f0-9]{40}$/.test(sha ?? "") ||
		required.some((s) => !/^[a-f0-9]{40}$/.test(s))
	)
		throw new Error("Full deployment and dependency SHAs required");
	for (const commit of required)
		if (!ancestor(commit, sha))
			throw new Error(`Deployment ${sha} does not contain required ${commit}`);
}

async function main() {
	const { values: v } = parseArgs({
		options: {
			fixture: { type: "boolean" },
			snapshot: { type: "string" },
			labels: { type: "string" },
			out: { type: "string" },
			organization: { type: "string" },
			profile: { type: "string", default: "connect" },
			"writers-sha": { type: "string" },
			"backfill-sha": { type: "string" },
			"health-url": { type: "string" },
			"api-health-url": { type: "string" },
			"max-pages": { type: "string", default: "1000" },
			"baseline-config": { type: "string" },
		},
	});
	if (!v.out)
		throw new Error(
			"--out is required (private directory outside the repository)",
		);
	const root = git("rev-parse", "--show-toplevel"),
		out = resolve(v.out);
	if (out === root || out.startsWith(`${root}/`))
		throw new Error("Evidence must stay outside the repository");
	await mkdir(out, { recursive: true, mode: 0o700 });
	let snapshot,
		labels = [];
	if (v.fixture) ({ snapshot, labels } = fixture());
	else if (v.snapshot)
		snapshot = JSON.parse(await readFile(v.snapshot, "utf8"));
	else {
		if (
			!v.organization ||
			!v["writers-sha"] ||
			!v["backfill-sha"] ||
			!v["health-url"] ||
			!v["api-health-url"]
		)
			throw new Error(
				"Live mode requires organization, both dependency SHAs and both OS/API health URLs",
			);
		const dependencies = [v["writers-sha"], v["backfill-sha"]];
		git("fetch", "-q", "origin", "main");
		const ancestor = (a, b) => {
			try {
				git("merge-base", "--is-ancestor", a, b);
				return true;
			} catch {
				return false;
			}
		};
		for (const sha of dependencies)
			deploymentContains(git("rev-parse", "origin/main"), [sha], ancestor);
		const deployment = {
			dependencies,
			sourceSha: git("rev-parse", "HEAD"),
			health: [],
		};
		for (const url of [v["health-url"], v["api-health-url"]]) {
			if (new URL(url).protocol !== "https:")
				throw new Error("Health URL must use HTTPS");
			const response = await fetch(url, {
				redirect: "error",
				signal: AbortSignal.timeout(30000),
			});
			if (!response.ok) throw new Error(`Health failed ${response.status}`);
			const health = await response.json();
			const sha = health.deployedSha;
			deploymentContains(sha, dependencies, ancestor);
			deployment.health.push({
				url,
				sha,
				observedAt: new Date().toISOString(),
			});
		}
		async function code(source) {
			const proc = Bun.spawn(
				[
					"tedix",
					"--organization",
					v.organization,
					"-w",
					v.profile,
					"code",
					`async () => { ${source} }`,
					"--json",
				],
				{ stdout: "pipe", stderr: "pipe", env: process.env },
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exit !== 0 || /truncat/i.test(stderr))
				throw new Error(`CLI read failed: ${stderr || stdout}`);
			let result = JSON.parse(stdout);
			for (let i = 0; i < 8 && result?.result !== undefined; i++)
				result = result.result;
			if (typeof result === "string") result = JSON.parse(result);
			if (!result || result.error)
				throw new Error("Missing or failed read result");
			return result;
		}
		async function discover(name) {
			const matches = await code(
				`const r=await discover.search(${codeModeLiteral({ query: name, limit: 10, includeParameters: true })}); return r.filter(x=>x.tool===${codeModeLiteral(name)}).map(x=>({callable:x.callable,parameters:x.parameters,readOnly:x.annotations?.readOnlyHint}));`,
			);
			if (
				matches.length !== 1 ||
				matches[0].readOnly !== true ||
				!/^[a-zA-Z_][\w]*\.[a-zA-Z_][\w]*$/.test(matches[0].callable)
			)
				throw new Error(`Exact read-only tool unavailable: ${name}`);
			await writeFile(
				join(out, `schema-${name}.json`),
				JSON.stringify(matches[0], null, 2),
			);
			return matches[0].callable;
		}
		const deckTool = await discover("list_deck_cards"),
			inboxTool = await discover("list_work_interactions"),
			contextTool = await discover("get_decision_context"),
			detailTool = await discover("get_work_interaction"),
			learningTool = await discover("get_decision_learning");
		const learning = await code(
			`const r=await ${learningTool}({}); return {pipeline:r.config.deckPipeline,timeZone:r.config.timezone};`,
		);
		// Project the inventory before serialization; full cards can exceed gateway limits.
		const deck = await code(
			`const r=await ${deckTool}({limit:100}); return {ids:r.cards.map(c=>c.id),otherCards:r.cards.filter(c=>!c.interaction).map(c=>({id:c.id,kind:c.kind,label:c.label,requestedAt:c.requestedAt,dueAt:c.dueAt,workItemId:c.workApproval?.workItem?.id??null})),count:r.count,complete:r.complete,observedAt:r.observedAt,pipeline:r.pipeline};`,
		);
		snapshot = {
			mode: "live",
			observedAt: deck.observedAt,
			timeZone: learning.timeZone,
			currentIds: deck.ids,
			rows: [],
			contexts: {},
			deployment,
			coverage: {
				currentComplete: deck.complete && deck.ids.length === deck.count,
				currentCount: deck.count,
				historyScope:
					"Interaction cards; factory/runtime/Work approval histories not inventoried",
				conservativelyProtectedProjections: deck.otherCards.length,
				historyComplete: false,
				pages: 0,
			},
			baselineConfigSource: v["baseline-config"]
				? "operator-supplied supported-API configuration"
				: "live get_decision_learning Deck pipeline configuration",
		};
		if (v["baseline-config"])
			snapshot.baselineConfig = JSON.parse(
				await readFile(v["baseline-config"], "utf8"),
			);
		else snapshot.baselineConfig = learning.pipeline;
		const cutoff = new Date(
				Date.parse(snapshot.observedAt) - 30 * 86400000,
			).toISOString(),
			seen = new Set(),
			cursors = new Set();
		let cursor;
		const maxPages = Number(v["max-pages"]);
		if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10000)
			throw new Error("Invalid page bound");
		for (let i = 0; i < maxPages; i++) {
			const page = await code(
				`return await ${inboxTool}(${codeModeLiteral({ limit: 1, ...(cursor ? { cursor } : {}) })});`,
			);
			if (!Array.isArray(page.data) || typeof page.hasMore !== "boolean")
				throw new Error("Malformed history page");
			for (const row of page.data)
				if (!seen.has(row.request.id)) {
					seen.add(row.request.id);
					snapshot.rows.push(row);
				}
			snapshot.coverage.pages++;
			const reachedCutoff =
				page.data.length > 0 &&
				page.data.every((r) => r.request.requestedAt < cutoff);
			if (!page.hasMore || reachedCutoff) {
				snapshot.coverage.historyComplete = true;
				break;
			}
			if (!page.nextCursor || cursors.has(JSON.stringify(page.nextCursor)))
				throw new Error("History cursor missing or repeated");
			cursor = page.nextCursor;
			cursors.add(JSON.stringify(cursor));
		}
		for (const card of deck.otherCards) {
			snapshot.rows.push({
				request: {
					id: card.id,
					kind: card.kind,
					subject: card.label,
					prompt: card.label,
					creatorType: "system",
					creatorId: "deck-projection",
					workItemId: card.workItemId,
					requestedAt: card.requestedAt,
					dueAt: card.dueAt,
					expiresAt: null,
					metadata: { riskLevel: "critical" },
				},
				effectiveState: "open",
				workItem: null,
			});
			seen.add(card.id);
		}
		for (const cardId of snapshot.currentIds.filter((id) => !seen.has(id))) {
			if (!/^[a-f0-9-]{36}$/.test(cardId)) continue; // Factory/runtime cards have no interaction row.
			const row = await code(
				`const r=await ${detailTool}(${codeModeLiteral({ requestId: cardId, responseLimit: 1 })}); return {request:r.request,effectiveState:r.effectiveState,canRespond:r.canRespond,canCancel:r.canCancel,workItem:null,responseCount:0};`,
			);
			snapshot.rows.push(row);
		}
		const ids = new Set([
			...snapshot.currentIds,
			...snapshot.rows
				.filter((r) => r.request.requestedAt >= cutoff)
				.map((r) => r.request.id),
		]);
		for (const cardId of ids) {
			const r = await code(
				`return await ${contextTool}(${codeModeLiteral({ cardId, maxHops: 4 })});`,
			);
			if (!r.context) throw new Error("Graph context missing");
			snapshot.contexts[cardId] = r.context;
			await writeFile(
				join(out, "snapshot.json"),
				JSON.stringify(snapshot, null, 2),
				{ mode: 0o600 },
			);
		}
	}
	if (v.labels) labels = JSON.parse(await readFile(v.labels, "utf8"));
	const result = measure(snapshot, labels);
	await writeFile(
		join(out, "snapshot.json"),
		JSON.stringify(snapshot, null, 2),
		{ mode: 0o600 },
	);
	await writeFile(join(out, "results.json"), JSON.stringify(result, null, 2), {
		mode: 0o600,
	});
	await writeFile(join(out, "report.md"), markdown(result), { mode: 0o600 });
	await writeFile(
		join(out, "sample-to-label.json"),
		JSON.stringify(
			Object.values(result.precision).flatMap((p) =>
				p.examples.map(({ label, ...c }) => ({
					...c,
					correct: null,
					evidenceRef: null,
					sourceType: null,
					observedAt: null,
					note: null,
				})),
			),
			null,
			2,
		),
		{ mode: 0o600 },
	);
	console.log(
		JSON.stringify(
			{
				cohorts: Object.fromEntries(
					Object.entries(result.cohorts).map(
						([name, { candidates, ranking, ...c }]) => [
							name,
							{ ...c, moved: ranking.moved },
						],
					),
				),
				precision: Object.fromEntries(
					Object.entries(result.precision).map(([rule, { examples, ...p }]) => [
						rule,
						p,
					]),
				),
			},
			null,
			2,
		),
	);
}
if (import.meta.main) await main();
