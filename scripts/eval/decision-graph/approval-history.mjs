import { codeModeLiteral } from "@tedix/api-contract/utils/code-mode-literal";

function row(source, record) {
	const work = source === "workApprovals",
		p = work ? record.proposal : record;
	const id = `${work ? "work-approval" : "approval"}:${p.id}`;
	return {
		request: {
			id,
			kind: "approval",
			subject: work ? record.workItem.title : p.description,
			prompt: work ? p.requestRationale : p.description,
			creatorType: work ? p.requestedByType : "tedi",
			creatorId: work ? p.requestedById : p.tediId,
			workItemId: work ? p.workItemId : null,
			requestedAt: work ? p.requestedAt : p.createdAt,
			dueAt: null,
			expiresAt: p.expiresAt ?? null,
			metadata: {
				approvalOperation: work ? p.action : p.actionType,
				approvalTarget: p.id,
				riskLevel: work ? record.workItem.riskLevel : p.riskLevel,
			},
		},
		effectiveState:
			(work ? record.effectiveStatus : p.status) === "pending"
				? "open"
				: "resolved",
		workItem: work ? record.workItem : null,
		sourceRecord: record,
	};
}

/** Read only the caller's Work and runtime approval histories, never the org audit. */
export async function approvalHistory({
	read,
	workTool,
	runtimeTool,
	cutoff,
	maxPages,
	checkpoint,
	currentIds = [],
}) {
	const initialCoverage = () => ({
		complete: false,
		pages: 0,
		rows: 0,
		unstableInventory: false,
	});
	const rows = [],
		seen = new Set(),
		coverage = {
			workApprovals: initialCoverage(),
			runtimeApprovals: initialCoverage(),
		};
	for (const source of ["workApprovals", "runtimeApprovals"]) {
		const work = source === "workApprovals",
			tool = work ? workTool : runtimeTool;
		const status = coverage[source];
		let cursor,
			offset = 0,
			total;
		const cursors = new Set();
		for (let i = 0; i < maxPages; i++) {
			const input = work
				? { limit: 1, ...(cursor ? { cursor } : {}) }
				: { limit: 1, offset, decidableOnly: true };
			const projection = work
				? "data:r.data.map(({proposal,workItem,effectiveStatus,decision})=>({proposal:{...proposal,proposal:undefined},workItem:{id:workItem.id,title:workItem.title,riskLevel:workItem.riskLevel,disposition:workItem.disposition,projectId:workItem.projectId},effectiveStatus,decision:decision?{...decision,rationale:undefined}:null})),hasMore:r.hasMore,nextCursor:r.nextCursor"
				: "data:r.data.map(p=>({id:p.id,tediId:p.tediId,description:p.description,actionType:p.actionType,status:p.status,createdAt:p.createdAt,expiresAt:p.expiresAt,resolvedAt:p.resolvedAt,resolvedBy:p.resolvedBy,resolution:p.resolution,riskLevel:p.payload.riskLevel??null})),pagination:r.pagination";
			const page = await read(
				`const r=await ${tool}(${codeModeLiteral(input)});return {${projection}};`,
			);
			const hasMore = work ? page.hasMore : page.pagination?.hasMore;
			if (!Array.isArray(page.data) || typeof hasMore !== "boolean")
				throw new Error("Malformed approval history page");
			status.pages++;
			if (!work) {
				if (total !== undefined && total !== page.pagination.total)
					status.unstableInventory = true;
				total = page.pagination.total;
			}
			const normalized = page.data.map((record) => row(source, record));
			for (const r of normalized)
				if (!seen.has(r.request.id)) {
					seen.add(r.request.id);
					rows.push(r);
					status.rows++;
				}
			const reachedCutoff =
				normalized.length > 0 &&
				normalized.every((r) => r.request.requestedAt < cutoff) &&
				currentIds
					.filter((id) => id.startsWith(work ? "work-approval:" : "approval:"))
					.every((id) => seen.has(id));
			if (!hasMore || reachedCutoff)
				status.complete = !status.unstableInventory;
			await checkpoint({ rows, coverage });
			if (!hasMore || reachedCutoff) break;
			if (work) {
				const key = JSON.stringify(page.nextCursor);
				if (!page.nextCursor || cursors.has(key))
					throw new Error("Approval history cursor missing or repeated");
				cursor = page.nextCursor;
				cursors.add(key);
			} else {
				const next = page.pagination.offset + page.pagination.limit;
				if (!page.data.length || next <= offset)
					throw new Error("Approval history offset did not advance");
				offset = next;
			}
		}
	}
	return { rows, coverage };
}
