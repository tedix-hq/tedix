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
		/* Older clients used a timestamp and sequence pair. */
	}
	const separator = value.lastIndexOf("|");
	const seq = Number(value.slice(separator + 1));
	return separator > 0 && Number.isSafeInteger(seq) && seq > 0
		? { occurredAt: value.slice(0, separator), seq }
		: undefined;
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
		// Bound database scans and downstream source authorization independently.
		const scanLimit = Math.min(input.limit, 5);
		const rows = await listWorkspaceActivity(
			queryDb(context),
			{ organizationId, viewer: await resolveOsWorkspaceViewer(context) },
			{
				workspaceId: input.workspaceId,
				kinds: input.kinds,
				limit: scanLimit + 1,
				before: decodeCursor(input.before),
			},
		);
		const items: WorkspaceActivityItem[] = [];
		const budget = { sources: 50, exhausted: false };
		let examined = 0;
		for (const row of rows.slice(0, scanLimit)) {
			const item = await visibleWorkspaceActivity(context, row, budget);
			if (budget.exhausted) break;
			examined += 1;
			if (item) items.push(item);
		}
		const last = rows[examined - 1];
		return {
			items,
			coverage: "recorded_only" as const,
			next: rows.length > examined && last ? encodeCursor(last) : null,
		};
	},
);

export const osWorkspaceActivityProcedures = { activity };
