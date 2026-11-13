/**
 * Local fixture handlers: Workspace, resource, schedule, preference and
 * unread procedures.
 */

import type {
	OsGadget,
	OsGadgetExecution,
	OsGadgetRevision,
	OsWorkspace,
	OsWorkspacePreference,
	OsWorkspaceProject,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	emptyUnreadState,
	fid,
	nextId,
	now,
	ORG_ID,
	RpcError,
	RUN_CHURN_FAILED,
	RUN_REVENUE_OK,
	SKILL_CHURN,
	SKILL_REVENUE,
	T1,
	T2,
	T3,
	WORKSPACE_REVENUE,
} from "./core";
import {
	createLocalWorkspace,
	findConversation,
	findWorkspace,
	localBlueprintUpgradeReport,
} from "./lookups";
import { localShareLinks } from "./sharing";
import { state } from "./state";
import { FIXTURE_SCHEDULED_SKILLS, fixtureSkillLinks, SKILLS } from "./tedis";
import { localProject } from "./work";

export const workspaceHandlers: Record<string, (input: never) => unknown> = {
	// Sample data has one signed-in person, so nothing is ever unread.
	"workspaceUnread/summary": () => ({ total: 0, workspaces: [] }),
	"workspaceUnread/list": () => ({ total: 0, groups: [] }),
	"workspaceUnread/workspace": (input: { workspaceId: string }) =>
		emptyUnreadState(input.workspaceId),
	"workspaceUnread/markRead": (input: { workspaceId: string }) =>
		emptyUnreadState(input.workspaceId),
	"workspaceUnread/markAllRead": () => ({ ok: true }),
	"workspaceUnread/notifyChat": () => ({ status: "none", notified: 0 }),

	// --- Tedix OS workspaces ---
	"osWorkspaces/workspaces/activity": (input: {
		workspaceId?: string;
		kinds?: Array<"output" | "run" | "artifact" | "memory" | "chat">;
		limit?: number;
		before?: string;
	}) => {
		// This local projection models saved output revisions, without connected sources.
		const rows = state.outputRevisions
			.flatMap((revision, index) => {
				const output = state.outputs.find(
					(row) => row.id === revision.outputId,
				);
				if (
					!output ||
					revision.accessEnvelope?.sources.length ||
					(input.workspaceId && output.workspaceId !== input.workspaceId) ||
					(input.kinds?.length && !input.kinds.includes("output"))
				)
					return [];
				return [
					{
						id: revision.id,
						workspaceId: output.workspaceId,
						seq: index + 1,
						kind: "output" as const,
						entityId: output.id,
						revision: revision.revision,
						actor: { kind: revision.createdByKind, id: revision.createdById },
						changeRecordId: revision.id,
						artifact: { outputId: output.id, revisionId: revision.id },
						title: output.title,
						summary: revision.note,
						occurredAt: revision.createdAt,
					},
				];
			})
			.sort(
				(a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.seq - a.seq,
			);
		const separator = input.before?.lastIndexOf("|") ?? -1;
		const seq = Number(input.before?.slice(separator + 1));
		const occurredAt = input.before?.slice(0, separator);
		const filtered =
			separator > 0 && Number.isInteger(seq) && occurredAt
				? rows.filter(
						(row) =>
							row.occurredAt < occurredAt ||
							(row.occurredAt === occurredAt && row.seq < seq),
					)
				: rows;
		const limit = input.limit ?? 50,
			items = filtered.slice(0, limit),
			last = items.at(-1);
		return {
			items,
			coverage: "recorded_only" as const,
			next:
				filtered.length > limit && last
					? `${last.occurredAt}|${last.seq}`
					: null,
		};
	},
	"osWorkspaces/workspaces/list": (
		input:
			| { status?: OsWorkspace["status"]; limit?: number; offset?: number }
			| undefined,
	) => {
		const rows = state.workspaces
			.filter(
				(row) => input?.status === undefined || row.status === input.status,
			)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		const offset = input?.offset ?? 0;
		const limit = input?.limit ?? 50;
		return {
			items: rows.slice(offset, offset + limit),
			truncated: rows.length > offset + limit,
		};
	},
	"osWorkspaces/workspaces/create": createLocalWorkspace,
	"osWorkspaces/workspaces/createFromConversation": (input: {
		conversationId: string;
		name: string;
		description?: string;
	}) => {
		const conversation = findConversation(input.conversationId);
		if (conversation.workspaceId) {
			throw new RpcError(
				"CONFLICT",
				"This conversation already belongs to a workspace",
			);
		}
		const { workspace } = createLocalWorkspace({
			name: input.name,
			description: input.description,
			visibility: "private",
		});
		conversation.workspaceId = workspace.id;
		conversation.updatedAt = now();
		return { workspace, movedOutputIds: [] };
	},
	"osWorkspaces/workspaces/get": (input: { workspaceId: string }) => ({
		workspace: findWorkspace(input.workspaceId),
		url: `${globalThis.location?.origin ?? "http://localhost:5173"}/workspace/${input.workspaceId}`,
	}),
	"osWorkspaces/workspaces/previewBlueprintUpgrade": (input: {
		workspaceId: string;
		candidateRevisionId?: string;
	}) => ({ report: localBlueprintUpgradeReport(input).report }),
	"osWorkspaces/workspaces/decideBlueprintUpgrade": (input: {
		workspaceId: string;
		decision: "apply" | "stay_pinned";
		candidateRevisionId: string;
		reason?: string;
	}) => {
		const { workspace, candidate, report } = localBlueprintUpgradeReport(input);
		const decidedAt = now();
		if (input.decision === "apply" && !report.upToDate) {
			for (const change of report.gadgetChanges) {
				const declared = candidate.definition.gadgets.find(
					(row) => row.name === change.name,
				);
				const existing = state.gadgets.find(
					(row) =>
						row.workspaceId === workspace.id &&
						row.name === change.name &&
						row.status === "active",
				);
				if (change.change === "removed" && existing) {
					existing.status = "archived";
					existing.updatedAt = decidedAt;
				}
				if (
					!declared ||
					change.change === "unchanged" ||
					change.change === "removed"
				)
					continue;
				const gadget: OsGadget = existing ?? {
					id: nextId(),
					organizationId: ORG_ID,
					workspaceId: workspace.id,
					name: declared.name,
					description: null,
					status: "active",
					currentRevisionId: null,
					sourceBlueprintRevisionId: candidate.id,
					createdByKind: "user",
					createdById: "dev-operator",
					createdAt: decidedAt,
					updatedAt: decidedAt,
				};
				if (!existing) state.gadgets.push(gadget);
				const revision: OsGadgetRevision = {
					id: nextId(),
					organizationId: ORG_ID,
					gadgetId: gadget.id,
					revision:
						state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id)
							.length + 1,
					manifest: declared.manifest,
					sourceArtifactRef: null,
					createdByKind: "user",
					createdById: "dev-operator",
					createdAt: decidedAt,
				};
				state.gadgetRevisions.push(revision);
				gadget.currentRevisionId = revision.id;
				gadget.sourceBlueprintRevisionId = candidate.id;
				gadget.updatedAt = decidedAt;
			}
			workspace.rollbackReference = {
				revisionId: report.pinnedRevisionId,
				revision: report.pinnedRevision,
				preflight: workspace.instantiationPreflight,
			};
			workspace.sourceBlueprintRevisionId = candidate.id;
			workspace.sourceBlueprintRevisionNumber = candidate.revision;
			workspace.instantiationPreflight = report.candidatePreflightNow;
		}
		const decision = {
			version: 1 as const,
			decision:
				input.decision === "apply"
					? ("applied" as const)
					: ("stay_pinned" as const),
			decidedAt,
			decidedByKind: "user" as const,
			reviewedRevisionId: candidate.id,
			reviewedRevision: candidate.revision,
			pinnedRevisionId: workspace.sourceBlueprintRevisionId!,
			pinnedRevision: workspace.sourceBlueprintRevisionNumber!,
			reason: input.reason ?? null,
			summary: {
				candidateStatus: report.candidatePreflightNow.status,
				applyAllowed: report.applyAllowed,
				requirementsChanged: 0,
				gadgetsAdded: report.gadgetChanges.filter(
					(row) => row.change === "added",
				).length,
				gadgetsChanged: report.gadgetChanges.filter(
					(row) => row.change === "changed",
				).length,
				gadgetsRemoved: report.gadgetChanges.filter(
					(row) => row.change === "removed",
				).length,
				blockingReasons: [],
				consentReasons: [],
				resolvedAt: report.resolvedAt,
			},
		};
		workspace.blueprintDecision = decision;
		workspace.updatedAt = decidedAt;
		return { workspace, report, decision };
	},
	"osWorkspaces/workspaces/update": (input: {
		workspaceId: string;
		name?: string;
		description?: string | null;
	}) => {
		const workspace = findWorkspace(input.workspaceId);
		if (input.name !== undefined) workspace.name = input.name;
		if (input.description !== undefined) {
			workspace.description = input.description;
		}
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspaces/setIcon": (input: {
		workspaceId: string;
		contentType: string;
		fileData: string;
	}) => {
		const workspace = findWorkspace(input.workspaceId);
		workspace.iconUrl = `data:${input.contentType};base64,${input.fileData}`;
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspaces/removeIcon": (input: { workspaceId: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		workspace.iconUrl = null;
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspaces/archive": (input: { workspaceId: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		workspace.status = "archived";
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspaces/restore": (input: { workspaceId: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		workspace.status = "active";
		workspace.updatedAt = now();
		return { workspace };
	},
	// Mirrors the API's refusals; outputs keep their workspace id, apps go.
	"osWorkspaces/workspaces/delete": (input: { workspaceId: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		if (workspace.status !== "archived")
			throw new RpcError(
				"BAD_REQUEST",
				"Archive this workspace before you delete it permanently.",
			);
		if (
			state.collaborationProposals.some(
				(row) => row.workspaceId === workspace.id,
			)
		)
			throw new RpcError(
				"BAD_REQUEST",
				"Agents suggested changes to documents or apps in this workspace. Tedix keeps those suggestions as a record of who changed what, so this workspace can't be deleted. Keep it archived: it stays hidden from Workspaces.",
			);
		if (
			(localShareLinks.get(`workspace:${workspace.id}`) ?? []).some(
				(link) => link.revokedAt === null,
			)
		)
			throw new RpcError(
				"BAD_REQUEST",
				"This workspace still has share links. Turn them off, then delete it.",
			);
		state.workspaces = state.workspaces.filter(
			(row) => row.id !== workspace.id,
		);
		state.gadgets = state.gadgets.filter(
			(row) => row.workspaceId !== workspace.id,
		);
		return { deleted: true as const };
	},
	"osWorkspaces/workspacePreferences/list": () => ({
		items: [...state.workspacePreferences],
	}),
	"osWorkspaces/workspacePreferences/setFavorite": (input: {
		workspaceId: string;
		favorite: boolean;
	}) => {
		findWorkspace(input.workspaceId);
		const current = state.workspacePreferences.find(
			(row) => row.workspaceId === input.workspaceId,
		);
		const preference: OsWorkspacePreference = {
			workspaceId: input.workspaceId,
			favorite: input.favorite,
			lastOpenedAt: current?.lastOpenedAt ?? null,
			updatedAt: now(),
		};
		if (current) Object.assign(current, preference);
		else state.workspacePreferences.push(preference);
		return { preference };
	},
	"osWorkspaces/workspacePreferences/touch": (input: {
		workspaceId: string;
	}) => {
		findWorkspace(input.workspaceId);
		const current = state.workspacePreferences.find(
			(row) => row.workspaceId === input.workspaceId,
		);
		const timestamp = now();
		const preference: OsWorkspacePreference = {
			workspaceId: input.workspaceId,
			favorite: current?.favorite ?? false,
			lastOpenedAt: timestamp,
			updatedAt: timestamp,
		};
		if (current) Object.assign(current, preference);
		else state.workspacePreferences.push(preference);
		return { preference };
	},
	"osWorkspaces/resources/list": (input: {
		workspaceId: string;
		status?: OsWorkspaceResource["status"];
		limit?: number;
	}) => ({
		items: state.workspaceResources.filter(
			(resource) =>
				resource.workspaceId === input.workspaceId &&
				(input.status === undefined || resource.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/resources/create": (input: {
		workspaceId: string;
		selection: Omit<
			OsWorkspaceResource,
			| "id"
			| "organizationId"
			| "workspaceId"
			| "slot"
			| "status"
			| "createdByKind"
			| "createdById"
			| "createdAt"
			| "updatedAt"
			| "removedAt"
		>;
	}) => {
		findWorkspace(input.workspaceId);
		const timestamp = now();
		const resource: OsWorkspaceResource = {
			...input.selection,
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			slot: null,
			status: "active",
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: timestamp,
			updatedAt: timestamp,
			removedAt: null,
		};
		state.workspaceResources.push(resource);
		return { resource };
	},
	"osWorkspaces/resources/get": (input: {
		workspaceId: string;
		resourceId: string;
	}) => {
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === input.workspaceId && row.id === input.resourceId,
		);
		if (!resource)
			throw new RpcError("NOT_FOUND", "Workspace resource not found");
		return { resource };
	},
	"osWorkspaces/resources/rename": (input: {
		workspaceId: string;
		resourceId: string;
		name: string;
		expectedUpdatedAt: string;
	}) => {
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === input.workspaceId && row.id === input.resourceId,
		);
		if (!resource)
			throw new RpcError("NOT_FOUND", "Workspace resource not found");
		if (resource.updatedAt !== input.expectedUpdatedAt) {
			throw new RpcError("CONFLICT", "Workspace resource changed concurrently");
		}
		resource.name = input.name;
		resource.updatedAt = now();
		return { resource };
	},
	"osWorkspaces/resources/remove": (input: {
		workspaceId: string;
		resourceId: string;
		expectedUpdatedAt: string;
	}) => {
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === input.workspaceId && row.id === input.resourceId,
		);
		if (!resource)
			throw new RpcError("NOT_FOUND", "Workspace resource not found");
		if (resource.updatedAt !== input.expectedUpdatedAt) {
			throw new RpcError("CONFLICT", "Workspace resource changed concurrently");
		}
		resource.status = "removed";
		resource.removedAt = now();
		resource.updatedAt = resource.removedAt;
		return { resource };
	},
	"osWorkspaces/schedules/list": (input: { workspaceId: string }) => {
		findWorkspace(input.workspaceId);
		const links = fixtureSkillLinks(input.workspaceId);
		const linkedOnly = [...links.added].flatMap((skillId) => {
			const skill = SKILLS.find((row) => row.id === skillId);
			return skill
				? [
						{
							resourceId: fid("35", SKILLS.indexOf(skill) + 1),
							skillId,
							name: skill.title,
							purpose: skill.description ?? null,
							enabled: false,
							cron: null,
							dailyTimes: [],
							nextRunAt: null,
							lastRun: null,
							personalRead: null,
							tediName: "Operations Tedi",
							hasWorkflow: false,
						},
					]
				: [];
		});
		if (input.workspaceId !== WORKSPACE_REVENUE) return { items: linkedOnly };
		// The next 07:30 UTC, so the daily time reads in the viewer's clock.
		const next = new Date();
		next.setUTCHours(7, 30, 0, 0);
		if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
		return {
			items: [
				...[
					{
						resourceId: fid("34", 1),
						skillId: SKILL_REVENUE,
						name: "Weekly revenue report",
						purpose: "Sums last week's invoices into the revenue sheet.",
						enabled: true,
						cron: "30 7 * * *",
						dailyTimes: [next.toISOString()],
						nextRunAt: next.toISOString(),
						lastRun: {
							runId: RUN_REVENUE_OK,
							status: "completed" as const,
							startedAt: T1,
							completedAt: T2,
							cards: null,
							summary: "Added 12 invoices",
							error: null,
						},
						personalRead: null,
						tediName: "Finance Tedi",
						hasWorkflow: true,
					},
					{
						resourceId: fid("34", 2),
						skillId: SKILL_CHURN,
						name: "Churn watch",
						purpose: "Flags accounts that stopped logging in.",
						enabled: true,
						cron: "0 9 * * 1",
						dailyTimes: [],
						nextRunAt: next.toISOString(),
						lastRun: {
							runId: RUN_CHURN_FAILED,
							status: "failed" as const,
							startedAt: T2,
							completedAt: T3,
							cards: null,
							summary: null,
							error: "MCP call crm.list_accounts timed out after 15s",
						},
						personalRead: {
							providerId: "google-gmail",
							providerName: "Gmail",
							toolIds: ["search_threads"],
							grantId: null,
							level: "none",
							canAllow: true,
						},
						tediName: "Customer Tedi",
						hasWorkflow: false,
					},
				].filter((item) => !links.removed.has(item.skillId)),
				...linkedOnly,
			],
		};
	},
	"osWorkspaces/schedules/link": (input: {
		workspaceId: string;
		skillId: string;
	}) => {
		findWorkspace(input.workspaceId);
		if (!SKILLS.some((skill) => skill.id === input.skillId))
			throw new RpcError(
				"NOT_FOUND",
				"No skill with that id in this organization",
			);
		const links = fixtureSkillLinks(input.workspaceId);
		const created =
			links.removed.delete(input.skillId) ||
			(!FIXTURE_SCHEDULED_SKILLS.has(input.skillId) &&
				!links.added.has(input.skillId));
		if (!FIXTURE_SCHEDULED_SKILLS.has(input.skillId))
			links.added.add(input.skillId);
		return { resourceId: fid("35", 99), created };
	},
	"osWorkspaces/schedules/unlink": (input: {
		workspaceId: string;
		skillId: string;
	}) => {
		findWorkspace(input.workspaceId);
		const links = fixtureSkillLinks(input.workspaceId);
		const removed =
			links.added.delete(input.skillId) ||
			(FIXTURE_SCHEDULED_SKILLS.has(input.skillId) &&
				input.workspaceId === WORKSPACE_REVENUE &&
				!links.removed.has(input.skillId) &&
				Boolean(links.removed.add(input.skillId)));
		return { removed };
	},
	"osWorkspaces/schedules/linkFactorySkills": (input: {
		workspaceId: string;
		dryRun?: boolean;
	}) => {
		findWorkspace(input.workspaceId);
		const links = fixtureSkillLinks(input.workspaceId);
		const dryRun = input.dryRun ?? true;
		// The fixture's suggestion: the first catalog skill this workspace does not run.
		const skill = SKILLS.find((row) => !FIXTURE_SCHEDULED_SKILLS.has(row.id));
		if (!skill)
			return { dryRun, items: [], linkedTedis: 0, linkedConnections: 0 };
		const already = links.added.has(skill.id);
		if (!dryRun) links.added.add(skill.id);
		return {
			dryRun,
			linkedTedis: 0,
			linkedConnections: 0,
			items: [
				{
					skillId: skill.id,
					name: skill.title,
					reason: "wrote_outputs" as const,
					status: already
						? ("already_linked" as const)
						: dryRun
							? ("would_link" as const)
							: ("linked" as const),
				},
			],
		};
	},
	// The fixture viewer has no connected account, so the button leads to
	// Settings → Connections.
	"osWorkspaces/schedules/allowPersonalRead": (input: {
		workspaceId: string;
		resourceId: string;
	}) => {
		findWorkspace(input.workspaceId);
		return { status: "not_connected" as const, providerId: "google-gmail" };
	},
	"osWorkspaces/executions/list": (input: {
		workspaceId: string;
		gadgetId: string;
		status?: OsGadgetExecution["status"];
	}) => ({
		items: state.executions.filter(
			(row) =>
				row.gadgetId === input.gadgetId &&
				row.workspaceId === input.workspaceId &&
				(input.status === undefined || row.status === input.status),
		),
		truncated: false,
	}),

	// --- Workspace Work project links ---
	"osWorkspaces/work/listProjects": (input: {
		workspaceId: string;
		status?: OsWorkspaceProject["status"];
		limit?: number;
	}) => ({
		items: state.workspaceProjects
			.filter(
				(row) =>
					row.workspaceId === input.workspaceId &&
					(input.status === undefined || row.status === input.status),
			)
			.slice(0, input.limit ?? 100),
		truncated: false,
	}),
	"osWorkspaces/work/attachProject": (input: {
		workspaceId: string;
		projectId: string;
	}) => {
		findWorkspace(input.workspaceId);
		localProject(input.projectId);
		const existing = state.workspaceProjects.find(
			(row) =>
				row.workspaceId === input.workspaceId &&
				row.projectId === input.projectId,
		);
		if (existing) {
			existing.status = "active";
			existing.removedAt = null;
			existing.updatedAt = now();
			return { link: existing };
		}
		const link: OsWorkspaceProject = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			projectId: input.projectId,
			status: "active",
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			updatedAt: now(),
			removedAt: null,
		};
		state.workspaceProjects.push(link);
		return { link };
	},
	"osWorkspaces/work/removeProject": (input: {
		workspaceId: string;
		projectId: string;
		expectedUpdatedAt: string;
	}) => {
		const link = state.workspaceProjects.find(
			(row) =>
				row.workspaceId === input.workspaceId &&
				row.projectId === input.projectId &&
				row.status === "active",
		);
		if (!link)
			throw new RpcError("NOT_FOUND", "Workspace project link not found");
		if (link.updatedAt !== input.expectedUpdatedAt)
			throw new RpcError("CONFLICT", "Workspace project link changed");
		link.status = "removed";
		link.removedAt = now();
		link.updatedAt = now();
		return { link };
	},
};
