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

/**
 * A published revision's manifest without its code. Code rows are written
 * once per revision and never updated, so a signed session's revision id
 * already pins its code; callers that only need grants skip the code read.
 */
async function loadAppRuntimeManifest(
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
	return { revision, manifest, grants: manifest.resourceGrants ?? [] };
}

/** Load the code, grants and settings of one runtime app revision. */
export async function loadAppRuntimeRevision(
	db: DbQueryClient,
	scope: { organizationId: string; gadgetId: string },
	revisionId: string,
) {
	const { revision, manifest } = await loadAppRuntimeManifest(
		db,
		scope,
		revisionId,
	);
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
		/** Files travel only for a draft; the host reads a published revision's code itself. */
		code: Pick<AppRuntimeRevision, "revision" | "grants"> & {
			files?: AppRuntimeRevision["files"];
		};
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
		/** Receives `Server-Timing` entries for each hop of this call. */
		timing?: string[];
		/** Settles the receipt after the response instead of before it. */
		waitUntil?: (work: Promise<unknown>) => void;
	},
): Promise<JsonValue> {
	const executionId = input.executionId ?? crypto.randomUUID();
	const started = Date.now();
	const receiptScope = { organizationId: input.organizationId, executionId };
	// The receipt is written while the host runs; the call fails if it is not stored.
	const receipt = createOsGadgetExecution(db, {
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
	}).then(() => {
		input.timing?.push(`receipt;dur=${Date.now() - started}`);
	});
	const settle = (
		outcome:
			| { status: "completed"; output: string }
			| { status: "failed"; error: string },
	) =>
		receipt.then(() =>
			settleOsAppCallExecution(db, { ...receiptScope, ...outcome }),
		);
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
					...(input.code.files ? { files: input.code.files } : {}),
					method: input.method,
					args: input.args,
				}),
			},
		);
		if (!response.ok)
			throw createError(ErrorCodes.BAD_GATEWAY, "Workspace app call failed");
		result = JsonValueSchema.parse(await response.json());
		input.timing?.push(`runtime;dur=${Date.now() - started}`);
		const runtimeTiming = response.headers.get("Server-Timing");
		if (runtimeTiming) input.timing?.push(runtimeTiming);
		await receipt;
	} catch (error) {
		await settle({
			status: "failed",
			error: "Workspace app call failed",
		}).catch(() => {});
		throw error;
	}
	const settled = settle({
		status: "completed",
		output: JSON.stringify(result),
	});
	if (input.waitUntil) input.waitUntil(settled);
	else await settled;
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
