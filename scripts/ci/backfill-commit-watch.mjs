// One-time cleanup through the governed Work API. First save a dry-run plan,
// then apply that exact plan; changed rows and newly ineligible rows are skipped.
// bun scripts/ci/backfill-commit-watch.mjs --organization <org> --workspace connect --project <uuid> --plan <path> [--apply]
import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const open = (row) => ["proposed", "accepted"].includes(row.disposition);
const observer = (row) => row.metadata?.repositoryObserver === 1;

export function settlementReason(row, rows, now) {
	if (
		!observer(row) ||
		!open(row) ||
		row.metadata.event?.kind !== "push" ||
		row.activeAttempt
	)
		return null;
	const report = row.metadata.latestReport ?? row.metadata.report;
	if (report) return "push observation reported; diagnosis retained";
	if (!(Date.parse(row.createdAt) < Date.parse(now) - 24 * 3600000))
		return null;
	const event = row.metadata.event;
	if (!event.repository || !event.branch || !event.sha) return null;
	if (
		rows.some(
			(red) =>
				observer(red) &&
				open(red) &&
				red.orgId === row.orgId &&
				red.projectId === row.projectId &&
				["ship_red", "ci_red"].includes(red.metadata.event?.kind) &&
				["repository", "branch", "sha"].every(
					(key) => red.metadata.event[key] === event[key],
				),
		)
	)
		return null;
	return "no action needed: push observation older than 24 hours with no open red follow-up";
}

export function listWorkProgram(projectId, disposition, offset) {
	return `async () => { const p = await work.list_work_items(${codeModeLiteral({ projectId, disposition, limit: 100, offset })}); return {data:p.data.map(r=>({id:r.id,orgId:r.orgId,projectId:r.projectId,title:r.title,version:r.version,createdAt:r.createdAt,disposition:r.disposition,activeAttempt:r.activeAttempt,metadata:{repositoryObserver:r.metadata?.repositoryObserver,event:r.metadata?.event && {kind:r.metadata.event.kind,repository:r.metadata.event.repository,branch:r.metadata.event.branch,sha:r.metadata.event.sha},report:r.metadata?.report,latestReport:r.metadata?.latestReport}})),hasMore:p.pagination.hasMore}; }`;
}

export function cancelWorkProgram(row) {
	return `async () => { const {workItem:r}=await work.get_work_items_by_id({id:${codeModeLiteral(row.id)}}); if(r.version!==${codeModeLiteral(row.version)} || !['proposed','accepted'].includes(r.disposition)) return {id:r.id,status:'changed'}; const closed=await ceo.cancel_work_item(${codeModeLiteral({ id: row.id, reason: row.reason })}); return {id:closed.id,status:closed.disposition}; }`;
}

async function main() {
	const { values } = parseArgs({
		options: {
			organization: { type: "string" },
			workspace: { type: "string" },
			project: { type: "string" },
			plan: { type: "string" },
			apply: { type: "boolean", default: false },
		},
	});
	for (const key of ["organization", "workspace", "project", "plan"])
		if (!values[key]) throw new Error(`Missing --${key}`);
	const execute = promisify(execFile);
	async function code(source) {
		const { stdout } = await execute(
			"tedix",
			[
				"--organization",
				values.organization,
				"--workspace",
				values.workspace,
				"code",
				source,
				"--json",
			],
			{ cwd: homedir(), maxBuffer: 16 * 1024 * 1024 },
		);
		return JSON.parse(stdout);
	}
	const rows = [];
	for (const disposition of ["proposed", "accepted"]) {
		for (let offset = 0; ; offset += 100) {
			const page = await code(
				listWorkProgram(values.project, disposition, offset),
			);
			rows.push(...page.data);
			if (!page.hasMore) break;
		}
	}
	const now = new Date().toISOString();
	const candidates = rows.flatMap((row) => {
		const reason = settlementReason(row, rows, now);
		return reason ? [{ id: row.id, version: row.version, reason }] : [];
	});
	const scope = {
		organization: values.organization,
		workspace: values.workspace,
		project: values.project,
	};
	if (!values.apply) {
		await writeFile(
			values.plan,
			JSON.stringify({ ...scope, now, candidates }, null, 2),
			{ flag: "wx", mode: 0o600 },
		);
		console.log(
			JSON.stringify({
				mode: "dry-run",
				...scope,
				now,
				scanned: rows.length,
				candidates,
			}),
		);
		return;
	}
	const plan = JSON.parse(await readFile(values.plan, "utf8"));
	for (const key of Object.keys(scope))
		if (plan[key] !== scope[key])
			throw new Error(`Plan scope mismatch: ${key}`);
	const eligible = candidates.filter((r) =>
		plan.candidates.some((p) => p.id === r.id && p.version === r.version),
	);
	for (const row of eligible) {
		// Re-read version immediately before cancellation. The Work API also fences
		// cancellation against any live Attempt and concurrent lifecycle writes.
		const result = await code(cancelWorkProgram(row));
		console.log(JSON.stringify(result));
	}
	console.log(
		JSON.stringify({
			mode: "apply",
			planned: plan.candidates.length,
			eligible: eligible.length,
		}),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	await main();
