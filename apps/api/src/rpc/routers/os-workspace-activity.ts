/**
 * Org-level recent activity, read from the workspace change projection.
 * Nothing here lists a workspace object.
 */

import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type WorkspaceActivityItem,
	workspaceIdOfFeedScope,
} from "@tedix/api-contract/schemas/workspace-feed";
import {
	listWorkspaceActivity,
	type WorkspaceActivityCursor,
} from "@tedix/db/queries/workspace-feed/read";
import type { WorkspaceActivityRow } from "@tedix/db/schema/workspace-feed";
import { requireOrgId } from "../org-scope";
import { AUTHZ, type BaseContext, withAuth } from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import { resolveOsWorkspaceViewer } from "../../services/os-workspace-visibility";
import { queryDb } from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const readOs = os
	.use(withAuth)
	.use(osAudit(OS_WORKSPACES_AUDIT))
	.use(AUTHZ.osRead);

function encodeCursor(row: WorkspaceActivityRow): string {
	return `${row.occurredAt}|${row.seq}`;
}

function decodeCursor(
	value: string | undefined,
): WorkspaceActivityCursor | undefined {
	if (!value) return undefined;
	const separator = value.lastIndexOf("|");
	if (separator <= 0) return undefined;
	const seq = Number(value.slice(separator + 1));
	if (!Number.isInteger(seq)) return undefined;
	return { occurredAt: value.slice(0, separator), seq };
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

const activity = readOs.workspaces.activity.handler(
	async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const rows = await listWorkspaceActivity(
			queryDb(context),
			{ organizationId, viewer: await resolveOsWorkspaceViewer(context) },
			{
				workspaceId: input.workspaceId,
				kinds: input.kinds,
				limit: input.limit + 1,
				before: decodeCursor(input.before),
			},
		);
		const page = rows.slice(0, input.limit);
		const last = page[page.length - 1];
		return {
			items: page.map(mapWorkspaceActivityRow),
			next: rows.length > input.limit && last ? encodeCursor(last) : null,
		};
	},
);

export const osWorkspaceActivityProcedures = { activity };
