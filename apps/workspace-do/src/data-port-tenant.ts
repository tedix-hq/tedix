/**
 * Outputs and revisions live in the activated workspace object. Bodies are
 * gzip objects in R2 addressed by digest. Resources use the workspace object;
 * apps and Work items use the core database.
 */
import type {
	PublishAppDraft,
	StagedAppDraft,
} from "@tedix/api-contract/schemas/workspace-app-draft";
import type { ApprovalMode } from "@tedix/api-contract/schemas/workspace-agent-access";
import type { DbQueryClient } from "@tedix/db/query-client";
import { createDbClient } from "@tedix/db/client";
import {
	createOsOutput,
	createOsOutputRevision,
	getOsOutput,
	getOsOutputRevision,
	replaceOsOutputRevisionBody,
	listOsOutputs,
} from "@tedix/db/queries/durable-sqlite/os-outputs";
import { migrateSheetBlocks } from "@tedix/workspace-feed/sheet-block-migration";
import {
	readSheetBlocks,
	sheetBlockManifest,
	storeSheetBlocks,
	type SheetBlockManifest,
} from "@tedix/workspace-feed/sheet-blocks";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	createOsGadget,
	createOsGadgetRevision,
	deleteOsGadget,
	listOsGadgets,
	getOsGadget,
	getOsGadgetRevision,
	getOsGadgetCode,
	listOsGadgetRevisions,
	setOsAppTriggerEnabled,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	OsAppDraftContentSchema,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	APP_RUNTIME_ENTRY,
	AllowAppReadInputSchema,
	AppRuntimeFilesSchema,
	AppRuntimeConfigSchema,
	AppRuntimeReadsSchema,
	appTriggerDefinition,
	type AllowAppReadInput,
	type AppRuntimeReads,
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
import {
	ensureOsWorkspaceResource,
	findOsWorkspaceTenantResource,
	getOsWorkspaceResource,
	projectOsWorkspaceResource,
} from "@tedix/db/queries/os-workspaces/resources";
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
	listLiveWorkRuns,
	listWorkAttemptSteps,
	queueWorkItemFollowUp,
	sendWorkAttemptMessage,
} from "@tedix/db/queries/work-items/attempt-steps";
import {
	LIVE_WORK_ATTEMPT_RUNTIME_STATES,
	listWorkItemAttempts,
} from "@tedix/db/queries/work-items/attempts";
import { listTediDisplayNamesByIds } from "@tedix/db/queries/tedis";
import { listWorkItemEvidence } from "@tedix/db/queries/work-items/evidence";
import {
	addWorkItemComment,
	listRecentWorkItemComments,
} from "@tedix/db/queries/work-items/comments";
import {
	getProjectByIdForOrganization,
	listActiveProjectsForOrganization,
} from "@tedix/db/queries/projects";
import type { Project } from "@tedix/db/schema/projects";
import { getMemberAccessByUserId } from "@tedix/db/queries/organization-members";
import { WORKSPACE_RUN_SOURCE } from "@tedix/db/queries/work-items/agent-runs";
import { WorkOperatorsSchema } from "@tedix/api-contract/schemas/work-specification-policy";
import {
	acceptWorkItem,
	createWorkItem,
	getWorkItemById,
	getWorkItemBySourceIntentId,
	listOpenWorkItemsAcrossProjects,
	listWorkItemsPage,
} from "@tedix/db/queries/work-items/crud";
import { workItemPurposeFor } from "@tedix/db/queries/work-items/purpose";
import {
	WORK_ITEM_DISPOSITION_VALUES,
	WORK_ITEM_KIND_VALUES,
	WORK_ITEM_PRIORITY_VALUES,
	type WorkItem,
	type WorkItemDisposition,
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
	AppVersion,
	CreateAppInput,
	CreatedApp,
	EditAppFilesInput,
	OutputDetail,
	OutputSummary,
	ResourceSummary,
	CreateWorkInput,
	LiveRunSummary,
	OpenWorkList,
	WorkItemDetail,
	WorkItemSummary,
	WorkListOptions,
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
	previous?: SheetBlockManifest,
) {
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		/* Plain text bodies remain valid. */
	}
	if (parsed?.kind === "sheet")
		content = JSON.stringify(
			await storeSheetBlocks(bucket, organizationId, parsed, previous),
		);
	const bytes = new TextEncoder().encode(content);
	const contentSha256 = await sha256Hex(bytes);
	const bodyR2Key = outputRevisionBodyKey(organizationId, contentSha256);
	const compressed = await new Response(
		new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
	).arrayBuffer();
	await bucket.put(bodyR2Key, compressed);
	return { contentSha256, contentBytes: bytes.byteLength, bodyR2Key };
}

async function readStoredBody(
	bucket: OutputBodyBucket,
	row: OsOutputRevisionRow,
): Promise<string> {
	if (row.content) return row.content;
	if (!row.bodyR2Key || !row.contentSha256)
		throw new Error("Output revision body is unavailable");
	if (
		row.bodyR2Key !==
		outputRevisionBodyKey(row.organizationId, row.contentSha256)
	)
		throw new Error(
			"Output revision body key does not match its organization and digest",
		);
	const object = await bucket.get(row.bodyR2Key);
	if (!object) throw new Error("Output revision body object is missing");
	const bytes = await new Response(
		new Blob([await object.arrayBuffer()])
			.stream()
			.pipeThrough(new DecompressionStream("gzip")),
	).arrayBuffer();
	if ((await sha256Hex(bytes)) !== row.contentSha256)
		throw new Error("Output revision body digest mismatch");
	if (row.contentBytes != null && bytes.byteLength !== row.contentBytes)
		throw new Error("Output revision body length mismatch");
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
		bytes,
	);
}

export async function readOutputBody(
	bucket: OutputBodyBucket,
	row: OsOutputRevisionRow,
	storedContent?: string,
): Promise<string> {
	const started = performance.now();
	const content = storedContent ?? (await readStoredBody(bucket, row));
	const manifest = sheetBlockManifest(content);
	if (!manifest) return content;
	const storageMs = Math.round(performance.now() - started);
	console.info({
		event: "os_output_sheet_body_read_start",
		outputId: row.outputId,
		revisionId: row.id,
		storageMs,
	});
	const body = JSON.stringify(
		await readSheetBlocks(bucket, row.organizationId, manifest),
	);
	console.info({
		event: "os_output_sheet_body_read",
		outputId: row.outputId,
		revisionId: row.id,
		storageMs,
		totalMs: Math.round(performance.now() - started),
	});
	return body;
}

export interface TenantDataPortDeps {
	organizationId: string;
	workspaceId: string;
	tenant: TenantStoreDb;
	core: DbQueryClient;
	bucket: OutputBodyBucket;
	workspaceFiles: Pick<R2Bucket, "get">;
	actorKind: "user" | "tedi" | "external_agent" | "service";
	/**
	 * The person the turn acts for, when a person started it. Decides which
	 * personal accounts count as connected; never written anywhere.
	 */
	actingUserId?: string | null;
	availableConnections?: () => Promise<
		import("@tedix/api-contract/schemas/workspace-available-connections").AvailableWorkspaceConnection[]
	>;
	/**
	 * The acting person sent the turn themself and nobody else can open the
	 * workspace: its Work reaches every project that person may use, not
	 * only the linked ones.
	 */
	personScope?: boolean;
	/** The turn's approval mode; a run started from the turn records it. */
	approvalMode?: ApprovalMode;
	/** The tedi answering the turn; its home project is the default for a run. */
	answeringTediId?: string | null;
	conversationId?: string;
	/**
	 * The agent turn writing through this port. Its saves stay attributed to
	 * the accountable actor and also record this turn, so an open editor can
	 * offer to undo an agent's change made on a person's behalf.
	 */
	agentTurnId?: string;
	appDraftStaged?: (draft: StagedAppDraft) => void;
	publishAppDraft?: (input: PublishAppDraft) => Promise<CreatedApp>;
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
	executor: z.enum(["codex", "claude-code", "any-local"]),
	changesCode: z.boolean().optional(),
	requiresRepository: z.boolean().optional(),
	projectId: z.uuid().optional(),
});

const OPERATOR_REFUSAL =
	"Accepting a task in that project needs an organization owner or admin, or a member the project names as an operator";

const APP_NAME_TAKEN = "An app with this name already exists in this workspace";

/** The same name and description limits the API applies to a new app. */
const CreateAppInputSchema = z
	.object({
		name: z.string().trim().min(1).max(120),
		description: z.string().max(2000).optional(),
		files: AppRuntimeFilesSchema,
		reads: AppRuntimeReadsSchema.optional(),
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
		chatOnly?: true;
	}): Promise<WorkspaceFileText | null> {
		if (file.workspaceId !== this.deps.workspaceId) return null;
		const object = await this.deps.workspaceFiles.get(
			workspaceFileTextKey(
				this.deps.organizationId,
				file.workspaceId,
				file.resourceId,
				file.chatOnly,
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
		const started = performance.now();
		const located = await this.locate(outputId);
		if (!located) return null;
		const { row, revision } = located;
		if (!revision || !this.canRead(revision)) return null;
		const summary = this.summary(row, revision);
		const lookupMs = Math.round(performance.now() - started);
		let storedContent = await readStoredBody(this.deps.bucket, revision);
		const migrated = await migrateSheetBlocks(
			this.deps.bucket,
			this.deps.organizationId,
			storedContent,
		);
		if (migrated) {
			if (!revision.contentSha256)
				throw new Error("Sheet migration requires a verified revision body");
			storedContent = JSON.stringify(migrated);
			const stored = await storeOutputBody(
				this.deps.bucket,
				this.deps.organizationId,
				storedContent,
			);
			const changed = await this.deps.commitOutput(outputId, () =>
				replaceOsOutputRevisionBody(this.deps.tenant, {
					organizationId: this.deps.organizationId,
					revisionId: revision.id,
					previousSha256: revision.contentSha256!,
					...stored,
				}),
			);
			if (!changed) {
				const current = await getOsOutputRevision(this.deps.tenant, {
					...this.scope,
					revisionId: revision.id,
				});
				if (current?.contentSha256 !== stored.contentSha256)
					throw new Error(
						"Sheet revision changed during migration; reopen the file",
					);
			}
		}
		const body = await readOutputBody(
			this.deps.bucket,
			revision,
			storedContent,
		);
		const result = {
			...summary,
			content: OsOutputContentSchema.parse(JSON.parse(body)),
		};
		if (row.kind === "sheet")
			console.info({
				event: "os_output_sheet_app_read",
				outputId,
				revisionId: revision.id,
				lookupMs,
				totalMs: Math.round(performance.now() - started),
			});
		return result;
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
		let previous: SheetBlockManifest | undefined;
		if (content.kind === "sheet") {
			const located = await this.locate(input.outputId);
			if (located?.revision)
				previous =
					sheetBlockManifest(
						await readStoredBody(this.deps.bucket, located.revision),
					) ?? undefined;
		}
		const stored = await storeOutputBody(
			this.deps.bucket,
			this.deps.organizationId,
			JSON.stringify(content),
			previous,
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

	private async activeGadget(appId: string) {
		const app = await getOsGadget(this.deps.core, {
			organizationId: this.deps.organizationId,
			gadgetId: appId,
		});
		if (
			!app ||
			app.workspaceId !== this.deps.workspaceId ||
			app.status !== "active"
		)
			throw new Error("App not found in this workspace");
		return app;
	}

	async getAppAccess(input: { appId: string }) {
		const { appId } = z
			.object({ appId: z.string().min(1) })
			.strict()
			.parse(input);
		const app = await this.activeGadget(appId);
		if (!app.currentRevisionId) throw new Error("App has no saved version");
		const revision = await getOsGadgetRevision(this.deps.core, {
			organizationId: this.deps.organizationId,
			revisionId: app.currentRevisionId,
		});
		if (!revision || revision.gadgetId !== app.id)
			throw new Error("App version not found");
		const manifest = OsGadgetManifestSchema.parse(
			JSON.parse(revision.manifest),
		);
		return manifest.resourceGrants ?? [];
	}

	async listAppVersions(input: { appId: string }): Promise<AppVersion[]> {
		const { appId } = z
			.object({ appId: z.string().min(1) })
			.strict()
			.parse(input);
		const app = await this.activeGadget(appId);
		const rows = await listOsGadgetRevisions(
			this.deps.core,
			{ organizationId: this.deps.organizationId, gadgetId: app.id },
			{ limit: 50 },
		);
		return rows.map((row) => ({
			revision: row.revision,
			revisionId: row.id,
			current: row.id === app.currentRevisionId,
			savedAt: row.createdAt,
			savedBy:
				row.createdByKind === "user"
					? "person"
					: row.createdByKind === "service"
						? "automation"
						: "agent",
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
		const app = await this.activeGadget(parsed.appId);

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
					.max(24),
				restoreRevisionId: z.string().min(1).optional(),
				actorId: z.string().min(1),
			})
			.strict()
			.refine((value) => value.edits.length > 0 || value.restoreRevisionId, {
				message: "An app edit needs at least one change",
			})
			.parse(input);
		if (!this.deps.conversationId)
			throw new Error("App edits require a workspace conversation");
		const current = await this.getAppCode({ appId: parsed.appId });
		if (current.revisionId !== parsed.expectedRevisionId)
			throw new Error(
				"App revision conflict; read the current source before editing again",
			);
		// Going back keeps today's settings and access; only the files return.
		const earlier = parsed.restoreRevisionId
			? await this.getAppCode({
					appId: parsed.appId,
					revisionId: parsed.restoreRevisionId,
				})
			: undefined;
		if (
			earlier &&
			earlier.revisionId === current.revisionId &&
			!current.proposalId
		)
			throw new Error("That is already the app's current version");
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
				replaceFiles: earlier?.files,
				createdByKind: this.deps.actorKind,
				createdById: parsed.actorId,
			},
			(content) =>
				this.deps.validateAppSource(
					content.files,
					content.manifest.config?.compatibilityDate,
				),
		);
		const files = OsAppDraftContentSchema.parse(
			JSON.parse(proposal.content),
		).files;
		const staged = {
			...current,
			files,
			proposalId: proposal.id,
			sequence: proposal.sequence,
		};
		this.deps.appDraftStaged?.(await this.stagedAppDraft(staged));
		return staged;
	}

	private async stagedAppDraft(
		draft: AppCode & { proposalId: string; sequence: number },
	): Promise<StagedAppDraft> {
		const base = await this.getAppCode({
			appId: draft.id,
			revisionId: draft.revisionId,
		});
		return {
			appId: draft.id,
			name: draft.name,
			proposalId: draft.proposalId,
			sequence: draft.sequence,
			baseRevisionId: draft.revisionId,
			files: [
				...new Set([...Object.keys(base.files), ...Object.keys(draft.files)]),
			]
				.filter((path) => base.files[path] !== draft.files[path])
				.sort(),
		};
	}

	/**
	 * This conversation's undecided draft of an app, read from the proposal
	 * itself. The chat uses it when it holds no record of the draft, as for
	 * one staged before chats kept draft cards.
	 */
	async openAppDraft(appId: string): Promise<StagedAppDraft | undefined> {
		const current = await this.getAppCode({ appId });
		if (!current.proposalId || current.sequence === undefined) return undefined;
		return this.stagedAppDraft({
			...current,
			proposalId: current.proposalId,
			sequence: current.sequence,
		});
	}

	async publishAppDraft(input: PublishAppDraft): Promise<CreatedApp> {
		if (!this.deps.publishAppDraft)
			throw new Error("Publishing requires a workspace conversation");
		return this.deps.publishAppDraft(input);
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
		return { ...parsed, readable: await this.readableFiles(parsed.reads) };
	}

	/**
	 * The files a `reads` map names. Each must be an active file of this
	 * workspace that is not removed from its connections.
	 */
	private async readableFiles(reads: AppRuntimeReads = {}) {
		const files = [];
		for (const [name, outputId] of Object.entries(reads)) {
			const located = await this.locate(outputId);
			if (
				!located ||
				located.row.status !== "active" ||
				!this.canRead(located.revision)
			)
				throw new Error(
					`reads.${name}: no file with this id in this workspace; list files with env.outputs.list()`,
				);
			const resource = await findOsWorkspaceTenantResource(this.deps.tenant, {
				...this.scope,
				providerId: "tedix",
				resourceType: "output",
				providerResourceId: outputId,
			});
			if (resource && (resource.status !== "active" || !resource.slot))
				throw new Error(
					`reads.${name}: "${located.row.title}" was removed from this workspace's connections; a person can add it back`,
				);
			files.push({ name, output: located.row, slot: resource?.slot ?? null });
		}
		return files;
	}

	async readableFileTitles(reads: unknown): Promise<string[]> {
		const parsed = AppRuntimeReadsSchema.safeParse(reads ?? {});
		if (!parsed.success) return [];
		const files = await this.readableFiles(parsed.data);
		return [...new Set(files.map((file) => file.output.title))];
	}

	/**
	 * Gives each file the workspace connection apps read files through, the
	 * same row a file's editor uses, and returns what the manifest needs: one
	 * read-only grant per file and the slot behind each name. The app's reads
	 * are then checked like any app's: grant, role and the reader's own access.
	 */
	private async bindReads(
		files: Awaited<ReturnType<TenantDataPort["readableFiles"]>>,
		actorId: string,
	) {
		const slots: Record<string, string> = {};
		for (const { name, output, slot: bound } of files) {
			let slot = bound;
			if (!slot) {
				const now = new Date().toISOString();
				const key = {
					...this.scope,
					providerId: "tedix",
					resourceType: "output",
					providerResourceId: output.id,
				};
				await ensureOsWorkspaceResource(this.deps.tenant, {
					...key,
					id: crypto.randomUUID(),
					slot: `file_${output.id.replaceAll("-", "")}`,
					connectionScope: "tenant",
					name: output.title.slice(0, 200),
					metadata: JSON.stringify({ kind: output.kind }),
					status: "active",
					createdByKind: this.deps.actorKind,
					createdById: actorId,
					createdAt: now,
					updatedAt: now,
				});
				const row = await findOsWorkspaceTenantResource(this.deps.tenant, key);
				if (row?.status !== "active" || !row.slot)
					throw new Error(
						`"${output.title}" could not be connected to the app`,
					);
				// List screens read the shared copy of the row.
				await projectOsWorkspaceResource(this.deps.core, row);
				slot = row.slot;
			}
			slots[name] = slot;
		}
		return {
			slots,
			grants: [...new Set(Object.values(slots))].map((slot) => ({
				slot,
				operations: ["outputs.read"],
			})),
		};
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
		const reads = await this.bindReads(parsed.readable, actorId);
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
			// A new app reads and writes its own storage, and reads only the
			// workspace files the person approved with it.
			manifest: JSON.stringify({
				entry: APP_RUNTIME_ENTRY,
				capabilities: [],
				config: reads.grants.length
					? { version: 1, settings: { reads: reads.slots } }
					: { version: 1 },
				...(reads.grants.length ? { resourceGrants: reads.grants } : {}),
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

	async allowAppRead(input: AllowAppReadInput & { actorId: string }) {
		const { actorId, ...request } = input;
		let parsed: AllowAppReadInput;
		try {
			parsed = AllowAppReadInputSchema.parse(request);
		} catch (error) {
			readableInputError(error);
		}
		const current = await this.getAppCode({ appId: parsed.appId });
		if (current.proposalId || current.revisionId !== parsed.expectedRevisionId)
			throw new Error(
				"The app changed. Finish its pending edits and read the current source first.",
			);
		const reads = await this.bindReads(
			await this.readableFiles(parsed.reads),
			actorId,
		);
		const config = AppRuntimeConfigSchema.parse(
			current.manifest.config ?? { version: 1 },
		);
		const named = config.settings?.reads;
		const kept = current.manifest.resourceGrants ?? [];
		const manifest = OsGadgetManifestSchema.parse({
			...current.manifest,
			config: {
				...config,
				settings: {
					...config.settings,
					reads: {
						...(named && typeof named === "object" && !Array.isArray(named)
							? named
							: {}),
						...reads.slots,
					},
				},
			},
			// A slot the app already holds keeps what it was granted.
			resourceGrants: [
				...kept,
				...reads.grants.filter(
					(grant) => !kept.some((held) => held.slot === grant.slot),
				),
			],
		});
		const revisionId = crypto.randomUUID();
		const saved = await createOsGadgetRevision(this.deps.core, {
			id: revisionId,
			organizationId: this.deps.organizationId,
			gadgetId: current.id,
			manifest: JSON.stringify(manifest),
			expectedRevision: current.revision,
			createdByKind: this.deps.actorKind,
			createdById: actorId,
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
			id: current.id,
			name: current.name,
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
			definition: appTriggerDefinition(parsed.schedule),
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
			.filter((row) => row.connectionInstanceId || row.kind === "account")
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
		const defaults =
			rows.some((row) => row.kind === "account" && !row.connectionInstanceId) &&
			this.deps.availableConnections
				? await this.deps.availableConnections()
				: [];
		const connected = (row: (typeof rows)[number]) => {
			if (!row.connectionInstanceId)
				return row.kind === "account"
					? (defaults.find(
							(connection) =>
								connection.providerId === row.providerId &&
								connection.connectionScope ===
									(row.connectionScope === "user"
										? "personal"
										: "organization") &&
								!connection.connectionInstanceId,
						)?.connectedForYou ?? false)
					: null;
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
			providerResourceId: row.providerResourceId,
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

	/**
	 * The projects this turn's Work reaches: null for every project of the
	 * organization. That needs a turn the person sent in a workspace only
	 * they can open, and an active membership: the API's rule for reading
	 * the board. Otherwise only the workspace's linked projects.
	 */
	async #workProjectIds(): Promise<string[] | null> {
		const { projectIds } = await this.workspace();
		const userId = this.deps.personScope ? this.deps.actingUserId : null;
		if (!userId) return projectIds;
		const member = await getMemberAccessByUserId(
			this.deps.core,
			this.deps.organizationId,
			userId,
		);
		return member?.status === "active" ? null : projectIds;
	}

	async listWork(options: WorkListOptions = {}) {
		const projectIds = await this.#workProjectIds();
		if (
			options.projectId &&
			projectIds &&
			!projectIds.includes(options.projectId)
		)
			throw new Error("That project is not linked to this workspace");
		const disposition = options.disposition;
		if (
			disposition &&
			!(WORK_ITEM_DISPOSITION_VALUES as readonly string[]).includes(disposition)
		)
			throw new Error(
				`disposition is one of ${WORK_ITEM_DISPOSITION_VALUES.join(", ")}`,
			);
		const query = options.query?.trim().toLowerCase() || undefined;
		const projects = options.projectId
			? [options.projectId]
			: (projectIds ?? [undefined]);
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
		const pages = await Promise.all(
			projects.map((projectId) =>
				listWorkItemsPage(this.deps.core, {
					orgId: this.deps.organizationId,
					...(projectId ? { projectId } : {}),
					...(disposition
						? { disposition: disposition as WorkItemDisposition }
						: {}),
					...(query ? { titleContains: query } : {}),
					limit,
				}),
			),
		);
		return pages
			.flatMap((page) => page.data)
			.map(workSummary)
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
			.slice(0, limit);
	}

	/** Active projects the answering tedi leads; none when no tedi answers. */
	#ledProjects(projects: Project[]) {
		const tediId = this.deps.answeringTediId;
		return tediId
			? projects.filter((project) => project.leadTediId === tediId)
			: [];
	}

	async listOpenWork(
		options: { projectId?: string; query?: string } = {},
	): Promise<OpenWorkList> {
		const [projectIds, { projectIds: linked }, active] = await Promise.all([
			this.#workProjectIds(),
			this.workspace(),
			listActiveProjectsForOrganization(
				this.deps.core,
				this.deps.organizationId,
			),
		]);
		let covers: OpenWorkList["covers"];
		let scope: string[];
		if (options.projectId) {
			if (projectIds && !projectIds.includes(options.projectId))
				throw new Error("That project is not linked to this workspace");
			covers = "project";
			scope = [options.projectId];
		} else if (projectIds) {
			covers = "linked_projects";
			scope = projectIds;
		} else {
			const led = this.#ledProjects(active);
			[covers, scope] = led.length
				? ["led_projects", led.map((project) => project.id)]
				: linked.length
					? ["linked_projects", linked]
					: ["active_projects", active.map((project) => project.id)];
		}
		scope = scope.slice(0, 80);
		const { items, counts } = await listOpenWorkItemsAcrossProjects(
			this.deps.core,
			{
				orgId: this.deps.organizationId,
				projectIds: scope,
				titleContains: options.query?.trim().toLowerCase() || undefined,
				limit: covers === "project" ? 100 : 30,
			},
		);
		const byId = new Map(active.map((project) => [project.id, project]));
		const open = new Map(counts.map((row) => [row.projectId, row.open]));
		return {
			covers,
			items: items.map((item) => {
				const project = item.projectId ? byId.get(item.projectId) : undefined;
				return {
					...workSummary(item),
					projectKey: project?.key ?? null,
					projectName: project?.name ?? null,
				};
			}),
			projects: scope.flatMap((id) => {
				const project = byId.get(id);
				return project
					? [
							{
								id,
								key: project.key,
								name: project.name,
								open: open.get(id) ?? 0,
							},
						]
					: [];
			}),
		};
	}

	/** A Work Item this turn's Work reaches; the same refusal when it is not. */
	async #reachableWork(workItemId: string) {
		const [item, projectIds] = await Promise.all([
			getWorkItemById(this.deps.core, workItemId, this.deps.organizationId),
			this.#workProjectIds(),
		]);
		if (
			!item ||
			(projectIds && (!item.projectId || !projectIds.includes(item.projectId)))
		)
			throw new Error("No Work Item with this id is reachable from this chat");
		return item;
	}

	async getWork(workItemId: string): Promise<WorkItemDetail> {
		await this.#runActor();
		const item = await this.#reachableWork(workItemId);
		const [project, comments, attempts, evidence, tedis] = await Promise.all([
			item.projectId
				? getProjectByIdForOrganization(
						this.deps.core,
						item.orgId,
						item.projectId,
					)
				: undefined,
			listRecentWorkItemComments(this.deps.core, {
				orgId: item.orgId,
				workItemId: item.id,
				limit: 10,
			}),
			listWorkItemAttempts(this.deps.core, {
				orgId: item.orgId,
				workItemId: item.id,
				limit: 1,
			}),
			listWorkItemEvidence(this.deps.core, {
				orgId: item.orgId,
				workItemId: item.id,
				limit: 10,
			}),
			listTediDisplayNamesByIds(this.deps.core, {
				organizationId: item.orgId,
				ids: [
					...(item.accountableOwnerType === "tedi" && item.accountableOwnerId
						? [item.accountableOwnerId]
						: []),
					...(item.stewardType === "tedi" && item.stewardId
						? [item.stewardId]
						: []),
				],
			}),
		]);
		const run = attempts.data[0];
		const lane = item.metadata?.laneDispatch;
		const hold =
			item.dispatchState === "held" &&
			lane &&
			typeof lane === "object" &&
			!Array.isArray(lane)
				? lane
				: null;
		return {
			...workSummary(item),
			description: item.description
				? wrapUntrustedInput(item.description.slice(0, 4000), "work_item")
				: null,
			project: project?.name ?? null,
			executor:
				item.executorId ??
				(typeof item.metadata?.executor === "string"
					? item.metadata.executor
					: null),
			dispatchState: item.dispatchState,
			holdReason:
				typeof hold?.reason === "string"
					? wrapUntrustedInput(hold.reason.slice(0, 300), "dispatch_reason")
					: null,
			holdNote:
				typeof hold?.note === "string"
					? wrapUntrustedInput(hold.note.slice(0, 2000), "dispatch_note")
					: null,
			tediNames: Object.fromEntries(
				tedis.map((tedi) => [tedi.id, tedi.displayName || tedi.name]),
			),
			steward: item.stewardId ? `${item.stewardType}:${item.stewardId}` : null,
			evidence: evidence.data.map(
				({ id, attemptId, claimKey, kind, uri, label, disposition }) => ({
					id,
					attemptId,
					claimKey,
					kind,
					uri,
					label,
					disposition,
				}),
			),
			moreEvidence: evidence.nextCursor !== null,
			accountableOwner: item.accountableOwnerId
				? `${item.accountableOwnerType}:${item.accountableOwnerId}`
				: null,
			latestRun: run
				? {
						id: run.id,
						state: run.runtimeState,
						outcome: run.outcome,
						executor: `${run.executorType}:${run.executorId}`,
						session: run.externalSessionKey,
						expiresAt: run.expiresAt,
						hasLiveLease:
							LIVE_WORK_ATTEMPT_RUNTIME_STATES.some(
								(state) => state === run.runtimeState,
							) &&
							!!run.expiresAt &&
							Date.parse(run.expiresAt) > Date.now(),
						report: run.summary
							? wrapUntrustedInput(run.summary.slice(0, 4000), "attempt_report")
							: null,
					}
				: null,
			comments: comments.map((comment) => ({
				author: `${comment.authorType}:${comment.authorId}`,
				createdAt: comment.createdAt,
				body: wrapUntrustedInput(comment.body.slice(0, 2000), "work_comment"),
			})),
			url: "/work/items/" + item.id,
		};
	}

	async commentOnWork(input: { workItemId: string; body: string }) {
		const { actor } = await this.#runActor();
		const body = z.string().trim().min(1).max(10_000).parse(input.body);
		const item = await this.#reachableWork(input.workItemId);
		const comment = await addWorkItemComment(this.deps.core, {
			id: crypto.randomUUID(),
			workItemId: item.id,
			orgId: item.orgId,
			authorType: actor.type,
			authorId: actor.id,
			recordActivity: true,
			body,
			metadata: {
				source: "os.workspace.chat",
				workspaceId: this.deps.workspaceId,
			},
			createdAt: new Date().toISOString(),
		});
		return { id: comment.id, workItemId: item.id };
	}

	async acceptWork(input: { workItemId: string; doneWhen: string }) {
		const { actor } = await this.#runActor();
		const doneWhen = z.string().trim().min(1).max(2_000).parse(input.doneWhen);
		const item = await this.#reachableWork(input.workItemId);
		if (item.disposition !== "proposed")
			throw new Error(`This Work Item is ${item.disposition}, not proposed`);
		const project = item.projectId
			? await getProjectByIdForOrganization(
					this.deps.core,
					item.orgId,
					item.projectId,
				)
			: null;
		if (!project)
			throw new Error(
				"This Work Item has no project; it can be accepted once it has one",
			);
		if (!(await this.#operatesIn(actor.id, "acceptance"))(project))
			throw new Error(OPERATOR_REFUSAL);
		return workSummary(
			await acceptWorkItem(this.deps.core, {
				orgId: item.orgId,
				workItemId: item.id,
				acceptanceContract: { version: 1, doneLooksLike: doneWhen },
				actor,
			}),
		);
	}

	async listRuns(): Promise<{
		runs: LiveRunSummary[];
		complete: boolean;
		limit: number;
	}> {
		const { actor, sourceSessionKey } = await this.#runActor();
		const projectIds = await this.#workProjectIds();
		const [page, projects, operates] = await Promise.all([
			listLiveWorkRuns(this.deps.core, {
				orgId: this.deps.organizationId,
				projectIds,
			}),
			listActiveProjectsForOrganization(
				this.deps.core,
				this.deps.organizationId,
			),
			this.#operatesIn(actor.id, "completion"),
		]);
		const byId = new Map(projects.map((project) => [project.id, project]));
		const now = Date.now();
		const runs = page.runs.map((row) => {
			const project = row.projectId ? byId.get(row.projectId) : undefined;
			const startedInThisChat = row.sourceSessionKey === sourceSessionKey;
			return {
				workItemId: row.workItemId,
				title: row.title,
				projectId: row.projectId,
				project: project?.name ?? null,
				executor: row.attemptExecutorId,
				requestedExecutor: row.itemExecutorId,
				actualExecutor: {
					type: row.attemptExecutorType,
					id: row.attemptExecutorId,
				},
				attemptId: row.attemptId,
				executorSessionId: row.executorSessionId,
				externalSessionKey: row.externalSessionKey,
				verifiedHarness:
					row.verifiedSessionId && row.harness && row.harnessVersion
						? { name: row.harness, version: row.harnessVersion }
						: null,
				expiresAt: row.expiresAt,
				state: row.runtimeState,
				startedAt: row.startedAt,
				minutesRunning: Math.max(
					0,
					Math.round((now - Date.parse(row.startedAt)) / 60_000),
				),
				lastHeartbeatAt: row.heartbeatAt,
				lastStep: row.lastStep
					? {
							at: new Date(row.lastStep.at).toISOString(),
							kind: row.lastStep.kind,
							text: wrapUntrustedInput(
								row.lastStep.text.slice(0, 300),
								"agent_run",
							),
						}
					: null,
				startedInThisChat,
				canSteer:
					(startedInThisChat &&
						row.accountableOwnerType === actor.type &&
						row.accountableOwnerId === actor.id) ||
					(!!project && operates(project)),
				url: "/work/items/" + row.workItemId,
			};
		});
		return { complete: page.complete, limit: page.limit, runs };
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
					: whichProject(
							(
								await listActiveProjectsForOrganization(
									this.deps.core,
									this.deps.organizationId,
								)
							).filter((project) => projectIds.includes(project.id)),
						),
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

	/**
	 * Whether this person may take a Work action in the organization's
	 * projects: the rule the API applies to a person who accepts a task, or
	 * who completes one or steers its run. An owner or admin may in every
	 * project; a member only where the project names them as an operator for
	 * that action.
	 */
	async #operatesIn(userId: string, action: "acceptance" | "completion") {
		const member = await getMemberAccessByUserId(
			this.deps.core,
			this.deps.organizationId,
			userId,
		);
		const active = member?.status === "active";
		const admin = active && ["owner", "admin"].includes(member.role);
		return (project: Project) => {
			if (admin) return true;
			const grant = WorkOperatorsSchema.safeParse(
				project.metadata?.workOperators,
			);
			return (
				active &&
				member.role === "member" &&
				project.status === "active" &&
				grant.success &&
				!!member.userId &&
				grant.data.userIds.includes(member.userId) &&
				grant.data.actions.includes(action)
			);
		};
	}

	/**
	 * The project a run goes to. A shared workspace reaches only its linked
	 * projects. In a workspace only the sender can open, the person's own
	 * permission decides. With no project named it is never guessed: it is
	 * the one project linked or led by the answering tedi, else refused with
	 * the candidates.
	 */
	async #runProject(userId: string, requestedProjectId?: string) {
		if (!this.deps.personScope) return this.#workProject(requestedProjectId);
		const [{ projectIds }, projects] = await Promise.all([
			this.workspace(),
			listActiveProjectsForOrganization(
				this.deps.core,
				this.deps.organizationId,
			),
		]);
		const possible = new Set([
			...projectIds,
			...this.#ledProjects(projects).map((project) => project.id),
		]);
		const projectId =
			requestedProjectId ??
			(possible.size === 1 ? [...possible][0] : undefined);
		if (!projectId) {
			const accepts = await this.#operatesIn(userId, "acceptance");
			throw new Error(
				whichProject(
					projects.filter((project) =>
						possible.size ? possible.has(project.id) : accepts(project),
					),
				),
			);
		}
		// A linked project takes the same build access as in a shared workspace.
		if (projectIds.includes(projectId)) return this.#workProject(projectId);
		const project = projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new Error("Project not found");
		if (!(await this.#operatesIn(userId, "acceptance"))(project))
			throw new Error(OPERATOR_REFUSAL);
		return project;
	}

	async listRunProjects() {
		const { actor } = await this.#runActor();
		const { projectIds } = await this.workspace();
		const accepts = this.deps.personScope
			? await this.#operatesIn(actor.id, "acceptance")
			: () => false;
		return (
			await listActiveProjectsForOrganization(
				this.deps.core,
				this.deps.organizationId,
			)
		)
			.filter((project) => projectIds.includes(project.id) || accepts(project))
			.map(({ id, key, name }) => ({ id, key, name }));
	}

	async startRun(input: StartRunInput) {
		const { actor, sourceSessionKey, agentTurnId } = await this.#runActor();
		const {
			title,
			brief,
			doneWhen,
			executor,
			changesCode,
			requiresRepository,
			projectId,
		} = StartRunInputSchema.parse(input);
		const project = await this.#runProject(actor.id, projectId);
		// A runner fails a coding run that ends without a landed commit; a
		// research task is done when the agent says so.
		const workKind = changesCode === false ? "research" : "coding";
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
			workKind,
			projectId: project.id,
			...(project.objectiveId
				? { objectiveId: project.objectiveId, workClass: "objective" as const }
				: workItemPurposeFor({ workClass: "maintenance", now })),
			executorType: "external_agent",
			executorId: executor,
			sourceSessionKey,
			sourceIntentId: intent.sourceIntentId,
			provenance: { source: "os.workspace.chat", workspaceId },
			// The ready list puts a task with this marker first.
			metadata: {
				source: WORKSPACE_RUN_SOURCE,
				requiresRepository:
					changesCode !== false || requiresRepository === true,
				// The chat's mode, for the run's own approvals.
				...(this.deps.approvalMode
					? { approvalMode: this.deps.approvalMode }
					: {}),
			},
			createdAt: now.toISOString(),
		}).catch(async (error: unknown) => {
			const existing = await getWorkItemBySourceIntentId(core, intent);
			if (!existing) throw error;
			if (
				existing.sourceSessionKey !== sourceSessionKey ||
				existing.accountableOwnerId !== actor.id ||
				existing.title !== title ||
				existing.description !== brief ||
				existing.workKind !== workKind ||
				(existing.metadata?.requiresRepository ?? true) !==
					(changesCode !== false || requiresRepository === true) ||
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
			requestedAt: item.createdAt,
			projectId: project.id,
		};
	}

	/**
	 * A run this chat may read: one started in this conversation, or in a
	 * workspace only the sender can open, any run in the organization.
	 */
	async #visibleRun(workItemId: string) {
		const { actor, sourceSessionKey } = await this.#runActor();
		const item = await getWorkItemById(
			this.deps.core,
			workItemId,
			this.deps.organizationId,
		);
		const startedHere = item?.sourceSessionKey === sourceSessionKey;
		if (
			!item ||
			item.executorType !== "external_agent" ||
			(!startedHere && (await this.#workProjectIds()) !== null)
		)
			throw new Error("This run was not started in this conversation");
		return { item, actor, startedHere };
	}

	async readRun(input: { workItemId: string; afterSeq?: number }) {
		const { id: workItemId, afterSeq } = ListWorkAttemptStepsInputSchema.parse({
			id: input.workItemId,
			afterSeq: input.afterSeq,
		});
		const { item } = await this.#visibleRun(workItemId);
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
		interrupt = false,
	) {
		const { item, actor, startedHere } = await this.#visibleRun(workItemId);
		// The owner of a task started here steers it; any other run follows
		// the API's rule for steering: an owner or admin, or a project operator.
		const owns =
			startedHere &&
			item.accountableOwnerType === actor.type &&
			item.accountableOwnerId === actor.id;
		const project =
			!owns && item.projectId
				? await getProjectByIdForOrganization(
						this.deps.core,
						item.orgId,
						item.projectId,
					)
				: null;
		if (
			!owns &&
			!(project && (await this.#operatesIn(actor.id, "completion"))(project))
		)
			throw new Error(
				startedHere
					? "The person who owns this task can steer its run"
					: "Steering this run needs an organization owner or admin, or a member the project names as an operator",
			);
		const message = await sendWorkAttemptMessage(this.deps.core, {
			orgId: item.orgId,
			workItemId,
			kind,
			body,
			sender: actor,
			interrupt,
		});
		if (message) return message;
		// No run took it: say whether the run has not started or how it ended.
		const { attemptId, outcome } = await listWorkAttemptSteps(this.deps.core, {
			orgId: item.orgId,
			workItemId,
			limit: 1,
		});
		if (item.disposition === "completed")
			throw new Error("This run has finished");
		if (item.disposition === "cancelled")
			throw new Error("This run was cancelled");
		if (!attemptId) {
			const waiting =
				kind === "follow_up" && !interrupt
					? await queueWorkItemFollowUp(this.deps.core, {
							orgId: item.orgId,
							workItemId,
							body,
							sender: actor,
						})
					: null;
			if (waiting) return waiting;
			throw new Error(
				kind === "stop"
					? "This run has not started yet, so there is nothing to stop"
					: interrupt
						? "This run has not started yet, so there is nothing to interrupt"
						: "This run is just starting. Send the follow-up again in a moment",
			);
		}
		throw new Error(
			outcome === "succeeded"
				? "This run has finished"
				: outcome === "cancelled"
					? "This run was stopped"
					: outcome === "failed" || outcome === "rejected"
						? "This run failed"
						: outcome === "expired"
							? "This run was interrupted and is not running now"
							: kind === "stop"
								? "No run is in progress"
								: "This run is stopping or waiting to resume, so it cannot take a follow-up right now",
		);
	}

	async sendRunMessage(input: {
		workItemId: string;
		message: string;
		interrupt?: boolean;
	}) {
		const {
			id: workItemId,
			body,
			interrupt,
		} = SendWorkAttemptMessageInputSchema.parse({
			id: input.workItemId,
			body: input.message,
			interrupt: input.interrupt,
		});
		const message = await this.#steerRun(
			workItemId,
			"follow_up",
			body,
			interrupt,
		);
		return {
			kind: "agent_run_message" as const,
			workItemId,
			messageId: message.id,
			delivery: message.attemptId
				? ("to_running_agent" as const)
				: ("when_run_starts" as const),
			note: message.interrupt
				? "Interrupt requested. The runner will try to stop its current step to apply the follow-up."
				: message.attemptId
					? "Saved for the run. The agent gets it after its current step."
					: "Saved. The run has not started yet; the agent gets this follow-up when it starts.",
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

/** The refusal when a project must be named: up to 10 candidates. */
function whichProject(candidates: Project[]) {
	const listed = candidates
		.slice(0, 10)
		.map((project) => `${project.key} ${project.name} (${project.id})`)
		.join("; ");
	return candidates.length
		? `Which project is this for? Ask the person and pass its projectId. Candidates${candidates.length > 10 ? ` (10 of ${candidates.length})` : ""}: ${listed}`
		: "Which project is this for? Ask the person; env.work.listProjects() lists the projects they may use.";
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
