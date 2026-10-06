import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import {
	acceptWorkItem,
	createWorkItem,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import { getOsWorkspaceProject } from "@tedix/db/queries/os-workspaces/projects";
import { getProjectById } from "@tedix/db/queries/projects";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import { createDbQueryClient } from "@tedix/db/query-client";
import type {
	OsWorkspaceResourceRow,
	OsWorkspaceRow,
} from "@tedix/db/schema/os-workspaces";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../rpc/orpc";
import { createError, ErrorCodes } from "../rpc/orpc";
import { resolveWorkspaceResourceAvailability } from "./os-workspace-resource-availability";

export const WORKSPACE_REPOSITORY_EXECUTION_REQUIREMENT: ExecutionRequirement =
	{
		surface: "workstation",
		requiredCapabilities: [
			"repository_read",
			"repository_edit",
			"process",
			"tests",
			"git_network",
		],
		fallbackSurface: null,
		prohibitedSurfaces: ["native", "managed_job"],
		satisfiable: true,
		reason:
			"Workspace repository work is bound to the selected tedi's repository-scoped GitHub App workstation authority",
	};

export interface WorkspaceRepositoryIdentity {
	repositoryId: number;
	fullName: string;
	installationId: number;
}

export interface PrepareWorkspaceRepositoryWorkInput {
	expectedUpdatedAt: string;
	idempotencyKey: string;
	projectId: string;
	resourceId: string;
	task: string;
	tediId: string;
	outcome: string;
	workspaceId: string;
}

export interface PreparedWorkspaceRepositoryWork {
	workItemId: string;
	dispatch: {
		content: string;
		delegateToTediId: string;
		idempotencyKey: string;
		workspaceContext: { workspaceId: string };
		metadata: {
			executionRequirement: ExecutionRequirement;
			needsEmbodiedSurface: true;
			repository: WorkspaceRepositoryIdentity & {
				providerId: "github";
				resourceId: string;
			};
			workItemId: string;
		};
	};
}

type Dependencies = {
	availability: typeof resolveWorkspaceResourceAvailability;
	getProject: typeof getProjectById;
	getProjectLink: typeof getOsWorkspaceProject;
	getTedi: typeof getTediByIdForOrganization;
	getWorkItem: typeof getWorkItemBySourceIntentId;
	createWorkItem: typeof createWorkItem;
	acceptWorkItem: typeof acceptWorkItem;
};

const defaultDependencies: Dependencies = {
	availability: resolveWorkspaceResourceAvailability,
	getProject: getProjectById,
	getProjectLink: getOsWorkspaceProject,
	getTedi: getTediByIdForOrganization,
	getWorkItem: getWorkItemBySourceIntentId,
	createWorkItem,
	acceptWorkItem,
};

function positiveSafeInteger(value: unknown): number | null {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function workspaceRepositoryIdentity(
	resource: OsWorkspaceResource,
): WorkspaceRepositoryIdentity | null {
	if (
		resource.providerId !== "github" ||
		resource.resourceType !== "repository" ||
		resource.connectionScope !== "tenant"
	) {
		return null;
	}
	const repositoryId = positiveSafeInteger(resource.providerResourceId);
	const installationId = positiveSafeInteger(
		resource.metadata.githubInstallationId,
	);
	const fullName = resource.metadata.githubFullName;
	if (
		!repositoryId ||
		!installationId ||
		typeof fullName !== "string" ||
		!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(fullName)
	) {
		return null;
	}
	return { repositoryId, fullName, installationId };
}

function githubFullName(repoUrl: string): string | null {
	try {
		const url = new URL(repoUrl);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "github.com" ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return null;
		}
		const fullName = url.pathname.replace(/^\//, "").replace(/\/$/, "");
		return /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(fullName)
			? fullName
			: null;
	} catch {
		return null;
	}
}

function dispatchResult(
	input: PrepareWorkspaceRepositoryWorkInput,
	identity: WorkspaceRepositoryIdentity,
	workItemId: string,
): PreparedWorkspaceRepositoryWork {
	return {
		workItemId,
		dispatch: {
			content: input.task,
			delegateToTediId: input.tediId,
			idempotencyKey: input.idempotencyKey,
			workspaceContext: { workspaceId: input.workspaceId },
			metadata: {
				executionRequirement: WORKSPACE_REPOSITORY_EXECUTION_REQUIREMENT,
				needsEmbodiedSurface: true,
				repository: {
					...identity,
					providerId: "github",
					resourceId: input.resourceId,
				},
				workItemId,
			},
		},
	};
}

function samePreparedIntent(
	item: WorkItem,
	input: PrepareWorkspaceRepositoryWorkInput,
	identity: WorkspaceRepositoryIdentity,
): boolean {
	const provenance = item.provenance ?? {};
	return (
		item.projectId === input.projectId &&
		item.accountableOwnerType === "tedi" &&
		item.accountableOwnerId === input.tediId &&
		item.description === input.task &&
		item.acceptanceContract?.doneLooksLike === input.outcome &&
		provenance.source === "os.workspace.repository_work" &&
		provenance.workspaceId === input.workspaceId &&
		provenance.workspaceResourceId === input.resourceId &&
		provenance.resourceUpdatedAt === input.expectedUpdatedAt &&
		provenance.githubRepositoryId === identity.repositoryId &&
		provenance.githubFullName === identity.fullName &&
		provenance.githubInstallationId === identity.installationId
	);
}

export async function prepareWorkspaceRepositoryWork(
	context: BaseContext,
	params: {
		input: PrepareWorkspaceRepositoryWorkInput;
		resourceRow: OsWorkspaceResourceRow;
		resource: OsWorkspaceResource;
		workspace: OsWorkspaceRow;
	},
	dependencies: Partial<Dependencies> = {},
): Promise<PreparedWorkspaceRepositoryWork> {
	const deps = { ...defaultDependencies, ...dependencies };
	const actorId = context.descopeUserId ?? context.user?.sub ?? null;
	if (context.authType !== "user" || !actorId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Repository work requires an interactive user",
		);
	}
	if (params.workspace.status !== "active") {
		throw createError(ErrorCodes.CONFLICT, "Workspace is not active");
	}
	if (
		params.resourceRow.status !== "active" ||
		params.resourceRow.updatedAt !== params.input.expectedUpdatedAt
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Workspace resource changed; reload before starting work",
		);
	}
	const identity = workspaceRepositoryIdentity(params.resource);
	if (!identity) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Repository work requires an organization GitHub repository resource with immutable repository and installation IDs plus an exact full name",
		);
	}
	const availability = await deps.availability(context, params.resource);
	if (availability.status !== "available") {
		throw createError(
			ErrorCodes.CONFLICT,
			availability.reason ?? "The canonical GitHub connection is unavailable",
		);
	}

	const [tedi, link, project] = await Promise.all([
		deps.getTedi(
			context.db,
			params.input.tediId,
			params.workspace.organizationId,
		),
		deps.getProjectLink(createDbQueryClient(context.env.DB), {
			organizationId: params.workspace.organizationId,
			workspaceId: params.workspace.id,
			projectId: params.input.projectId,
		}),
		deps.getProject(context.db, params.input.projectId),
	]);
	if (!tedi || tedi.status !== "active" || tedi.retiredAt) {
		throw createError(ErrorCodes.NOT_FOUND, "Eligible tedi not found");
	}
	const repo = tedi.repoConfig;
	if (
		!repo ||
		repo.githubAppEnabled !== true ||
		repo.githubRepositoryId !== identity.repositoryId ||
		repo.githubInstallationId !== identity.installationId ||
		githubFullName(repo.repoUrl) !== identity.fullName
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"The tedi's GitHub App authority does not exactly match this repository resource",
		);
	}
	if (
		!link ||
		link.status !== "active" ||
		!project ||
		project.orgId !== params.workspace.organizationId ||
		project.status !== "active"
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Repository work requires an active project linked to this Workspace",
		);
	}

	const sourceIntentId = `workspace-repository:${params.input.idempotencyKey}`;
	let item = await deps.getWorkItem(context.db, {
		orgId: params.workspace.organizationId,
		sourceIntentId,
	});
	if (!item) {
		const now = new Date().toISOString();
		try {
			item = await deps.createWorkItem(context.db, {
				id: crypto.randomUUID(),
				orgId: params.workspace.organizationId,
				title: params.input.task,
				description: params.input.task,
				workKind: "coding",
				riskLevel: "medium",
				priority: "medium",
				requiredCapabilities: [
					...WORKSPACE_REPOSITORY_EXECUTION_REQUIREMENT.requiredCapabilities,
				],
				requiredAuthorities: [
					`github:repository:${identity.repositoryId}`,
					`github:installation:${identity.installationId}`,
				],
				accountableOwnerType: "tedi",
				accountableOwnerId: params.input.tediId,
				stewardType: "user",
				stewardId: actorId,
				projectId: project.id,
				...workItemPurposeFor({
					objectiveId: project.objectiveId,
					workClass: "maintenance",
					now: new Date(now),
				}),
				sourceSessionKey: params.workspace.id,
				sourceIntentId,
				provenance: {
					source: "os.workspace.repository_work",
					workspaceId: params.workspace.id,
					workspaceResourceId: params.resource.id,
					resourceUpdatedAt: params.resource.updatedAt,
					providerId: "github",
					githubRepositoryId: identity.repositoryId,
					githubFullName: identity.fullName,
					githubInstallationId: identity.installationId,
				},
				metadata: {
					source: "os.workspace.repository_work",
					executionRequirement: WORKSPACE_REPOSITORY_EXECUTION_REQUIREMENT,
				},
				createdAt: now,
			});
		} catch (error) {
			item = await deps.getWorkItem(context.db, {
				orgId: params.workspace.organizationId,
				sourceIntentId,
			});
			if (!item) throw error;
		}
	}
	if (item.disposition === "proposed") {
		item = await deps.acceptWorkItem(context.db, {
			orgId: params.workspace.organizationId,
			workItemId: item.id,
			acceptanceContract: { version: 1, doneLooksLike: params.input.outcome },
			actor: { type: "user", id: actorId },
		});
	}
	if (
		item.disposition !== "accepted" ||
		!samePreparedIntent(item, params.input, identity)
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"This repository work request no longer matches its canonical Work Item",
		);
	}
	return dispatchResult(params.input, identity, item.id);
}
