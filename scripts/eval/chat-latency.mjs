/**
 * Live, sequential correctness + latency eval. Uses the installed CLI and its
 * normal authorization/approval policy. No retries of chat mutations.
 *
 * TEDIX_ORGANIZATION=<selected-org> bun scripts/eval/chat-latency.mjs \
 *   --profile connect --label baseline --out /tmp/chat-baseline --rounds 2
 *
 * Each round uses fresh conversations and distinct fictional output titles.
 * Cold/warm means the server's actual isolate tag, never an assumed CLI cold
 * start. A managed deployment is needed before measuring a source change.
 * Raw inspect evidence stays in --out (may contain private organization context).
 * Missing phases stay null; they are never counted as zero latency.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";

export const fixtures = [
	{
		id: "doc-1",
		kind: "document",
		title: "Blue Harbor Welcome",
		task: "Create a document titled {title} with one paragraph welcoming visitors to the fictional Blue Harbor Bakery.",
		contains: ["Blue Harbor"],
	},
	{
		id: "sheet-1",
		kind: "sheet",
		title: "Cedar Lantern Budget",
		task: "Create a sheet titled {title} with columns Item and Cost, and rows Bread 12 and Tea 8.",
		contains: ["Bread", "12", "Tea", "8"],
		rows: [
			["Bread", 12],
			["Tea", 8],
		],
	},
	{
		id: "deck-1",
		kind: "presentation",
		title: "Willow Cove Launch",
		task: "Create a 3-slide deck titled {title} about the fictional Willow Cove bookshop: Welcome, Books, Opening Day.",
		contains: ["Welcome", "Books", "Opening"],
	},
	{
		id: "doc-2",
		kind: "document",
		title: "Maple Finch Returns",
		task: "Please draft a short doc titled {title} explaining a fictional shop allows returns within 14 days.",
		contains: ["14"],
	},
	{
		id: "sheet-2",
		kind: "sheet",
		title: "Silver Fern Stock",
		task: "Make a spreadsheet titled {title} with columns Product and Quantity, and rows Notebook 5 and Pencil 9.",
		contains: ["Notebook", "5", "Pencil", "9"],
		rows: [
			["Notebook", 5],
			["Pencil", 9],
		],
	},
	{
		id: "deck-2",
		kind: "presentation",
		title: "Amber Kite Kickoff",
		task: "Can you build a presentation titled {title} with two slides about fictional Amber Kite Studio: Goals and Schedule.",
		contains: ["Goals", "Schedule"],
	},
	{
		id: "doc-3",
		kind: "document",
		title: "Otter Bay Hours",
		task: "Write a document titled {title} saying the fictional Otter Bay cafe opens at 9 AM and closes at 5 PM.",
		contains: ["9", "5"],
	},
	{
		id: "doc-edit",
		kind: "document",
		target: "doc-1",
		task: 'Append a paragraph saying "Fresh bread arrives daily" to document {outputId}, titled {title}. Preserve its existing content and title.',
		contains: ["Blue Harbor", "Fresh bread arrives daily"],
	},
	{
		id: "sheet-edit",
		kind: "sheet",
		target: "sheet-1",
		task: "Update cell B2 to 15 in sheet {outputId}, titled {title}. Preserve all other cells and the title.",
		contains: ["Bread", "12", "Tea", "15"],
		rows: [
			["Bread", 12],
			["Tea", 15],
		],
	},
	{
		id: "deck-edit",
		kind: "presentation",
		target: "deck-1",
		task: 'Change the first slide title to "Hello Willow Cove" in presentation {outputId}, titled {title}. Preserve the other slides and output title.',
		contains: ["Hello Willow Cove", "Books", "Opening"],
	},
	{
		id: "q-1",
		task: "What is photosynthesis? Answer in one short sentence.",
		topic: [
			["sunlight", "light"],
			["plant", "plants"],
			["sugar", "food", "energy"],
		],
	},
	{
		id: "q-2",
		task: "What is 17 multiplied by 6? Answer briefly.",
		topic: [["102"]],
	},
	{
		id: "q-3",
		task: "Explain the difference between a row and a column in a spreadsheet in one sentence.",
		topic: [["row"], ["column"], ["horizontal"], ["vertical"]],
	},
	{
		id: "q-4",
		task: "Why does ice float on water? Answer in one sentence.",
		topic: [["dens", "lighter"], ["water"]],
	},
	{
		id: "q-5",
		task: "Give two tips for a readable presentation slide.",
		topic: [
			["font", "text", "type"],
			["contrast", "simple", "clutter", "concise", "brief", "space"],
		],
	},
	{
		id: "q-6",
		task: 'Translate "Good morning" into German. Answer only the translation.',
		topic: [["guten morgen"]],
	},
	{
		id: "q-7",
		task: "What is the capital of France? Answer briefly.",
		topic: [["paris"]],
	},
	{
		id: "q-8",
		task: "A fictional bakery sells 3 loaves at 4 euros each. What is the total revenue?",
		topic: [["12"]],
	},
	{
		id: "q-9",
		task: "In one sentence, explain what a document heading does.",
		topic: [
			["section", "organ", "topic", "structur"],
			["heading", "title", "label"],
		],
	},
	{
		id: "q-10",
		task: "What is the difference between a mean and a median? Answer in one sentence.",
		topic: [
			["average", "sum"],
			["middle", "central"],
		],
	},
];

export function unwrap(value) {
	for (let i = 0; i < 8 && value && typeof value === "object"; i++) {
		if ("result" in value) value = value.result;
		else break;
	}
	return value;
}
export function percentiles(values) {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	const at = (p) =>
		sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
	return { n: sorted.length, p50: at(0.5), p90: at(0.9) };
}
export function phases(metadata, completedAt) {
	const t = metadata.kernelTurnTimings;
	const s = t?.stages ?? {};
	const diff = (a, b) =>
		Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, a - b) : null;
	const hedge = metadata.kernelRouteHedge;
	const first =
		hedge?.winner === "hedge"
			? Number.isFinite(hedge.hedgeFirstPartialMs)
				? hedge.afterMs + hedge.hedgeFirstPartialMs
				: null
			: hedge?.primaryFirstPartialMs;
	return {
		contextMs: diff(s.plannerFirstProgress, s.routePlanStarted),
		routeFirstTokenMs: Number.isFinite(first) ? first : null,
		routeDecisionMs: diff(s.routePlanEnded, s.plannerFirstProgress),
		writePlanMs:
			t?.turnType === "write_proposal"
				? diff(s.writeProposalPlanEnded, s.writeProposalPlanStarted)
				: null,
		executeMs:
			metadata.kernelWriteExecutedAt && completedAt
				? diff(
						Date.parse(completedAt),
						Date.parse(metadata.kernelWriteExecutedAt),
					)
				: null,
		firstAnswerMs: Number.isFinite(s.firstAnswerDelta)
			? s.firstAnswerDelta + (t.enqueueToWorkMs ?? 0)
			: null,
		serverMs: t?.totalMs ?? null,
	};
}
export function summarize(rows) {
	const groups = {};
	for (const row of rows) {
		for (const key of new Set([
			"all",
			row.kind ?? "question",
			row.operation,
			`isolate:${row.isolate ?? "unknown"}`,
		])) {
			(groups[key] ??= []).push(row);
		}
	}
	return Object.fromEntries(
		Object.entries(groups).map(([key, rs]) => [
			key,
			{
				count: rs.length,
				passed: rs.filter((r) => r.ok).length,
				...Object.fromEntries(
					[
						"wallMs",
						"contextMs",
						"routeFirstTokenMs",
						"routeDecisionMs",
						"writePlanMs",
						"executeMs",
						"firstAnswerMs",
						"serverMs",
					].map((k) => [k, percentiles(rs.map((r) => r[k]))]),
				),
			},
		]),
	);
}

export function checkOutput(fixture, detail, target) {
	const revision = detail.currentRevision;
	if (!revision?.content || !Number.isInteger(revision.revision))
		throw new Error("Missing canonical revision");
	if (revision.content.kind !== fixture.kind)
		throw new Error("Wrong content type");
	if (
		fixture.rows &&
		JSON.stringify(revision.content.rows) !== JSON.stringify(fixture.rows)
	)
		throw new Error("Sheet cells differ from expected values");
	const body = JSON.stringify(revision.content).toLowerCase();
	const missing = fixture.contains.filter(
		(s) => !body.includes(s.toLowerCase()),
	);
	if (missing.length)
		throw new Error(`Missing expected content: ${missing.join(", ")}`);
	if (
		target &&
		(detail.output.id !== target.id ||
			!Number.isInteger(target.revision) ||
			revision.revision <= target.revision)
	)
		throw new Error("Edit did not advance the target revision");
}

/** Re-score saved readbacks without repeating any model call or mutation. */
export async function recheckSaved(directory) {
	const saved = JSON.parse(
		await readFile(join(directory, "results.json"), "utf8"),
	);
	const targets = new Map();
	for (const row of saved.rows) {
		const fixture = fixtures.find((f) => f.id === row.id);
		try {
			const inspected = JSON.parse(
				await readFile(
					join(directory, `${row.round}-${row.id}-inspect.json`),
					"utf8",
				),
			);
			const run = unwrap(inspected.run).run;
			Object.assign(row, phases(run.metadata, run.completedAt));
			row.isolate = run.metadata.kernelTurnTimings?.isolate?.tag;
			row.status = run.status;
			row.model = run.metadata.bodyExecutionResult?.usage?.model ?? null;
			if (fixture.kind) {
				const detail = JSON.parse(
					await readFile(
						join(directory, `${row.round}-${row.id}-output.json`),
						"utf8",
					),
				);
				if (
					detail.output.title !== row.title ||
					detail.output.kind !== fixture.kind ||
					detail.output.workspaceId !== saved.workspaceId
				)
					throw new Error("Wrong output title, kind or workspace");
				const target = fixture.target
					? targets.get(`${row.round}:${fixture.target}`)
					: null;
				if (fixture.target && !target)
					throw new Error("Missing prerequisite output");
				checkOutput(fixture, detail, target);
				targets.set(`${row.round}:${row.id}`, {
					id: detail.output.id,
					revision: detail.currentRevision.revision,
				});
				row.outputId = detail.output.id;
			} else {
				const answer = (inspected.summary?.assistantText ?? "").toLowerCase();
				if (
					run.status !== "completed" ||
					run.metadata.kernelRoute?.routeKind !== "answer_in_home" ||
					!fixture.topic.every((options) =>
						options.some((s) => answer.includes(s)),
					)
				)
					throw new Error("Answer failed on-topic checks");
			}
			row.ok = true;
			delete row.error;
		} catch (error) {
			row.ok = false;
			row.error = String(error);
		}
	}
	saved.summary = summarize(saved.rows);
	await writeFile(
		join(directory, "results.json"),
		JSON.stringify(saved, null, 2),
	);
	return saved;
}

export async function archiveWithReadback(
	write,
	read,
	isArchived,
	sleep = Bun.sleep,
) {
	for (let attempt = 0; attempt < 8; attempt++) {
		await write();
		const state = await read();
		if (isArchived(state)) return state;
		if (attempt < 7) await sleep(Math.min(1000 * 2 ** attempt, 30000));
	}
	throw new Error("Scratch archive readback failed after retries");
}

async function main() {
	const { values } = parseArgs({
		options: {
			profile: { type: "string", default: "connect" },
			label: { type: "string", default: "baseline" },
			out: { type: "string" },
			rounds: { type: "string", default: "2" },
			recheck: { type: "boolean" },
		},
	});
	if (values.recheck) {
		if (!values.out) throw new Error("--recheck requires --out");
		const result = await recheckSaved(values.out);
		console.log(JSON.stringify(result.summary, null, 2));
		if (result.rows.some((row) => !row.ok)) process.exitCode = 1;
		return;
	}
	if (!process.env.TEDIX_ORGANIZATION || !values.out)
		throw new Error(
			"Set TEDIX_ORGANIZATION and --out (private evidence directory)",
		);
	const rounds = Number(values.rounds);
	if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10)
		throw new Error("--rounds must be 1..10");
	await mkdir(values.out, { recursive: true });
	async function cli(args) {
		const started = performance.now();
		const proc = Bun.spawn(["tedix", "-w", values.profile, ...args], {
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		const wallMs = Math.round(performance.now() - started);
		const value = stdout.trim() ? JSON.parse(stdout) : null;
		// A failed durable chat run still has phase timings worth inspecting.
		if (exit !== 0 && exit !== 3 && !(args[0] === "chat" && value?.homeRunId))
			throw new Error(`CLI exit ${exit}: ${stderr || stdout}`);
		return { value, wallMs, exit };
	}
	const code = async (source) =>
		unwrap((await cli(["code", `async () => { ${source} }`])).value);
	let workspace;
	const rows = [];
	let interrupted = false;
	let finishMeasurements;
	const measurementsFinished = new Promise((resolve) => {
		finishMeasurements = resolve;
	});
	let cleanup;
	function archiveScratch() {
		return (cleanup ??= measurementsFinished.then(async () => {
			if (!workspace) return;
			const failures = [];
			const archive = async (write, read, check) => {
				try {
					return await archiveWithReadback(write, read, check);
				} catch (error) {
					failures.push(error);
				}
			};
			for (const row of rows) {
				if (!row.conversation) continue;
				await archive(
					() =>
						code(
							`return await home.archive_conversation(${JSON.stringify({ conversationId: row.conversation, archived: true })});`,
						),
					() =>
						code(
							`return await home.list_conversations(${JSON.stringify({ search: row.conversation, includeArchived: true, limit: 500 })});`,
						),
					(state) =>
						state?.conversations?.some(
							(c) => c.id === row.conversation && c.status === "archived",
						),
				);
			}
			const listed = await code(
				`return await os.list_os_outputs(${JSON.stringify({ workspaceId: workspace.id, status: "active", limit: 200 })});`,
			);
			if (!listed?.items || listed.truncated)
				throw new Error("Scratch cleanup inventory missing or truncated");
			for (const output of listed.items) {
				await archive(
					() =>
						code(
							`return await os.archive_os_output(${JSON.stringify({ outputId: output.id })});`,
						),
					() =>
						code(
							`return await os.get_os_output(${JSON.stringify({ outputId: output.id })});`,
						),
					(state) => state?.output?.status === "archived",
				);
			}
			const archived = await archive(
				() =>
					code(
						`return await os.archive_os_workspace(${JSON.stringify({ workspaceId: workspace.id })});`,
					),
				() =>
					code(
						`return await os.get_os_workspace(${JSON.stringify({ workspaceId: workspace.id })});`,
					),
				(state) => state?.workspace?.status === "archived",
			);
			const remaining = await code(
				`return await os.list_os_outputs(${JSON.stringify({ workspaceId: workspace.id, status: "active", limit: 200 })});`,
			);
			if (!remaining?.items || remaining.items.length || remaining.truncated)
				failures.push(
					new Error("Scratch outputs remain or readback is incomplete"),
				);
			if (failures.length)
				throw new AggregateError(failures, "Scratch cleanup failed");
			await writeFile(
				join(values.out, "archived.json"),
				JSON.stringify(archived, null, 2),
			);
		}));
	}
	const onSignal = (signal) => {
		interrupted = true;
		process.exitCode = signal === "SIGINT" ? 130 : 143;
		// Finish the in-flight request before inventorying its outputs.
		void archiveScratch().catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		workspace = (
			await code(
				"return await os.create_os_workspace(" +
					JSON.stringify({
						name: `Blue Harbor Latency ${values.label} ${Date.now()}`,
						description: "Fictional scratch eval; archived after measurements.",
						visibility: "private",
					}) +
					");",
			)
		).workspace;
		await writeFile(
			join(values.out, "workspace.json"),
			JSON.stringify(workspace, null, 2),
		);
		for (let round = 1; round <= rounds && !interrupted; round++) {
			const outputs = new Map();
			for (const f of fixtures) {
				if (interrupted) break;
				const target = f.target ? outputs.get(f.target) : null;
				const title =
					target?.title ??
					(f.title ? `${f.title} ${values.label} ${round}` : null);
				let task = f.task
					.replaceAll("{title}", `"${title}"`)
					.replaceAll("{outputId}", target?.id ?? "MISSING");
				if (f.kind)
					task += ` Use only the Tedix scratch workspace "${workspace.name ?? "Blue Harbor Chat Latency Lab"}" (workspaceId ${workspace.id}).`;
				const conversation = `latency:${values.label}:${round}:${f.id}:${Date.now()}`;
				const row = {
					id: f.id,
					round,
					kind: f.kind,
					operation: f.target ? "edit" : f.kind ? "create" : "question",
					title,
					conversation: f.target && !target ? null : conversation,
				};
				rows.push(row);
				try {
					if (f.target && !target)
						throw new Error("Prerequisite create failed");
					const chat = await cli([
						"chat",
						"-p",
						task,
						"-c",
						conversation,
						"--no-repo-context",
						"--json",
					]);
					row.wallMs = chat.wallMs;
					row.runId = chat.value.homeRunId;
					await writeFile(
						join(values.out, `${round}-${f.id}-chat.json`),
						JSON.stringify(chat.value, null, 2),
					);
					// Trace and child-tree reads are outside this eval's correctness contract.
					const readback = (await cli(["run", row.runId, "--json"])).value;
					const metadata = unwrap(readback).run.metadata;
					const inspected = {
						run: readback,
						summary: {
							assistantText:
								metadata.kernelRoute?.answer ??
								metadata.bodyExecutionResult?.summary ??
								"",
						},
					};
					await writeFile(
						join(values.out, `${round}-${f.id}-inspect.json`),
						JSON.stringify(inspected, null, 2),
					);
					const run = unwrap(inspected.run).run;
					const m = run.metadata;
					Object.assign(row, phases(m, run.completedAt), {
						isolate: m.kernelTurnTimings?.isolate?.tag,
						status: run.status,
						model: m.bodyExecutionResult?.usage?.model ?? null,
					});
					if (f.kind) {
						const listed = await code(
							`return await os.list_os_outputs(${JSON.stringify({ workspaceId: workspace.id, status: "active", limit: 200 })});`,
						);
						const matches = (listed.items ?? []).filter(
							(o) => o.title === title && o.kind === f.kind,
						);
						if (listed.truncated || matches.length > 1)
							throw new Error("Output lookup is ambiguous or truncated");
						const output = matches[0];
						if (!output)
							throw new Error(
								`No ${f.kind} with exact title in scratch workspace (run ${run.status})`,
							);
						const detail = await code(
							`return await os.get_os_output(${JSON.stringify({ outputId: output.id })});`,
						);
						await writeFile(
							join(values.out, `${round}-${f.id}-output.json`),
							JSON.stringify(detail, null, 2),
						);
						checkOutput(f, detail, target);
						outputs.set(f.id, {
							...output,
							revision: detail.currentRevision?.revision,
						});
						row.outputId = output.id;
					} else {
						const answer = (
							inspected.summary?.assistantText ?? ""
						).toLowerCase();
						if (
							run.status !== "completed" ||
							m.kernelRoute?.routeKind !== "answer_in_home" ||
							!f.topic.every((options) =>
								options.some((s) => answer.includes(s)),
							)
						)
							throw new Error("Answer failed on-topic checks");
					}
					row.ok = true;
				} catch (error) {
					row.ok = false;
					row.error = String(error);
				}
				await writeFile(
					join(values.out, "results.json"),
					JSON.stringify(
						{
							label: values.label,
							workspaceId: workspace.id,
							rows,
							summary: summarize(rows),
						},
						null,
						2,
					),
				);
				console.log(JSON.stringify(row));
			}
		}
	} finally {
		finishMeasurements();
		try {
			await archiveScratch();
		} finally {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
		}
	}
	console.log(JSON.stringify(summarize(rows), null, 2));
	if (!interrupted && rows.some((r) => !r.ok)) process.exitCode = 1;
}
if (import.meta.main) await main();
