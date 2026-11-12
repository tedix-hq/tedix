/**
 * Org-level recent activity, read from the workspace change projection.
 * Nothing here lists a workspace object.
 */

import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type WorkspaceActivityItem,
	WorkspaceChangeSummarySchema,
	workspaceIdOfFeedScope,
} from "@tedix/api-contract/schemas/workspace-feed";
import {
	listWorkspaceActivity,
	getWorkspaceActivitySource,
	getWorkspaceOutputIndexCurrent,
	getWorkspaceOutputIndexRevision,
	type WorkspaceActivityCursor,
} from "@tedix/db/queries/workspace-feed/read";
import type { WorkspaceActivityRow } from "@tedix/db/schema/workspace-feed";
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import { resolveOsWorkspaceViewer } from "../../services/os-workspace-visibility";
import {
	authorizeDerivedOutputSources,
	parseDerivedAccessEnvelope,
} from "../../services/os-derived-resource-access";
import { queryDb } from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const readOs = os
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osRead);

const ACTIVITY_SCAN_BATCH = 5;
const ACTIVITY_SCAN_LIMIT = 20;

function encodeCursor(row: WorkspaceActivityRow): string {
	return JSON.stringify({
		occurredAt: row.occurredAt,
		seq: row.seq,
		id: row.id,
	});
}

function decodeCursor(
	value: string | undefined,
): WorkspaceActivityCursor | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value);
		if (
			typeof parsed.occurredAt === "string" &&
			Number.isSafeInteger(parsed.seq) &&
			parsed.seq > 0 &&
			typeof parsed.id === "string"
		)
			return parsed;
	} catch {
		return undefined;
	}
	return undefined;
}

export function mapWorkspaceActivityRow(
	row: WorkspaceActivityRow,
): WorkspaceActivityItem {
	return {
		id: row.id,
		workspaceId: workspaceIdOfFeedScope(row.workspaceId),
		seq: row.seq,
		kind: row.kind,
		entityId: row.entityId,
		revision: row.revision,
		actor: { kind: row.actorKind, id: row.actorId },
		changeRecordId: row.changeRecordId,
		title: row.title,
		summary: row.summary,
		occurredAt: row.occurredAt,
	};
}

/** Hide unverifiable records rather than expose stale titles or target identifiers. */
async function visibleWorkspaceActivity(
	context: BaseContext,
	row: WorkspaceActivityRow,
	budget = { sources: 50, exhausted: false },
): Promise<WorkspaceActivityItem | null> {
	const db = queryDb(context);
	const source = await getWorkspaceActivitySource(db, row);
	if (!source) return null;
	let summary;
	try {
		summary = WorkspaceChangeSummarySchema.parse(JSON.parse(source.summary));
	} catch {
		return null;
	}
	const item = mapWorkspaceActivityRow(row);
	if (row.kind !== "output" && !(row.kind === "run" && summary.action))
		return null;
	if (summary.action) {
		item.action = summary.action;
		item.title = null;
		item.summary = null;
	}
	const revisionId =
		row.kind === "output" ? row.changeRecordId : summary.action?.revisionId;
	if (!revisionId) return item;
	const revision = await getWorkspaceOutputIndexRevision(db, {
		organizationId: row.organizationId,
		revisionId,
	});
	if (
		!revision ||
		revision.workspaceId !== row.workspaceId ||
		(row.kind === "output" && revision.outputId !== row.entityId)
	)
		return null;
	const current = await getWorkspaceOutputIndexCurrent(db, {
		organizationId: row.organizationId,
		outputId: revision.outputId,
	});
	if (!current || current.workspaceId !== row.workspaceId) return null;
	const candidates =
		revision.revisionId === current.revisionId
			? [revision]
			: [revision, current];
	const envelopes = candidates.map((candidate) =>
		parseDerivedAccessEnvelope(candidate.accessEnvelope),
	);
	if (envelopes.some((envelope) => !envelope)) return null;
	const cost = envelopes.reduce(
		(sum, envelope) => sum + (envelope?.sources.length ?? 0),
		0,
	);
	if (cost > budget.sources) {
		budget.exhausted = true;
		return null;
	}
	budget.sources -= cost;
	for (const envelope of envelopes) {
		if (
			!envelope ||
			!(await authorizeDerivedOutputSources(context, {
				organizationId: row.organizationId,
				accessEnvelope: envelope,
			}))
		)
			return null;
	}
	item.artifact = { outputId: revision.outputId, revisionId };
	return item;
}

const activity = readOs.workspaces.activity.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const viewer = await resolveOsWorkspaceViewer(context);
		// Bound database scans and downstream source authorization independently.
		// Records the viewer may not see are skipped, so keep reading small batches
		// until the page has something to show or the scan bound is reached.
		const batchSize = Math.min(input.limit, ACTIVITY_SCAN_BATCH);
		const items: WorkspaceActivityItem[] = [];
		const budget = { sources: 50, exhausted: false };
		let cursor = decodeCursor(input.before);
		let last: WorkspaceActivityRow | undefined;
		let examined = 0;
		let more = false;
		while (examined < ACTIVITY_SCAN_LIMIT && items.length < input.limit) {
			const rows = await listWorkspaceActivity(
				queryDb(context),
				{ organizationId, viewer },
				{
					workspaceId: input.workspaceId,
					kinds: input.kinds,
					limit: batchSize + 1,
					before: cursor,
				},
			);
			let batchExamined = 0;
			for (const row of rows.slice(0, batchSize)) {
				const item = await visibleWorkspaceActivity(context, row, budget);
				if (budget.exhausted) break;
				batchExamined += 1;
				last = row;
				if (item) items.push(item);
			}
			examined += batchExamined;
			more = rows.length > batchExamined;
			if (!more || budget.exhausted || batchExamined === 0 || !last) break;
			if (items.length > 0) break;
			cursor = { occurredAt: last.occurredAt, seq: last.seq, id: last.id };
		}
		return {
			items,
			coverage: "recorded_only" as const,
			next: more && last ? encodeCursor(last) : null,
		};
	},
);

export const osWorkspaceActivityProcedures = { activity };
