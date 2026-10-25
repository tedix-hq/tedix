import { implement, call as callProcedure } from "@orpc/server";
import { z } from "zod";
import { RunWorkspaceSkillNowInputSchema } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { osAppRuntimeContract } from "@tedix/api-contract/contracts/os-app-runtime";
import {
	OsGadgetManifestSchema,
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
	getOsGadget,
	getOsGadgetCode,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	AppRuntimeFilesSchema,
	AppRuntimeConfigSchema,
} from "@tedix/api-contract/schemas/os-app-runtime";
import {
	appRuntimeCodeDigest,
	appRuntimePermission,
} from "@tedix/api-contract/utils/app-runtime";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import {
	getOsOutput,
	getOsOutputRevision,
	createOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import {
	createOsGadgetExecution,
	settleOsAppCallExecution,
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
import { serviceBindingFetch } from "@tedix/api-client/internal";
import {
	withServiceAuth,
	type BaseContext,
	withAuth,
	withAuthorization,
	createError,
	ErrorCodes,
} from "../orpc";
import {
	queryDb,
	requireWorkspace,
	resolveCreator,
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

	async function load(
		context: BaseContext,
		scope: Awaited<ReturnType<typeof resolve>>,
		revisionId = scope.revisionId,
	) {
		const revision = await getOsGadgetRevision(queryDb(context), {
			organizationId: scope.organizationId,
			revisionId,
		});
		if (!revision || revision.gadgetId !== scope.gadgetId)
			throw createError(ErrorCodes.NOT_FOUND, "App revision unavailable");
		const manifest = OsGadgetManifestSchema.parse(
			JSON.parse(revision.manifest),
		);
		if (manifest.entry !== "tedix:runtime/v1")
			throw createError(ErrorCodes.BAD_REQUEST, "App has no server runtime");
		const row = await getOsGadgetCode(queryDb(context), {
			organizationId: scope.organizationId,
			revisionId,
		});
		if (!row || row.gadgetId !== scope.gadgetId)
			throw createError(ErrorCodes.NOT_FOUND, "App code unavailable");
		const files = AppRuntimeFilesSchema.parse(JSON.parse(row.files));
		const code = { files, digest: await appRuntimeCodeDigest(files) };
		const config = AppRuntimeConfigSchema.parse(
			manifest.config ?? { version: 1 },
		);
		return {
			...code,
			grants: manifest.resourceGrants ?? [],
			revision: revision.revision,
			config,
			compatibilityDate: config.compatibilityDate,
		};
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
	const preview = author.preview.handler(async ({ context, input }) => {
		const scope = await resolve(context, input);
		if (scope.role !== "build")
			throw createError(
				ErrorCodes.FORBIDDEN,
				"App preview requires build access",
			);
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
	const call = read.call.handler(async ({ context, input }) => {
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
		const code = await load(context, scope, session.revisionId);
		if (code.digest !== session.codeDigest)
			throw createError(ErrorCodes.CONFLICT, "App code changed");
		const executionId = crypto.randomUUID();
		const receiptScope = { organizationId: scope.organizationId, executionId };
		await createOsGadgetExecution(queryDb(context), {
			id: executionId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			gadgetId: scope.gadgetId,
			revisionId: session.revisionId,
			revision: code.revision,
			status: "running",
			input: JSON.stringify({ method: input.method, args: input.args }),
			grantedCapabilities: JSON.stringify(["app.call"]),
			policyDecision: JSON.stringify({
				allowed: true,
				reasons: ["app.call"],
				role: scope.role,
				resourceGrants: code.grants,
			}),
			createdByKind: scope.principal.kind,
			createdById: scope.principal.id,
			runtimeEnvironment: context.env.ENVIRONMENT,
		});
		let result;
		try {
			const response = await serviceBindingFetch(context.env.TEDI_SERVICE)(
				"https://tedi-runtime/__internal/workspace-app/call",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Service-Binding": "true",
					},
					body: JSON.stringify({
						session: input.session,
						files: code.files,
						method: input.method,
						args: input.args,
					}),
				},
			);
			if (!response.ok)
				throw createError(ErrorCodes.BAD_GATEWAY, "Workspace app call failed");
			result = JsonValueSchema.parse(await response.json());
		} catch (error) {
			await settleOsAppCallExecution(queryDb(context), {
				...receiptScope,
				status: "failed",
				error: "Workspace app call failed",
			});
			throw error;
		}
		await settleOsAppCallExecution(queryDb(context), {
			...receiptScope,
			status: "completed",
			output: JSON.stringify(result),
		});
		return { result };
	});
	const internal = os.use(withServiceAuth);
	const capability = internal.capability.handler(async ({ context, input }) => {
		const session = await verifyWorkspaceAppSession(
			context.env.SECRETS_MASTER_KEY,
			input.session,
		);
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
		const code = await load(acting, scope, session.revisionId);
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
				!envelope ||
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
		// Connection slots need the provider-specific approval adapter. Refuse
		// before resolving a credential; app grants never imply provider consent.
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Connection slot requires a governed approval adapter",
		);
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
			output: JSON.stringify({ events: input.events }),
			createdByKind: "service",
			createdById: "workspace-app-host",
			runtimeEnvironment: context.env.ENVIRONMENT,
			completedAt: new Date().toISOString(),
		});
		return { recorded: true };
	});
	return os.router({ open, call, preview, capability, recordTail });
}

export const osAppRuntimeContractRouter = createOsAppRuntimeRouter();
