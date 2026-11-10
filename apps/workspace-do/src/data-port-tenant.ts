/**
 * Outputs and revisions use the workspace's selected storage owner:
 * object SQLite after cutover, otherwise shared D1. Bodies are gzip objects
 * in R2 addressed by digest. Apps, resources and Work items still live in
 * the core database and are read there directly, no HTTP hop.
 */
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	createOsOutput,
	createOsOutputRevision,
	getOsOutput,
	getOsOutputRevision,
	listOsOutputs,
} from "@tedix/db/queries/durable-sqlite/os-outputs";
import * as coreOutputs from "@tedix/db/queries/os-workspaces/outputs";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import { listOsGadgets } from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceProjects } from "@tedix/db/queries/os-workspaces/projects";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import {
	createWorkItem,
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
} from "@tedix/db/schema/os-workspaces";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	OsOutputContentInputSchema,
	OsOutputContentSchema,
	OsDerivedAccessEnvelopeSchema,
	type OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import type {
	OutputDetail,
	OutputSummary,
	CreateWorkInput,
	WorkItemSummary,
	WorkspaceDataPort,
	WorkspaceSnapshot,
} from "./data-port";

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
	ownsOutputs: () => Promise<boolean>;
	commitOutput: <T>(outputId: string, write: () => Promise<T>) => Promise<T>;
}

export class TenantDataPort implements WorkspaceDataPort {
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
		const legacy = !(await this.deps.ownsOutputs());
		const row = legacy
			? await coreOutputs.getOsOutput(this.deps.core, params)
			: await getOsOutput(this.deps.tenant, params);
		if (!row || row.workspaceId !== this.deps.workspaceId) return null;
		const revision = row.currentRevisionId
			? await (legacy
					? coreOutputs.getOsOutputRevision(this.deps.core, {
							...this.scope,
							revisionId: row.currentRevisionId,
						})
					: getOsOutputRevision(this.deps.tenant, {
							...this.scope,
							revisionId: row.currentRevisionId,
						}))
			: undefined;
		if (revision && revision.outputId !== row.id) return null;
		return { row, revision, legacy: Boolean(legacy) };
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

	async listOutputs(options?: {
		kind?: OutputSummary["kind"];
		status?: OutputSummary["status"];
	}): Promise<OutputSummary[]> {
		const viewer = { userIds: [], workspaceIds: [this.deps.workspaceId] };
		const owned = (await this.deps.ownsOutputs())
			? await listOsOutputs(
					this.deps.tenant,
					this.deps.organizationId,
					viewer,
					{ workspaceId: this.deps.workspaceId, ...options, limit: 500 },
				)
			: await coreOutputs.listOsOutputs(this.deps.core, this.scope, viewer, {
					...options,
					limit: 500,
				});
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
		const create = (await this.deps.ownsOutputs())
			? (
					output: Parameters<typeof createOsOutput>[1],
					revision: Parameters<typeof createOsOutput>[2],
				) => createOsOutput(this.deps.tenant, output, revision)
			: (
					output: Parameters<typeof createOsOutput>[1],
					revision: Parameters<typeof createOsOutput>[2],
				) =>
					coreOutputs.createOsOutput(
						this.deps.core,
						this.scope,
						output,
						revision,
					);
		const created = await this.deps.commitOutput(outputId, () =>
			create(
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
		const located = await this.locate(input.outputId);
		if (!located) throw new Error("Output not found");
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
		};
		const result = await this.deps.commitOutput(input.outputId, () =>
			located.legacy
				? coreOutputs.createOsOutputRevision(this.deps.core, params)
				: createOsOutputRevision(this.deps.tenant, params),
		);
		if (!result.ok) throw new Error(`Revise failed: ${result.reason}`);
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

	async listResources() {
		const rows = await listOsWorkspaceResources(this.deps.core, {
			...this.scope,
			status: "active",
		});
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			kind: row.resourceType,
			status: row.status,
		}));
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
		const { projectIds } = await this.workspace();
		const projectId =
			input.projectId ?? (projectIds.length === 1 ? projectIds[0] : undefined);
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
			projectId,
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
