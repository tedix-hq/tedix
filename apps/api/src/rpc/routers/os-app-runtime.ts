import { validateAppSource } from "../../services/os-app-validation";
import { implement, call as callProcedure } from "@orpc/server";
import { z } from "zod";
import { RunWorkspaceSkillNowInputSchema } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { osAppRuntimeContract } from "@tedix/api-contract/contracts/os-app-runtime";
import {
	OsAppDraftContentSchema,
	OsGadgetRevisionSchema,
	OsOutputContentSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import {
	mintWorkspaceAppSession,
	verifyWorkspaceAppSession,
	type WorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import {
	getOsGadgetRevision,
	listOsGadgetRevisions,
	getOsGadget,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	getOsCollaborationProposal,
	rebaseOsAppDraft,
	createOsCollaborationProposal,
} from "@tedix/db/queries/os-workspaces/collaboration";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import { mapCollaborationProposal } from "./os-workspaces-shared";
import {
	mergeAppFiles,
	mergeAppText,
	hasAppConflictMarkers,
} from "@tedix/api-contract/utils/app-draft-merge";
import { appRuntimePermission } from "@tedix/api-contract/utils/app-runtime";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import {
	getOsOutput,
	getOsOutputRevision,
	createOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import {
	createOsGadgetExecution,
	getOsGadgetExecution,
} from "@tedix/db/queries/os-workspaces/executions";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	parseDerivedAccessEnvelope,
	authorizeDerivedOutputSources,
} from "../../services/os-derived-resource-access";
import {
	openWorkspaceAsCollaborator,
	requireWorkspaceCollaboratorAccess,
} from "../../services/os-workspace-collaborators";
import {
	loadAppRuntimeRevision,
	loadAppRuntimeDraft,
	runAppRuntimeCall,
} from "../../services/os-app-runtime-code";
import {
	readGuestAppSlot,
	resolveGuestAppCapabilityScope,
	SHARE_SESSION_PRINCIPAL_KIND,
} from "../../lib/os-share-app-runtime";
import {
	withServiceAuth,
	type BaseContext,
	withAuth,
	withAuthorization,
	hasRequiredScope,
	createError,
	ErrorCodes,
} from "../orpc";
import {
	queryDb,
	requireWorkspace,
	resolveCreator,
	resolveCollaborationSource,
	mapGadgetRevision,
} from "./os-workspaces-shared";

export function createOsAppRuntimeRouter() {
	const os = implement(osAppRuntimeContract).$context<BaseContext>();
	const authed = os.use(withAuth);
	const read = authed.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The collaborator graph resolves app interaction authority on every call; machines are scoped to an organization workspace.",
			},
			"apps:read",
		),
	);
	const author = authed.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Preview requires the collaborator graph build role, rechecked by the handler.",
			},
			"apps:write",
		),
	);

	async function resolve(
		context: BaseContext,
		input: { workspaceId: string; gadgetId: string },
	) {
		const access =
			context.authType === "user"
				? await requireWorkspaceCollaboratorAccess(
						context,
						input.workspaceId,
						"app.connect",
					)
				: null;
		const workspace =
			access?.workspace ?? (await requireWorkspace(context, input.workspaceId));
		const organizationId = workspace.organizationId;
		const gadget = await getOsGadget(queryDb(context), {
			organizationId,
			gadgetId: input.gadgetId,
		});
		if (
			workspace.status !== "active" ||
			!gadget ||
			gadget.workspaceId !== workspace.id ||
			gadget.status !== "active" ||
			!gadget.currentRevisionId
		)
			throw createError(ErrorCodes.NOT_FOUND, "Workspace app unavailable");
		const creator = resolveCreator(context);
		const principal = { kind: creator.kind, id: creator.id };
		const role: WorkspaceAppSession["role"] = access?.role ?? "use";
		return {
			organizationId,
			workspaceId: workspace.id,
			gadgetId: gadget.id,
			revisionId: gadget.currentRevisionId,
			principal,
			role,
			actorUserId: context.user?.sub,
			actorPermissions: context.user?.permissions,
		};
	}

	function load(
		context: BaseContext,
		scope: Awaited<ReturnType<typeof resolve>>,
		revisionId = scope.revisionId,
	) {
		return loadAppRuntimeRevision(queryDb(context), scope, revisionId);
	}

	const open = read.open.handler(async ({ context, input }) => {
		const scope = await resolve(context, input);
		if (context.authType === "user") {
			const opened = await openWorkspaceAsCollaborator(context, {
				workspaceId: input.workspaceId,
				appId: input.gadgetId,
			});
			scope.role = opened.capability.role;
		}
		const code = await load(context, scope);
		const session = await mintWorkspaceAppSession(
			context.env.SECRETS_MASTER_KEY,
			{
				...scope,
				revision: code.revision,
				grants: code.grants,
				codeDigest: code.digest,
				config: code.config,
				compatibilityDate: code.compatibilityDate,
			},
		);
		return {
			session: session.token,
			expiresAt: session.expiresAt,
			role: scope.role,
			revisionId: scope.revisionId,
		};
	});
	const draft = author.draft.handler(async ({ context, input }) => {
		const scope = await requireBuilder(context, input);
		const code = await loadAppRuntimeDraft(
			queryDb(context),
			scope,
			input.proposalId,
		);
		const session = await mintWorkspaceAppSession(
			context.env.SECRETS_MASTER_KEY,
			{
				...scope,
				revisionId: code.revisionId,
				previewId: input.proposalId,
				proposalId: input.proposalId,
				proposalSequence: code.sequence,
				revision: code.revision,
				config: code.config,
				compatibilityDate: code.compatibilityDate,
				grants: code.grants,
				codeDigest: code.digest,
			},
		);
		return {
			session: session.token,
			expiresAt: session.expiresAt,
			role: scope.role,
			revisionId: code.revisionId,
		};
	});
	async function requireBuilder(
		context: BaseContext,
		input: { workspaceId: string; gadgetId: string },
	) {
		const scope = await resolve(context, input);
		if (
			(context.authType === "user" && scope.role !== "build") ||
			!hasRequiredScope(context, "apps:write")
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"App edits require a workspace builder",
			);
		// Only author procedures call this helper, after the machine write-scope gate.
		scope.role = "build";
		return scope;
	}
	async function requireDraft(
		context: BaseContext,
		scope: Awaited<ReturnType<typeof resolve>>,
		proposalId: string,
		expectedSequence?: number,
		allowMerged = false,
	) {
		const proposal = await getOsCollaborationProposal(queryDb(context), {
			organizationId: scope.organizationId,
			proposalId,
		});
		if (
			!proposal ||
			proposal.workspaceId !== scope.workspaceId ||
			proposal.documentId !== scope.gadgetId ||
			proposal.documentType !== "gadget"
		)
			throw createError(ErrorCodes.NOT_FOUND, "App draft not found");
		if (
			proposal.sequence !== expectedSequence ||
			!["open", "accepted", ...(allowMerged ? ["merged"] : [])].includes(
				proposal.status,
			)
		)
			throw createError(ErrorCodes.CONFLICT, "Draft changed or is closed");
		OsAppDraftContentSchema.parse(JSON.parse(proposal.content));
		return proposal;
	}
	const mergeDraft = author.mergeDraft.handler(async ({ context, input }) => {
		const scope = await requireBuilder(context, input);
		const proposal = await requireDraft(
			context,
			scope,
			input.proposalId,
			input.expectedSequence,
		);
		const base = await load(context, scope, proposal.baseRevisionId);
		const main = await load(context, scope);
		const draft = OsAppDraftContentSchema.parse(JSON.parse(proposal.content));
		const merged = mergeAppFiles(base.files, draft.files, main.files);
		const manifest = mergeAppText(
			JSON.stringify(base.manifest, null, 2),
			JSON.stringify(draft.manifest, null, 2),
			JSON.stringify(main.manifest, null, 2),
		);
		return {
			...merged,
			manifest: manifest.text!,
			revisionId: scope.revisionId,
			conflicts: [
				...merged.conflicts,
				...(manifest.conflict ? ["manifest.json"] : []),
			],
		};
	});
	const saveDraft = author.saveDraft.handler(async ({ context, input }) => {
		const scope = await requireBuilder(context, input);
		if (scope.revisionId !== input.expectedRevisionId)
			throw createError(
				ErrorCodes.CONFLICT,
				"App revision changed; update to latest again",
			);
		const code = await load(context, scope);
		if (Object.values(input.content.files).some(hasAppConflictMarkers))
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Resolve conflict markers before saving",
			);
		if (input.content.manifest.entry !== "tedix:runtime/v1")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"App drafts require a runtime manifest",
			);
		await validateAppSource(
			context.env,
			input.content.files,
			input.content.manifest.config?.compatibilityDate,
		);
		const content = JSON.stringify(input.content);
		if (input.proposalId) {
			await requireDraft(
				context,
				scope,
				input.proposalId,
				input.expectedSequence,
			);
			const proposal = await rebaseOsAppDraft(queryDb(context), {
				organizationId: scope.organizationId,
				proposalId: input.proposalId,
				expectedSequence: input.expectedSequence!,
				baseRevisionId: scope.revisionId,
				baseRevision: code.revision,
				content,
			});
			if (!proposal)
				throw createError(ErrorCodes.CONFLICT, "Draft changed or is closed");
			return { proposal: mapCollaborationProposal(proposal) };
		}
		const proposal = await createOsCollaborationProposal(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			documentType: "gadget",
			documentId: scope.gadgetId,
			baseRevisionId: scope.revisionId,
			baseRevision: code.revision,
			status: "open",
			...(context.authType === "user" && !context.externalAgentSessionId
				? { sourceKind: "user" as const, sourceId: scope.principal.id }
				: resolveCollaborationSource(context)),
			sourceAttestationVersion: 1,
			content,
			sequence: 0,
			createdByKind: scope.principal.kind,
			createdById: scope.principal.id,
		});
		return { proposal: mapCollaborationProposal(proposal) };
	});
	const proposeEdit = author.proposeEdit.handler(async ({ context, input }) => {
		const scope = await requireBuilder(context, input);
		let source: {
			sourceKind: "chat" | "run" | "agent_session";
			sourceId: string;
		};
		if (context.authType === "user" && !context.externalAgentSessionId) {
			const conversation = input.conversationId
				? await getKernelConversation(context.db, {
						organizationId: scope.organizationId,
						conversationId: input.conversationId,
					})
				: null;
			if (
				!conversation ||
				conversation.deletedAt ||
				conversation.workspaceId !== scope.workspaceId
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"App edits require a Home conversation linked to this workspace",
				);
			source = { sourceKind: "chat", sourceId: conversation.conversationId };
		} else {
			source = resolveCollaborationSource(context);
		}

		if (scope.revisionId !== input.expectedRevisionId)
			throw createError(ErrorCodes.CONFLICT, "App revision changed");
		const code = await load(context, scope);
		const files = { ...code.files };
		for (const edit of input.edits) {
			const source = files[edit.path];
			if (source === undefined || source.split(edit.before).length !== 2)
				throw createError(
					ErrorCodes.CONFLICT,
					"App edit must match exactly once in the current file",
				);
			files[edit.path] = source.replace(edit.before, () => edit.after);
		}
		const content = OsAppDraftContentSchema.parse({
			manifest: code.manifest,
			files,
		});
		await validateAppSource(context.env, files, code.compatibilityDate);
		const proposal = await createOsCollaborationProposal(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			documentType: "gadget",
			documentId: scope.gadgetId,
			baseRevisionId: scope.revisionId,
			baseRevision: code.revision,
			status: "open",
			...source,
			sourceAttestationVersion: 1,
			content: JSON.stringify(content),
			sequence: 0,
			createdByKind: scope.principal.kind,
			createdById: scope.principal.id,
		});
		const previewUrl = new URL(
			`/workspaces/${scope.workspaceId}`,
			context.env.OS_URL,
		);
		previewUrl.searchParams.set("workpiece", `gadget:${scope.gadgetId}`);
		previewUrl.searchParams.set("view", "drafts");
		return {
			proposal: mapCollaborationProposal(proposal),
			previewUrl: previewUrl.toString(),
		};
	});
	const acceptEdit = author.acceptEdit.handler(async ({ context, input }) => {
		const scope = await requireBuilder(context, input);
		const proposal = await requireDraft(
			context,
			scope,
			input.proposalId,
			input.expectedSequence,
			true,
		);
		if (
			proposal.status !== "merged" &&
			proposal.baseRevisionId !== scope.revisionId
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"App revision changed; rebase the draft",
			);
		const { osCollaborationProcedures } =
			await import("./os-workspace-collaboration");
		const decision = {
			proposalId: proposal.id,
			expectedSequence: proposal.sequence,
			rationale: input.rationale,
			evidenceRefs: [],
		};
		const accepted =
			proposal.status !== "open"
				? proposal
				: (
						await callProcedure(osCollaborationProcedures.accept, decision, {
							context,
						})
					).proposal;
		const result = await callProcedure(
			osCollaborationProcedures.merge,
			{ ...decision, expectedSequence: accepted.sequence },
			{ context },
		);
		return { revision: OsGadgetRevisionSchema.parse(result.revision) };
	});
	const revisions = read.revisions.handler(async ({ context, input }) => {
		const scope = await resolve(context, input);
		const rows = await listOsGadgetRevisions(queryDb(context), scope, {
			limit: input.limit,
		});
		return { revisions: rows.map(mapGadgetRevision) };
	});
	const restoreRevision = author.restoreRevision.handler(
		async ({ context, input }) => {
			const scope = await requireBuilder(context, input);
			if (scope.revisionId !== input.expectedRevisionId)
				throw createError(ErrorCodes.CONFLICT, "App revision changed");
			const [old, current] = await Promise.all([
				load(context, scope, input.revisionId),
				load(context, scope),
			]);
			const { osWorkspacesContractRouter } = await import("./os-workspaces");
			const result = await callProcedure(
				osWorkspacesContractRouter.gadgets.revise,
				{
					workspaceId: scope.workspaceId,
					gadgetId: scope.gadgetId,
					manifest: old.manifest,
					files: old.files,
					expectedRevision: current.revision,
				},
				{ context },
			);
			return { revision: result.revision };
		},
	);

	const preview = author.preview.handler(async ({ context, input }) => {
		const scope = await requireBuilder(context, input);
		const code = await load(context, scope, input.revisionId);
		const session = await mintWorkspaceAppSession(
			context.env.SECRETS_MASTER_KEY,
			{
				...scope,
				revisionId: input.revisionId,
				previewId: input.previewId,
				revision: code.revision,
				config: code.config,
				compatibilityDate: code.compatibilityDate,
				grants: code.grants,
				codeDigest: code.digest,
			},
		);
		return {
			session: session.token,
			expiresAt: session.expiresAt,
			role: scope.role,
			revisionId: input.revisionId,
		};
	});
	async function openedSession(
		context: BaseContext,
		input: { workspaceId: string; gadgetId: string; session: string },
	) {
		const scope = await resolve(context, input);
		let session;
		try {
			session = await verifyWorkspaceAppSession(
				context.env.SECRETS_MASTER_KEY,
				input.session,
			);
		} catch {
			throw createError(ErrorCodes.FORBIDDEN, "Invalid app session");
		}
		if (
			context.authType !== "user" &&
			(session.role === "build" || session.role === "owner") &&
			hasRequiredScope(context, "apps:write")
		)
			scope.role = "build";
		if (
			session.organizationId !== scope.organizationId ||
			session.workspaceId !== scope.workspaceId ||
			session.gadgetId !== scope.gadgetId ||
			session.principal.kind !== scope.principal.kind ||
			session.principal.id !== scope.principal.id ||
			((session.role === "build" || session.role === "owner") &&
				scope.role !== "build") ||
			(!session.previewId && session.revisionId !== scope.revisionId)
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"App session no longer matches caller access or revision",
			);
		const code = session.proposalId
			? await loadAppRuntimeDraft(queryDb(context), scope, session.proposalId)
			: await load(context, scope, session.revisionId);
		if (
			code.digest !== session.codeDigest ||
			("sequence" in code && code.sequence !== session.proposalSequence)
		)
			throw createError(ErrorCodes.CONFLICT, "App code changed");
		return { scope, session, code };
	}
	const client = read.client.handler(async ({ context, input }) => {
		const opened = await callProcedure(open, input, { context });
		const { code } = await openedSession(context, {
			...input,
			session: opened.session,
		});
		return {
			...opened,
			client: code.files["client.js"]!,
			revision: code.revision,
			settings: code.config.settings ?? {},
			grants: code.grants,
		};
	});
	const readOutput = read.readOutput.handler(async ({ context, input }) => {
		const { scope, session, code } = await openedSession(context, input);
		if (
			session.previewId ||
			!appRuntimePermission({
				role: scope.role,
				grants: code.grants,
				operation: "outputs.read",
				slot: input.slot,
			}).allowed ||
			!appRuntimePermission({
				role: session.role,
				grants: session.grants,
				operation: "outputs.read",
				slot: input.slot,
			}).allowed
		)
			throw createError(ErrorCodes.FORBIDDEN, "App capability denied");
		const db = queryDb(context);
		const resources = await listOsWorkspaceResources(db, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			status: "active",
			limit: 200,
		});
		const resource = resources.find((row) => row.slot === input.slot);
		if (
			!resource ||
			resource.providerId !== "tedix" ||
			resource.resourceType !== "output"
		)
			throw createError(ErrorCodes.FORBIDDEN, "Slot is not an Output");
		const output = await getOsOutput(db, {
			organizationId: scope.organizationId,
			outputId: resource.providerResourceId,
		});
		if (
			!output ||
			output.workspaceId !== scope.workspaceId ||
			output.status !== "active" ||
			!output.currentRevisionId
		)
			throw createError(ErrorCodes.NOT_FOUND, "Granted Output unavailable");
		const revision = await getOsOutputRevision(db, {
			organizationId: scope.organizationId,
			revisionId: output.currentRevisionId,
		});
		const envelope = parseDerivedAccessEnvelope(
			revision?.accessEnvelope ?? null,
		);
		const member =
			context.authType === "user" && scope.actorUserId
				? await getMemberByUserId(
						context.db,
						scope.organizationId,
						scope.actorUserId,
					)
				: null;
		const crossOrg =
			context.organizationId !== scope.organizationId ||
			(context.authType === "user" && member?.status !== "active");
		if (
			!revision ||
			revision.outputId !== output.id ||
			!envelope ||
			(crossOrg
				? envelope.sources.length !== 0
				: !(await authorizeDerivedOutputSources(context, {
						organizationId: scope.organizationId,
						accessEnvelope: envelope,
					})))
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Output source access unavailable",
			);
		return OsOutputContentSchema.parse(JSON.parse(revision.content));
	});
	const call = read.call.handler(async ({ context, input }) => {
		const { scope, session, code } = await openedSession(context, input);
		const result = await runAppRuntimeCall(context.env, queryDb(context), {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			gadgetId: scope.gadgetId,
			revisionId: session.revisionId,
			code,
			role: scope.role,
			session: input.session,
			method: input.method,
			args: input.args,
			createdBy: scope.principal,
		});
		return { result };
	});
	/**
	 * A share-link guest's app asked for a resource. The guest holds no
	 * connected accounts and no membership, so the only capability is reading
	 * a granted Output whose access envelope names no sources; the share
	 * session and its link must still be live, and the link must be the one
	 * the app session was minted for.
	 */
	async function guestCapability(
		context: BaseContext,
		session: Awaited<ReturnType<typeof verifyWorkspaceAppSession>>,
		input: { operation: string; slot: string },
	) {
		const db = queryDb(context);
		const scope = await resolveGuestAppCapabilityScope(db, session);
		if (!scope)
			throw createError(ErrorCodes.FORBIDDEN, "App capability denied");
		if (input.operation !== "outputs.read")
			throw createError(ErrorCodes.FORBIDDEN, "App capability denied");
		const code = await loadAppRuntimeRevision(db, scope, scope.revisionId);
		if (code.digest !== session.codeDigest)
			throw createError(ErrorCodes.FORBIDDEN, "App capability denied");
		const read = await readGuestAppSlot(db, scope, code.grants, input.slot);
		if (!read) throw createError(ErrorCodes.FORBIDDEN, "App capability denied");
		return JsonValueSchema.parse(read);
	}

	const internal = os.use(withServiceAuth);
	const capability = internal.capability.handler(async ({ context, input }) => {
		const session = await verifyWorkspaceAppSession(
			context.env.SECRETS_MASTER_KEY,
			input.session,
		);
		if (session.principal.kind === SHARE_SESSION_PRINCIPAL_KIND)
			return guestCapability(context, session, input);
		if (!session.actorUserId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Resource capabilities require a member session",
			);
		const member = await getMemberByUserId(
			context.db,
			session.organizationId,
			session.actorUserId,
		);
		const acting: BaseContext = {
			...context,
			authType: "user",
			organizationId: session.organizationId,
			headers: new Headers(),
			userRole: member?.status === "active" ? member.role : undefined,
			user: {
				sub: session.actorUserId,
				permissions: session.actorPermissions ?? [],
				roles: [],
				iss: "tedix:workspace-app",
				exp: session.expiresAt,
			},
			externalAgentPrincipalId:
				session.principal.kind === "external_agent"
					? session.principal.id
					: undefined,
		};
		const scope = await resolve(acting, session);
		if (
			scope.organizationId !== session.organizationId ||
			(!session.previewId && scope.revisionId !== session.revisionId)
		)
			throw createError(ErrorCodes.FORBIDDEN, "App session is stale");
		const code = session.proposalId
			? await loadAppRuntimeDraft(queryDb(acting), scope, session.proposalId)
			: await load(acting, scope, session.revisionId);
		if (
			code.digest !== session.codeDigest ||
			("sequence" in code && code.sequence !== session.proposalSequence)
		)
			throw createError(ErrorCodes.CONFLICT, "App code changed");
		if (
			!appRuntimePermission({
				...session,
				operation: input.operation,
				slot: input.slot,
			}).allowed ||
			!appRuntimePermission({
				role: scope.role,
				grants: code.grants,
				operation: input.operation,
				slot: input.slot,
			}).allowed
		)
			throw createError(ErrorCodes.FORBIDDEN, "App capability denied");
		if (session.previewId && input.operation !== "outputs.read")
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Preview resources are read-only",
			);
		const resources = await listOsWorkspaceResources(queryDb(acting), {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			status: "active",
			limit: 200,
		});
		const resource = resources.find((row) => row.slot === input.slot);
		if (!resource)
			throw createError(ErrorCodes.NOT_FOUND, "App resource slot unavailable");
		if (
			input.operation === "outputs.read" ||
			input.operation === "outputs.write"
		) {
			if (resource.providerId !== "tedix" || resource.resourceType !== "output")
				throw createError(ErrorCodes.FORBIDDEN, "Slot is not an Output");
			const output = await getOsOutput(queryDb(acting), {
				organizationId: scope.organizationId,
				outputId: resource.providerResourceId,
			});
			if (
				!output ||
				output.workspaceId !== scope.workspaceId ||
				output.status !== "active" ||
				!output.currentRevisionId
			)
				throw createError(ErrorCodes.NOT_FOUND, "Granted Output unavailable");
			const revision = await getOsOutputRevision(queryDb(acting), {
				organizationId: scope.organizationId,
				revisionId: output.currentRevisionId,
			});
			const envelope = parseDerivedAccessEnvelope(
				revision?.accessEnvelope ?? null,
			);
			if (
				!revision ||
				revision.outputId !== output.id ||
				!envelope ||
				(member?.status !== "active" && envelope.sources.length !== 0) ||
				!(await authorizeDerivedOutputSources(acting, {
					organizationId: scope.organizationId,
					accessEnvelope: envelope,
				}))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Output source access unavailable",
				);
			if (input.operation === "outputs.read")
				return JsonValueSchema.parse({
					output,
					revision: { ...revision, content: JSON.parse(revision.content) },
				});
			const args = z
				.object({
					content: OsOutputContentSchema,
					expectedRevision: z.number().int().positive(),
				})
				.strict()
				.parse(input.args);
			if (args.content.kind !== output.kind)
				throw createError(ErrorCodes.BAD_REQUEST, "Output kind mismatch");
			const result = await createOsOutputRevision(queryDb(acting), {
				id: crypto.randomUUID(),
				organizationId: scope.organizationId,
				outputId: output.id,
				content: JSON.stringify(args.content),
				expectedRevision: args.expectedRevision,
				createdByKind:
					session.principal.kind === "external_agent"
						? "external_agent"
						: "user",
				createdById: session.principal.id,
				accessEnvelope: revision.accessEnvelope,
			});
			if (!result.ok)
				throw createError(ErrorCodes.CONFLICT, "Output revision changed");
			return JsonValueSchema.parse(result);
		}
		if (input.operation === "skills.run") {
			if (resource.providerId !== "tedix" || resource.resourceType !== "skill")
				throw createError(ErrorCodes.FORBIDDEN, "Slot is not a skill");
			const { osWorkspaceScheduleProcedures } =
				await import("./os-workspace-schedules");
			const args = z.record(z.string(), z.unknown()).parse(input.args);
			const skillInput = RunWorkspaceSkillNowInputSchema.parse({
				...args,
				workspaceId: scope.workspaceId,
				skillId: resource.providerResourceId,
			});
			return JsonValueSchema.parse(
				await callProcedure(osWorkspaceScheduleProcedures.runNow, skillInput, {
					context: acting,
				}),
			);
		}
		const { callWorkspaceAppConnection } =
			await import("../../services/os-app-connection");
		return callWorkspaceAppConnection(acting, session, resource, input.args);
	});
	const recordTail = internal.recordTail.handler(async ({ context, input }) => {
		const existing = await getOsGadgetExecution(queryDb(context), {
			organizationId: input.organizationId,
			executionId: input.tailId,
		});
		if (existing) return { recorded: true };
		const revision = await getOsGadgetRevision(queryDb(context), {
			organizationId: input.organizationId,
			revisionId: input.revisionId,
		});
		const gadget = await getOsGadget(queryDb(context), {
			organizationId: input.organizationId,
			gadgetId: input.gadgetId,
		});
		if (
			!revision ||
			revision.gadgetId !== input.gadgetId ||
			gadget?.workspaceId !== input.workspaceId
		)
			throw createError(ErrorCodes.NOT_FOUND, "App trace scope unavailable");
		if (input.callId) {
			const call = await getOsGadgetExecution(queryDb(context), {
				organizationId: input.organizationId,
				executionId: input.callId,
			});
			if (
				!call ||
				call.workspaceId !== input.workspaceId ||
				call.gadgetId !== input.gadgetId ||
				call.revisionId !== input.revisionId ||
				!JSON.parse(call.grantedCapabilities).includes("app.call")
			)
				throw createError(ErrorCodes.NOT_FOUND, "App call scope unavailable");
		}
		const failed = input.events.some(
			(event) =>
				event !== null &&
				typeof event === "object" &&
				"outcome" in event &&
				event.outcome !== "ok",
		);
		await createOsGadgetExecution(queryDb(context), {
			id: input.tailId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
			gadgetId: input.gadgetId,
			revisionId: input.revisionId,
			revision: revision.revision,
			status: failed ? "failed" : "completed",
			error: failed ? "App trace reported failure" : null,
			grantedCapabilities: "[]",
			policyDecision: JSON.stringify({
				allowed: true,
				reasons: ["runtime_trace"],
			}),
			output: JSON.stringify({ callId: input.callId, events: input.events }),
			createdByKind: "service",
			createdById: "workspace-app-host",
			runtimeEnvironment: context.env.ENVIRONMENT,
			completedAt: new Date().toISOString(),
		});
		return { recorded: true };
	});
	return os.router({
		open,
		client,
		readOutput,
		call,
		preview,
		draft,
		proposeEdit,
		acceptEdit,
		revisions,
		restoreRevision,
		saveDraft,
		mergeDraft,
		capability,
		recordTail,
	});
}

export const osAppRuntimeContractRouter = createOsAppRuntimeRouter();
