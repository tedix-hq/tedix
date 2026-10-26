/**
 * The parts of a workspace app call that do not depend on who is calling:
 * loading one revision's stored code and running a method on the app host
 * with a receipt in the app's execution ledger. Members (the osAppRuntime
 * router) and share-link guests (os-share-app-runtime) decide the caller and
 * role first, then both come here.
 */
import { serviceBindingFetch } from "@tedix/api-client/internal";
import {
	JsonValueSchema,
	type JsonValue,
} from "@tedix/api-contract/schemas/common";
import {
	AppRuntimeConfigSchema,
	AppRuntimeFilesSchema,
	type AppRuntimeRole,
} from "@tedix/api-contract/schemas/os-app-runtime";
import {
	OsAppDraftContentSchema,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";
import {
	createOsGadgetExecution,
	settleOsAppCallExecution,
} from "@tedix/db/queries/os-workspaces/executions";
import {
	getOsGadgetCode,
	getOsGadgetRevision,
} from "@tedix/db/queries/os-workspaces/gadgets";
import type { DbQueryClient } from "@tedix/db/query-client";
import { getOsCollaborationProposal } from "@tedix/db/queries/os-workspaces/collaboration";
import { createError, ErrorCodes } from "../rpc/orpc";

/** Load the code, grants and settings of one runtime app revision. */
export async function loadAppRuntimeRevision(
	db: DbQueryClient,
	scope: { organizationId: string; gadgetId: string },
	revisionId: string,
) {
	const revision = await getOsGadgetRevision(db, {
		organizationId: scope.organizationId,
		revisionId,
	});
	if (!revision || revision.gadgetId !== scope.gadgetId)
		throw createError(ErrorCodes.NOT_FOUND, "App revision unavailable");
	const manifest = OsGadgetManifestSchema.parse(JSON.parse(revision.manifest));
	if (manifest.entry !== "tedix:runtime/v1")
		throw createError(ErrorCodes.BAD_REQUEST, "App has no server runtime");
	const row = await getOsGadgetCode(db, {
		organizationId: scope.organizationId,
		revisionId,
	});
	if (!row || row.gadgetId !== scope.gadgetId)
		throw createError(ErrorCodes.NOT_FOUND, "App code unavailable");
	const files = AppRuntimeFilesSchema.parse(JSON.parse(row.files));
	const config = AppRuntimeConfigSchema.parse(
		manifest.config ?? { version: 1 },
	);
	return {
		files,
		manifest,
		digest: await appRuntimeCodeDigest(files),
		grants: manifest.resourceGrants ?? [],
		revision: revision.revision,
		config,
		compatibilityDate: config.compatibilityDate,
	};
}

export type AppRuntimeRevision = Awaited<
	ReturnType<typeof loadAppRuntimeRevision>
>;

/**
 * Run one method on the app host and record it. The receipt names who called
 * (`createdBy`) and why it was allowed (`policy`), and settles as completed or
 * failed; a failed call is never recorded as a write.
 */
export async function runAppRuntimeCall(
	env: Pick<CloudflareEnv, "TEDI_SERVICE" | "ENVIRONMENT">,
	db: DbQueryClient,
	input: {
		organizationId: string;
		workspaceId: string;
		gadgetId: string;
		revisionId: string;
		code: AppRuntimeRevision;
		role: AppRuntimeRole;
		session: string;
		method: string;
		args: JsonValue[];
		createdBy: {
			kind: "user" | "tedi" | "external_agent" | "service";
			id: string;
		};
		policy?: Record<string, JsonValue>;
		/** A caller-chosen receipt id; a trigger derives it from the event so a repeat is recognised. */
		executionId?: string;
	},
): Promise<JsonValue> {
	const executionId = input.executionId ?? crypto.randomUUID();
	const receiptScope = { organizationId: input.organizationId, executionId };
	await createOsGadgetExecution(db, {
		id: executionId,
		organizationId: input.organizationId,
		workspaceId: input.workspaceId,
		gadgetId: input.gadgetId,
		revisionId: input.revisionId,
		revision: input.code.revision,
		status: "running",
		input: JSON.stringify({ method: input.method, args: input.args }),
		grantedCapabilities: JSON.stringify(["app.call"]),
		policyDecision: JSON.stringify({
			allowed: true,
			reasons: ["app.call"],
			role: input.role,
			resourceGrants: input.code.grants,
			...input.policy,
		}),
		createdByKind: input.createdBy.kind,
		createdById: input.createdBy.id,
		runtimeEnvironment: env.ENVIRONMENT,
	});
	let result: JsonValue;
	try {
		const response = await serviceBindingFetch(env.TEDI_SERVICE)(
			"https://tedi-runtime/__internal/workspace-app/call",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({
					callId: executionId,
					session: input.session,
					files: input.code.files,
					method: input.method,
					args: input.args,
				}),
			},
		);
		if (!response.ok)
			throw createError(ErrorCodes.BAD_GATEWAY, "Workspace app call failed");
		result = JsonValueSchema.parse(await response.json());
	} catch (error) {
		await settleOsAppCallExecution(db, {
			...receiptScope,
			status: "failed",
			error: "Workspace app call failed",
		});
		throw error;
	}
	await settleOsAppCallExecution(db, {
		...receiptScope,
		status: "completed",
		output: JSON.stringify(result),
	});
	return result;
}

/** A closed or changed proposal never falls back to the deployed revision. */
export async function loadAppRuntimeDraft(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string; gadgetId: string },
	proposalId: string,
) {
	const proposal = await getOsCollaborationProposal(db, {
		organizationId: scope.organizationId,
		proposalId,
	});
	if (
		!proposal ||
		proposal.workspaceId !== scope.workspaceId ||
		proposal.documentType !== "gadget" ||
		proposal.documentId !== scope.gadgetId ||
		!["open", "accepted"].includes(proposal.status)
	)
		throw createError(ErrorCodes.NOT_FOUND, "App draft unavailable");
	const draft = OsAppDraftContentSchema.parse(JSON.parse(proposal.content));
	const config = AppRuntimeConfigSchema.parse(
		draft.manifest.config ?? { version: 1 },
	);
	return {
		files: draft.files,
		manifest: draft.manifest,
		sequence: proposal.sequence,
		digest: await appRuntimeCodeDigest(draft.files),
		grants: draft.manifest.resourceGrants ?? [],
		revision: proposal.baseRevision,
		config,
		compatibilityDate: config.compatibilityDate,
		revisionId: proposal.baseRevisionId,
	};
}
