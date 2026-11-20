/**
 * Outputs and revisions live in the activated workspace object. Bodies are
 * gzip objects in R2 addressed by digest. Resources use the workspace object;
 * apps and Work items use the core database.
 */
import type { DbQueryClient } from "@tedix/db/query-client";
import { createDbClient } from "@tedix/db/client";
import {
	createOsOutput,
	createOsOutputRevision,
	getOsOutput,
	getOsOutputRevision,
	listOsOutputs,
} from "@tedix/db/queries/durable-sqlite/os-outputs";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	createOsGadget,
	createOsGadgetRevision,
	deleteOsGadget,
	listOsGadgets,
	getOsGadget,
	getOsGadgetRevision,
	getOsGadgetCode,
	setOsAppTriggerEnabled,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	OsAppDraftContentSchema,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	APP_RUNTIME_ENTRY,
	AppRuntimeFilesSchema,
	AppRuntimeConfigSchema,
	RegisterAppScheduleInputSchema,
	type RegisterAppScheduleInput,
} from "@tedix/api-contract/schemas/os-app-runtime";
import {
	appRuntimeCodeLength,
	isAppRuntimeManifest,
} from "@tedix/api-contract/utils/app-runtime";
import { z } from "zod";
import {
	getOsAppEditDraft,
	proposeOsAppFileEdits,
} from "@tedix/db/queries/os-workspaces/collaboration";
import { listOsWorkspaceProjects } from "@tedix/db/queries/os-workspaces/projects";
import { listWorkspaceResourceSummaries } from "@tedix/db/queries/durable-sqlite/workspace-resources";
import { listConnectedAccounts } from "@tedix/db/queries/connection-instances";
import { listConnectionProviderNames } from "@tedix/db/queries/connection-providers";
import { listAppsReferencingConnectionProvider } from "@tedix/db/queries/app-reference-maintenance";
import { getAppByIdWithToolsForOrganization } from "@tedix/db/queries/app-records";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { findWorkspaceConnectionTool } from "@tedix/db/queries/tools";
import {
	PersonalResourceToolBindingSchema,
	resolveToolAnnotations,
	type ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { operationAllowed } from "@tedix/api-contract/schemas/os-collaborators";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import {
	ListWorkAttemptStepsInputSchema,
	SendWorkAttemptMessageInputSchema,
	StopWorkAttemptInputSchema,
} from "@tedix/api-contract/schemas/work-attempt-steps";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import {
	listWorkAttemptSteps,
	sendWorkAttemptMessage,
} from "@tedix/db/queries/work-items/attempt-steps";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import {
	acceptWorkItem,
	createWorkItem,
	getWorkItemById,
	getWorkItemBySourceIntentId,
	listWorkItems,
} from "@tedix/db/queries/work-items/crud";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import {
	WORK_ITEM_KIND_VALUES,
	WORK_ITEM_PRIORITY_VALUES,
	type WorkItem,
	type WorkItemKind,
	type WorkItemPriority,
} from "@tedix/db/schema/work-items";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/tenant-store/outputs-schema";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { WorkspaceOutputRevisionNotice } from "@tedix/api-contract/utils/workspace-room";
import {
	OsOutputContentInputSchema,
	OsOutputContentSchema,
	OsDerivedAccessEnvelopeSchema,
	type OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import type {
	AppCode,
	CreateAppInput,
	CreatedApp,
	EditAppFilesInput,
	OutputDetail,
	OutputSummary,
	ResourceSummary,
	CreateWorkInput,
	WorkItemSummary,
	WorkspaceDataPort,
	WorkspaceSnapshot,
	StartRunInput,
	WorkspaceRunPort,
} from "./data-port";
import {
	WorkspaceFileTextSchema,
	workspaceFileTextKey,
	type WorkspaceFileText,
} from "@tedix/api-contract/utils/workspace-file-text";

export type OutputBodyBucket = Pick<R2Bucket, "get" | "put">;

/** Same key the core API writes, so one body serves both planes. */
export function outputRevisionBodyKey(organizationId: string, sha256: string) {
	if (
		!organizationId ||
		/[/\\]/.test(organizationId) ||
		[...organizationId].some((c) => c.charCodeAt(0) < 0x20)
	)
		throw new Error("Invalid output body organization");
	if (!/^[a-f0-9]{64}$/.test(sha256))
		throw new Error("Invalid output body digest");
	return `os-output-revisions/v1/${organizationId}/${sha256}.gz`;
}

export async function storeOutputBody(
	bucket: OutputBodyBucket,
	organizationId: string,
	content: string,
) {
	const bytes = new TextEncoder().encode(content);
	const contentSha256 = await sha256Hex(bytes);
	const bodyR2Key = outputRevisionBodyKey(organizationId, contentSha256);
	const compressed = await new Response(
		new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	await bucket.put(bodyR2Key, compressed);
	return { contentSha256, contentBytes: bytes.byteLength, bodyR2Key };
}

export async function readOutputBody(
	bucket: OutputBodyBucket,
	row: OsOutputRevisionRow,
): Promise<string> {
	if (row.content) return row.content;
	if (!row.bodyR2Key || !row.contentSha256)
		throw new Error("Output revision body is unavailable");
	const object = await bucket.get(row.bodyR2Key);
	if (!object) throw new Error("Output revision body object is missing");
	const bytes = await new Response(
		new Blob([await object.arrayBuffer()])
			.stream()
			.pipeThrough(new DecompressionStream("gzip")),
	).arrayBuffer();
	if ((await sha256Hex(bytes)) !== row.contentSha256)
		throw new Error("Output revision body digest mismatch");
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
		bytes,
	);
}

export interface TenantDataPortDeps {
	organizationId: string;
	workspaceId: string;
	tenant: TenantStoreDb;
	core: DbQueryClient;
	bucket: OutputBodyBucket;
	actorKind: "user" | "tedi" | "external_agent" | "service";
	/**
	 * The person the turn acts for, when a person started it. Decides which
	 * personal accounts count as connected; never written anywhere.
	 */
	actingUserId?: string | null;
	conversationId?: string;
	/**
	 * The agent turn writing through this port. Its saves stay attributed to
	 * the accountable actor and also record this turn, so an open editor can
	 * offer to undo an agent's change made on a person's behalf.
	 */
	agentTurnId?: string;
	assertWorkspaceAuthority: () => Promise<void>;
	validateAppSource: (
		files: Record<string, string>,
		compatibilityDate?: unknown,
	) => Promise<void>;
	commitOutput: <T>(outputId: string, write: () => Promise<T>) => Promise<T>;
	/** Tells everyone with the workspace open that a file has a new revision. */
	notifyOutputRevision: (
		notice: WorkspaceOutputRevisionNotice,
	) => Promise<void>;
}

const StartRunInputSchema = z.strictObject({
	title: z.string().trim().min(1).max(500),
	brief: z.string().trim().min(1).max(10_000),
	doneWhen: z.string().trim().min(1).max(2_000),
	executor: z.enum(["codex", "claude-code"]),
	projectId: z.uuid().optional(),
});

const APP_NAME_TAKEN = "An app with this name already exists in this workspace";

/** The same name and description limits the API applies to a new app. */
const CreateAppInputSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		description: z.string().max(2000).optional(),
		files: AppRuntimeFilesSchema,
	})
	.strict();

function readableInputError(error: unknown): never {
	if (error instanceof z.ZodError)
		throw new Error(
			error.issues
				.map((issue) =>
					issue.path.length
						? `${issue.path.join(".")}: ${issue.message}`
						: issue.message,
				)
				.join("; ")
				.slice(0, 2000),
		);
	throw error;
}

export class TenantDataPort implements WorkspaceDataPort, WorkspaceRunPort {
	constructor(private readonly deps: TenantDataPortDeps) {}

	private get scope() {
		return {
			organizationId: this.deps.organizationId,
			workspaceId: this.deps.workspaceId,
		};
	}

	async workspace(): Promise<WorkspaceSnapshot> {
		const row = await getOsWorkspace(this.deps.core, this.scope);
		if (!row) throw new Error("Workspace not found");
		const projects = await listOsWorkspaceProjects(this.deps.core, {
			...this.scope,
			status: "active",
		});
		return {
			id: row.id,
			name: row.name,
			description: row.description,
			organizationId: row.organizationId,
			projectIds: projects.map((project) => project.projectId),
		};
	}

	private async locate(outputId: string) {
		const params = { ...this.scope, outputId };
		await this.deps.assertWorkspaceAuthority();
		const row = await getOsOutput(this.deps.tenant, params);
		if (!row || row.workspaceId !== this.deps.workspaceId) return null;
		const revision = row.currentRevisionId
			? await getOsOutputRevision(this.deps.tenant, {
					...this.scope,
					revisionId: row.currentRevisionId,
				})
			: undefined;
		if (revision && revision.outputId !== row.id) return null;
		return { row, revision };
	}

	private summary(
		row: OsOutputRow,
		revision?: OsOutputRevisionRow,
	): OutputSummary {
		return {
			id: row.id,
			kind: row.kind,
			title: row.title,
			status: row.status,
			revision: revision?.revision ?? 0,
			revisionId: row.currentRevisionId,
			updatedAt: row.updatedAt,
		};
	}

	private canRead(revision: OsOutputRevisionRow | undefined): boolean {
		if (!revision?.accessEnvelope) return false;
		let envelope: unknown;
		try {
			envelope = JSON.parse(revision.accessEnvelope);
		} catch {
			return false;
		}
		const parsed = OsDerivedAccessEnvelopeSchema.safeParse(envelope);
		// This port has no provider credential authority. Derived sources require
		// the API's source checks before their content can be released.
		return parsed.success && parsed.data.sources.length === 0;
	}

	async readFileText(file: {
		workspaceId: string;
		resourceId: string;
	}): Promise<WorkspaceFileText | null> {
		if (file.workspaceId !== this.deps.workspaceId) return null;
		const object = await this.deps.bucket.get(
			workspaceFileTextKey(
				this.deps.organizationId,
				file.workspaceId,
				file.resourceId,
			),
		);
		if (!object) return null;
		const parsed = WorkspaceFileTextSchema.safeParse(await object.json());
		return parsed.success ? parsed.data : null;
	}

	async listOutputs(options?: {
		kind?: OutputSummary["kind"];
		status?: OutputSummary["status"];
	}): Promise<OutputSummary[]> {
		const viewer = { userIds: [], workspaceIds: [this.deps.workspaceId] };
		await this.deps.assertWorkspaceAuthority();
		const owned = await listOsOutputs(
			this.deps.tenant,
			this.deps.organizationId,
			viewer,
			{ workspaceId: this.deps.workspaceId, ...options, limit: 500 },
		);
		const ids = new Set(owned.map((row) => row.id));
		const rows = await Promise.all([...ids].map((id) => this.locate(id)));
		return rows
			.filter(
				(value) =>
					value &&
					this.canRead(value.revision) &&
					(!options?.kind || value.row.kind === options.kind) &&
					(!options?.status || value.row.status === options.status),
			)
			.map((value) => this.summary(value!.row, value!.revision))
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async getOutput(outputId: string): Promise<OutputDetail | null> {
		const located = await this.locate(outputId);
		if (!located) return null;
		const { row, revision } = located;
		if (!revision || !this.canRead(revision)) return null;
		const summary = this.summary(row, revision);
		const body = await readOutputBody(this.deps.bucket, revision);
		return {
			...summary,
			content: OsOutputContentSchema.parse(JSON.parse(body)),
		};
	}

	async createOutput(input: {
		title: string;
		content: OsOutputContent;
		actorId: string;
	}): Promise<OutputDetail> {
		await this.deps.assertWorkspaceAuthority();
		const content = OsOutputContentInputSchema.parse(input.content);
		const body = JSON.stringify(content);
		const stored = await storeOutputBody(
			this.deps.bucket,
			this.deps.organizationId,
			body,
		);
		const outputId = crypto.randomUUID();
		const revisionId = crypto.randomUUID();
		const now = new Date().toISOString();
		const created = await this.deps.commitOutput(outputId, () =>
			createOsOutput(
				this.deps.tenant,
				{
					id: outputId,
					organizationId: this.deps.organizationId,
					workspaceId: this.deps.workspaceId,
					kind: content.kind,
					title: input.title,
					status: "active",
					currentRevisionId: revisionId,
					createdByKind: this.deps.actorKind,
					createdById: input.actorId,
					createdAt: now,
					updatedAt: now,
				},
				{
					id: revisionId,
					organizationId: this.deps.organizationId,
					outputId,
					revision: 1,
					content: "",
					accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
					createdByKind: this.deps.actorKind,
					createdById: input.actorId,
					createdAt: now,
					agentTurnId: this.deps.agentTurnId ?? null,
					...stored,
				},
			),
		);
		return { ...this.summary(created.output, created.revision), content };
	}

	async reviseOutput(input: {
		outputId: string;
		content: OsOutputContent;
		expectedRevision: number;
		actorId: string;
		note?: string;
	}): Promise<OutputDetail> {
		const existing = await this.getOutput(input.outputId);
		if (!existing) throw new Error("Output not found");
		const content = OsOutputContentInputSchema.parse(input.content);
		if (content.kind !== existing.kind)
			throw new Error(
				`Output is a ${existing.kind}; a ${content.kind} body cannot revise it`,
			);
		const stored = await storeOutputBody(
			this.deps.bucket,
			this.deps.organizationId,
			JSON.stringify(content),
		);
		const params = {
			id: crypto.randomUUID(),
			organizationId: this.deps.organizationId,
			outputId: input.outputId,
			...stored,
			content: "",
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			note: input.note ?? null,
			createdByKind: this.deps.actorKind,
			createdById: input.actorId,
			expectedRevision: input.expectedRevision,
			agentTurnId: this.deps.agentTurnId,
		};
		const result = await this.deps.commitOutput(input.outputId, () =>
			createOsOutputRevision(this.deps.tenant, params),
		);
		if (!result.ok) throw new Error(`Revise failed: ${result.reason}`);
		if (result.revision.revision !== existing.revision)
			await this.deps.notifyOutputRevision({
				outputId: input.outputId,
				revisionId: result.revision.id,
				revision: result.revision.revision,
			});
		return {
			...existing,
			content,
			revision: result.revision.revision,
			revisionId: result.revision.id,
			updatedAt:
				result.revision.revision === existing.revision
					? existing.updatedAt
					: result.revision.createdAt,
		};
	}

	async listApps() {
		const rows = await listOsGadgets(this.deps.core, this.deps.organizationId, {
			workspaceId: this.deps.workspaceId,
			status: "active",
		});
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			status: row.status,
			updatedAt: row.updatedAt,
		}));
	}

	async getAppCode(input: {
		appId: string;
		revisionId?: string;
	}): Promise<AppCode> {
		const parsed = z
			.object({
				appId: z.string().min(1),
				revisionId: z.string().min(1).optional(),
			})
			.strict()
			.parse(input);
		const app = await getOsGadget(this.deps.core, {
			organizationId: this.deps.organizationId,
			gadgetId: parsed.appId,
		});
		if (
			!app ||
			app.workspaceId !== this.deps.workspaceId ||
			app.status !== "active"
		)
			throw new Error("App not found in this workspace");

		const pending =
			!parsed.revisionId && this.deps.conversationId
				? await getOsAppEditDraft(this.deps.core, {
						...this.scope,
						gadgetId: app.id,
						sourceKind: "chat",
						sourceId: this.deps.conversationId,
					})
				: undefined;
		const revisionId =
			parsed.revisionId ?? pending?.baseRevisionId ?? app.currentRevisionId;
		if (!revisionId) throw new Error("App has no revision");
		const params = { organizationId: this.deps.organizationId, revisionId };
		const revision = await getOsGadgetRevision(this.deps.core, params);
		if (!revision || revision.gadgetId !== app.id)
			throw new Error("App revision not found");
		const manifest = OsGadgetManifestSchema.parse(
			JSON.parse(revision.manifest),
		);
		if (!isAppRuntimeManifest(manifest))
			throw new Error("This app has no editable runtime source");
		const code = await getOsGadgetCode(this.deps.core, params);
		if (!code || code.gadgetId !== app.id)
			throw new Error("App source not found");
		const draft = pending
			? OsAppDraftContentSchema.parse(JSON.parse(pending.content))
			: undefined;
		return {
			id: app.id,
			name: app.name,
			revision: revision.revision,
			revisionId,
			manifest: draft?.manifest ?? manifest,
			files:
				draft?.files ?? AppRuntimeFilesSchema.parse(JSON.parse(code.files)),
			...(pending
				? { proposalId: pending.id, sequence: pending.sequence }
				: {}),
		};
	}

	async editAppFiles(
		input: EditAppFilesInput & { actorId: string },
	): Promise<AppCode> {
		const parsed = z
			.object({
				appId: z.string().min(1),
				expectedRevisionId: z.string().min(1),
				proposalId: z.string().min(1).optional(),
				expectedSequence: z.number().int().nonnegative().optional(),
				edits: z
					.array(
						z
							.object({
								path: z.string().min(1),
								before: z.string().min(1).optional(),
								after: z.string(),
							})
							.strict(),
					)
					.min(1)
					.max(24),
				actorId: z.string().min(1),
			})
			.strict()
			.parse(input);
		if (!this.deps.conversationId)
			throw new Error("App edits require a workspace conversation");
		const current = await this.getAppCode({ appId: parsed.appId });
		if (current.revisionId !== parsed.expectedRevisionId)
			throw new Error(
				"App revision conflict; read the current source before editing again",
			);
		const proposal = await proposeOsAppFileEdits(
			this.deps.core,
			{
				...this.scope,
				gadgetId: current.id,
				sourceKind: "chat",
				sourceId: this.deps.conversationId,
				proposalId: parsed.proposalId,
				expectedSequence: parsed.expectedSequence,
				baseRevisionId: current.revisionId,
				baseRevision: current.revision,
				content: { manifest: current.manifest, files: current.files },
				edits: parsed.edits,
				createdByKind: this.deps.actorKind,
				createdById: parsed.actorId,
			},
			(content) =>
				this.deps.validateAppSource(
					content.files,
					content.manifest.config?.compatibilityDate,
				),
		);
		return {
			...current,
			files: OsAppDraftContentSchema.parse(JSON.parse(proposal.content)).files,
			proposalId: proposal.id,
			sequence: proposal.sequence,
		};
	}

	private async checkedNewApp(input: CreateAppInput) {
		let parsed: z.infer<typeof CreateAppInputSchema>;
		try {
			parsed = CreateAppInputSchema.parse(input);
		} catch (error) {
			readableInputError(error);
		}
		// A name is taken by an archived app too.
		const existing = await listOsGadgets(
			this.deps.core,
			this.deps.organizationId,
			{ workspaceId: this.deps.workspaceId, limit: 500 },
		);
		if (existing.some((app) => app.name === parsed.name))
			throw new Error(APP_NAME_TAKEN);
		await this.deps.validateAppSource(parsed.files);
		return parsed;
	}

	async checkNewApp(input: CreateAppInput): Promise<void> {
		await this.checkedNewApp(input);
	}

	async createApp(
		input: CreateAppInput & { actorId: string },
	): Promise<CreatedApp> {
		const { actorId, ...request } = input;
		if (typeof actorId !== "string" || !actorId)
			throw new Error("A new app needs the actor who creates it");
		const parsed = await this.checkedNewApp(request);
		const id = crypto.randomUUID();
		const revisionId = crypto.randomUUID();
		const now = new Date().toISOString();
		const scope = { organizationId: this.deps.organizationId, gadgetId: id };
		try {
			await createOsGadget(this.deps.core, {
				id,
				organizationId: this.deps.organizationId,
				workspaceId: this.deps.workspaceId,
				name: parsed.name,
				description: parsed.description ?? null,
				status: "active",
				currentRevisionId: null,
				createdByKind: this.deps.actorKind,
				createdById: actorId,
				createdAt: now,
				updatedAt: now,
			});
		} catch (error) {
			for (let cause = error; cause instanceof Error; cause = cause.cause)
				if (/unique constraint/i.test(cause.message))
					throw new Error(APP_NAME_TAKEN);
			throw error;
		}
		// The app and its first revision belong together: an app whose code
		// could not be saved is removed again.
		const saved = await createOsGadgetRevision(this.deps.core, {
			id: revisionId,
			organizationId: this.deps.organizationId,
			gadgetId: id,
			// No resource grants: a new app reads and writes only its own storage.
			manifest: JSON.stringify({
				entry: APP_RUNTIME_ENTRY,
				capabilities: [],
				config: { version: 1 },
			}),
			createdByKind: this.deps.actorKind,
			createdById: actorId,
			expectedRevision: 0,
			code: {
				files: JSON.stringify(parsed.files),
				codeLength: appRuntimeCodeLength(parsed.files),
			},
		}).catch(async (error: unknown) => {
			await deleteOsGadget(this.deps.core, scope).catch(() => false);
			throw error;
		});
		if (!saved.ok) {
			await deleteOsGadget(this.deps.core, scope).catch(() => false);
			throw new Error("The new app's first revision could not be saved");
		}
		return {
			id,
			name: parsed.name,
			revision: saved.revision.revision,
			revisionId,
		};
	}

	async registerAppSchedule(
		input: RegisterAppScheduleInput & { actorId: string },
	) {
		await this.#runActor();
		const parsed = RegisterAppScheduleInputSchema.parse({
			appId: input.appId,
			expectedRevisionId: input.expectedRevisionId,
			schedule: input.schedule,
		});
		const current = await this.getAppCode({ appId: parsed.appId });
		if (current.proposalId || current.revisionId !== parsed.expectedRevisionId)
			throw new Error(
				"The app changed. Finish its pending edits and read the current source first.",
			);
		const config = AppRuntimeConfigSchema.parse(current.manifest.config);
		if (config.triggers?.some((trigger) => trigger.id === parsed.schedule.id))
			throw new Error("This automatic run already exists. Choose a new name.");
		const manifest = OsGadgetManifestSchema.parse({
			...current.manifest,
			config: {
				...config,
				triggers: [...(config.triggers ?? []), parsed.schedule],
			},
		});
		const switched = await setOsAppTriggerEnabled(this.deps.core, {
			...this.scope,
			gadgetId: current.id,
			revisionId: current.revisionId,
			triggerId: parsed.schedule.id,
			enabled: false,
		});
		if (!switched)
			throw new Error(
				"The app changed. Read the current source and try again.",
			);
		const saved = await createOsGadgetRevision(this.deps.core, {
			id: crypto.randomUUID(),
			organizationId: this.deps.organizationId,
			gadgetId: current.id,
			manifest: JSON.stringify(manifest),
			expectedRevision: current.revision,
			createdByKind: this.deps.actorKind,
			createdById: input.actorId,
			code: {
				files: JSON.stringify(current.files),
				codeLength: appRuntimeCodeLength(current.files),
			},
		});
		if (!saved.ok)
			throw new Error(
				"The app changed. Read the current source and try again.",
			);
		return {
			gadgetId: current.id,
			triggerId: parsed.schedule.id,
			name: current.name,
		};
	}

	async listResources(): Promise<ResourceSummary[]> {
		await this.deps.assertWorkspaceAuthority();
		const rows = await listWorkspaceResourceSummaries(
			this.deps.tenant,
			this.scope,
		);
		// Workspace files and the like need no account and no lookup.
		const providerIds = rows
			.filter((row) => row.connectionInstanceId)
			.map((row) => row.providerId);
		const person = this.deps.actingUserId ?? undefined;
		const [accounts, names] = providerIds.length
			? await Promise.all([
					listConnectedAccounts(this.deps.core, {
						organizationId: this.deps.organizationId,
						...(person ? { userId: person } : {}),
						providerIds,
					}),
					listConnectionProviderNames(this.deps.core, providerIds),
				])
			: [[], new Map<string, string>()];
		// The same rule a workspace app's read follows: an organization source
		// uses its one shared account; a personal source uses the reader's own
		// account, never its owner's on someone else's behalf.
		const connected = (row: (typeof rows)[number]) => {
			if (!row.connectionInstanceId) return null;
			const scope = row.connectionScope;
			const ofProvider = accounts.filter(
				(account) =>
					account.scope === scope && account.providerId === row.providerId,
			);
			if (scope === "user" && !person) return false;
			return scope === "user" && row.personalOwnerUserId !== person
				? ofProvider.length > 0
				: ofProvider.some((account) => account.id === row.connectionInstanceId);
		};
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.kind,
			status: row.status,
			slot: row.slot,
			providerId: row.providerId,
			service: names.get(row.providerId) ?? row.providerId,
			connectionScope:
				row.connectionScope === "user" ? "personal" : "organization",
			connectionInstanceId: row.connectionInstanceId,
			providerAccess: row.providerAccess ?? null,
			connectedForYou: connected(row),
		}));
	}

	async describeAccount(resourceId: string) {
		await this.deps.assertWorkspaceAuthority();
		const resource = await getOsWorkspaceResource(this.deps.tenant, {
			...this.scope,
			resourceId,
		});
		if (
			resource?.status !== "active" ||
			!resource.connectionInstanceId ||
			!["user", "tenant"].includes(resource.connectionScope) ||
			resource.providerAccess?.canRead === false
		)
			throw new Error("This linked source is unavailable for reads.");
		const { organizationId } = this.deps;
		const core = createDbClient(this.deps.core.$client);
		const { providerId, connectionInstanceId, connectionScope } = resource;
		const route = {
			organizationId,
			providerId,
			connectionInstanceId,
			connectionScope,
		};
		const candidates = await listAppsReferencingConnectionProvider(
			core,
			providerId,
			{
				organizationId,
			},
		);
		const scopes = new Set<string>(JSON.parse(resource.requiredScopes));
		const tools = [];
		for (const candidate of candidates) {
			if (candidate.connectionProviderId !== providerId) continue;
			const surface = await getAppByIdWithToolsForOrganization(
				core,
				candidate.id,
				organizationId,
			);
			const routing = surface?.app.metadata?.mcpConfig;
			if (
				!surface ||
				routing?.connectionProviderId !== providerId ||
				routing.connectionInstanceId !== connectionInstanceId ||
				routing.connectionScope !== connectionScope
			)
				continue;
			for (const tool of surface.tools) {
				const config = tool.config as ToolConfig | null;
				const auth = config?.auth;
				const annotations = resolveToolAnnotations(tool);
				const binding = PersonalResourceToolBindingSchema.safeParse(
					config?.personalResourceBinding,
				);
				if (
					!tool.enabled ||
					!["external", "mcp"].includes(config?.transport ?? "") ||
					config?.connectionReadOnly !== true ||
					annotations?.readOnlyHint !== true ||
					annotations.destructiveHint === true ||
					auth?.type !== "connection" ||
					auth.connectionId !== providerId ||
					new Set(auth.scopes ?? []).size !== scopes.size ||
					!(auth.scopes ?? []).every((scope) => scopes.has(scope)) ||
					!binding.success ||
					binding.data.resourceType !== resource.resourceType ||
					binding.data.operation !== "read" ||
					!("paths" in binding.data)
				)
					continue;
				const resolved = await findWorkspaceConnectionTool(core, {
					...route,
					toolName: tool.toolId,
				});
				if (resolved?.appId === candidate.id)
					tools.push({
						name: tool.toolId,
						inputSchema: tool.inputSchema,
						resourcePaths: binding.data.paths,
					});
			}
		}
		return { providerResourceId: resource.providerResourceId, tools };
	}

	async listWork(options?: { disposition?: string; limit?: number }) {
		const { projectIds } = await this.workspace();
		const limit = Math.min(Math.max(options?.limit ?? 200, 1), 500);
		const pages = await Promise.all(
			projectIds.map((projectId) =>
				listWorkItems(this.deps.core, {
					orgId: this.deps.organizationId,
					projectId,
					...(options?.disposition
						? { disposition: options.disposition as never }
						: {}),
					limit,
				}),
			),
		);
		return pages
			.flat()
			.map(workSummary)
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
			.slice(0, limit);
	}

	async createWork(
		input: CreateWorkInput & { actorId: string },
	): Promise<WorkItemSummary> {
		const title = input.title?.trim();
		if (!title) throw new Error("A Work Item needs a title");
		const workKind = input.workKind ?? "other";
		if (!(WORK_ITEM_KIND_VALUES as readonly string[]).includes(workKind))
			throw new Error(`Unknown Work kind ${workKind}`);
		const priority = input.priority ?? "medium";
		if (!(WORK_ITEM_PRIORITY_VALUES as readonly string[]).includes(priority))
			throw new Error(`Unknown Work priority ${priority}`);
		const project = await this.#workProject(input.projectId);
		const now = new Date();
		const actorType =
			this.deps.actorKind === "service" ? "system" : this.deps.actorKind;
		const item = await createWorkItem(this.deps.core, {
			id: crypto.randomUUID(),
			orgId: this.deps.organizationId,
			createdBy: { type: actorType, id: input.actorId },
			title,
			...(input.description?.trim()
				? { description: input.description.trim() }
				: {}),
			workKind: workKind as WorkItemKind,
			priority: priority as WorkItemPriority,
			projectId: project.id,
			...(this.deps.actorKind === "user"
				? { stewardType: "user" as const, stewardId: input.actorId }
				: {}),
			...workItemPurposeFor({
				objectiveId: project.objectiveId,
				workClass: "maintenance",
				now,
			}),
			sourceSessionKey: this.deps.workspaceId,
			provenance: {
				source: "os.workspace.chat",
				workspaceId: this.deps.workspaceId,
			},
			createdAt: now.toISOString(),
		});
		return workSummary(item);
	}

	async #workProject(requestedProjectId?: string) {
		const { projectIds } = await this.workspace();
		const projectId =
			requestedProjectId ??
			(projectIds.length === 1 ? projectIds[0] : undefined);
		if (!projectId)
			throw new Error(
				projectIds.length === 0
					? "This workspace is not linked to a project, so it cannot file Work"
					: `Choose a projectId: ${projectIds.join(", ")}`,
			);
		if (!projectIds.includes(projectId))
			throw new Error("That project is not linked to this workspace");
		const project = await getProjectByIdForOrganization(
			this.deps.core,
			this.deps.organizationId,
			projectId,
		);
		if (!project) throw new Error("Project not found");
		return project;
	}

	async #runActor() {
		const { actingUserId, conversationId, agentTurnId } = this.deps;
		if (
			!actingUserId ||
			!conversationId ||
			!agentTurnId ||
			!operationAllowed(
				await readWorkspaceRuntimeRole(this.deps.core, this.deps, {
					actorKind: "user",
					actorId: actingUserId,
				}),
				"app.chat",
			)
		)
			throw new Error(
				"A person with build access must request this in workspace chat",
			);
		return {
			actor: { type: "user" as const, id: actingUserId },
			sourceSessionKey:
				"workspace:" + this.deps.workspaceId + ":" + conversationId,
			agentTurnId,
		};
	}

	async startRun(input: StartRunInput) {
		const { actor, sourceSessionKey, agentTurnId } = await this.#runActor();
		const { title, brief, doneWhen, executor, projectId } =
			StartRunInputSchema.parse(input);
		const project = await this.#workProject(projectId);
		const { core, organizationId: orgId, workspaceId } = this.deps;
		const now = new Date();
		const intent = {
			orgId,
			sourceIntentId: sourceSessionKey + ":" + agentTurnId,
		};
		const item = await createWorkItem(core, {
			id: crypto.randomUUID(),
			orgId,
			createdBy: actor,
			accountableOwnerType: actor.type,
			accountableOwnerId: actor.id,
			stewardType: actor.type,
			stewardId: actor.id,
			title,
			description: brief,
			workKind: "coding",
			projectId: project.id,
			...(project.objectiveId
				? { objectiveId: project.objectiveId, workClass: "objective" as const }
				: workItemPurposeFor({ workClass: "maintenance", now })),
			executorType: "external_agent",
			executorId: executor,
			sourceSessionKey,
			sourceIntentId: intent.sourceIntentId,
			provenance: { source: "os.workspace.chat", workspaceId },
			createdAt: now.toISOString(),
		}).catch(async (error: unknown) => {
			const existing = await getWorkItemBySourceIntentId(core, intent);
			if (!existing) throw error;
			if (
				existing.sourceSessionKey !== sourceSessionKey ||
				existing.accountableOwnerId !== actor.id ||
				existing.title !== title ||
				existing.description !== brief ||
				existing.executorId !== executor ||
				existing.projectId !== project.id ||
				(existing.acceptanceContract &&
					existing.acceptanceContract.doneLooksLike !== doneWhen)
			)
				throw new Error(
					"A different coding task was already filed by this message",
				);
			return existing;
		});
		try {
			if (item.disposition === "proposed") {
				await acceptWorkItem(core, {
					orgId,
					workItemId: item.id,
					acceptanceContract: { version: 1, doneLooksLike: doneWhen },
					actor,
				});
			}
		} catch (error) {
			const current = await getWorkItemById(core, item.id, orgId);
			if (current?.acceptanceContract?.doneLooksLike !== doneWhen)
				throw new Error(
					"Task /work/items/" +
						item.id +
						" was filed but could not be accepted: " +
						(error instanceof Error ? error.message : String(error)),
				);
		}
		return {
			kind: "agent_run" as const,
			workItemId: item.id,
			title,
			executor,
			url: "/work/items/" + item.id,
		};
	}

	async #runInConversation(workItemId: string) {
		const { actor, sourceSessionKey } = await this.#runActor();
		const item = await getWorkItemById(
			this.deps.core,
			workItemId,
			this.deps.organizationId,
		);
		if (
			!item ||
			item.executorType !== "external_agent" ||
			item.sourceSessionKey !== sourceSessionKey
		)
			throw new Error("This run was not started in this conversation");
		return { item, actor };
	}

	async readRun(input: { workItemId: string; afterSeq?: number }) {
		const { id: workItemId, afterSeq } = ListWorkAttemptStepsInputSchema.parse({
			id: input.workItemId,
			afterSeq: input.afterSeq,
		});
		const { item } = await this.#runInConversation(workItemId);
		const params = { orgId: item.orgId, workItemId, afterSeq, limit: 500 };
		let page = await listWorkAttemptSteps(this.deps.core, params);
		let steps = page.steps.slice(-40);
		// Keep the newest 40 even when the run's log spans several pages.
		for (
			let pages = 1;
			pages < 4 && page.attemptId && page.steps.length === params.limit;
			pages++
		) {
			page = await listWorkAttemptSteps(this.deps.core, {
				...params,
				attemptId: page.attemptId,
				afterSeq: page.steps.at(-1)!.seq,
			});
			steps = [...steps, ...page.steps].slice(-40);
		}
		return {
			kind: "agent_run_steps" as const,
			workItemId,
			live: page.live,
			steps: steps.map(({ seq, at, kind, text }) => ({
				seq,
				at,
				kind,
				text: wrapUntrustedInput(text, "agent_run"),
			})),
			messages: page.messages.map(
				({
					id,
					kind,
					body,
					senderType,
					senderId,
					interrupt,
					createdAt,
					deliveredAt,
					appliedAt,
				}) => ({
					id,
					kind,
					body: wrapUntrustedInput(body, "agent_run"),
					senderType,
					senderId,
					interrupt,
					createdAt,
					deliveredAt,
					appliedAt,
				}),
			),
		};
	}

	async #steerRun(
		workItemId: string,
		kind: "follow_up" | "stop",
		body: string,
	) {
		const { item, actor } = await this.#runInConversation(workItemId);
		if (
			item.accountableOwnerType !== actor.type ||
			item.accountableOwnerId !== actor.id
		)
			throw new Error("The person who owns this task can steer its run");
		const message = await sendWorkAttemptMessage(this.deps.core, {
			orgId: item.orgId,
			workItemId,
			kind,
			body,
			sender: actor,
		});
		if (!message)
			throw new Error(
				kind === "stop"
					? "No run is in progress"
					: "This run no longer accepts a message",
			);
		return message;
	}

	async sendRunMessage(input: { workItemId: string; message: string }) {
		const { id: workItemId, body } = SendWorkAttemptMessageInputSchema.parse({
			id: input.workItemId,
			body: input.message,
		});
		const message = await this.#steerRun(workItemId, "follow_up", body);
		return {
			kind: "agent_run_message" as const,
			workItemId,
			messageId: message.id,
		};
	}

	async stopRun(input: { workItemId: string }) {
		const { id: workItemId } = StopWorkAttemptInputSchema.parse({
			id: input.workItemId,
		});
		await this.#steerRun(workItemId, "stop", "");
		return { kind: "agent_run_stop" as const, workItemId };
	}
}

function workSummary(item: WorkItem): WorkItemSummary {
	return {
		id: item.id,
		title: item.title,
		disposition: item.disposition,
		workKind: item.workKind,
		priority: item.priority ?? null,
		projectId: item.projectId ?? null,
		updatedAt: item.updatedAt ?? item.createdAt,
	};
}
