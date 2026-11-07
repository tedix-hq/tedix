/**
 * Data port over the workspace's own store. Outputs and revisions are rows
 * in this object's SQLite (the tenant-store plane); bodies are gzip objects
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
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import { listOsGadgets } from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceProjects } from "@tedix/db/queries/os-workspaces/projects";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { listWorkItems } from "@tedix/db/queries/work-items/crud";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/schema/os-workspaces";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	OsOutputContentInputSchema,
	OsOutputContentSchema,
	type OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import type {
	OutputDetail,
	OutputSummary,
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

	private async summary(row: OsOutputRow): Promise<OutputSummary> {
		const revision = row.currentRevisionId
			? await getOsOutputRevision(this.deps.tenant, {
					organizationId: row.organizationId,
					revisionId: row.currentRevisionId,
				})
			: undefined;
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

	async listOutputs(options?: {
		kind?: OutputSummary["kind"];
		status?: OutputSummary["status"];
	}): Promise<OutputSummary[]> {
		const rows = await listOsOutputs(
			this.deps.tenant,
			this.deps.organizationId,
			// The object serves one workspace; visibility was checked at the door.
			{ userIds: [], workspaceIds: [this.deps.workspaceId] },
			{ workspaceId: this.deps.workspaceId, ...options, limit: 500 },
		);
		return Promise.all(rows.map((row) => this.summary(row)));
	}

	async getOutput(outputId: string): Promise<OutputDetail | null> {
		const row = await getOsOutput(this.deps.tenant, {
			organizationId: this.deps.organizationId,
			outputId,
		});
		if (!row || row.workspaceId !== this.deps.workspaceId) return null;
		const summary = await this.summary(row);
		if (!row.currentRevisionId) return { ...summary, content: null };
		const revision = await getOsOutputRevision(this.deps.tenant, {
			organizationId: row.organizationId,
			revisionId: row.currentRevisionId,
		});
		if (!revision) return { ...summary, content: null };
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
		await createOsOutput(
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
				createdByKind: this.deps.actorKind,
				createdById: input.actorId,
				createdAt: now,
				...stored,
			},
		);
		const created = await this.getOutput(outputId);
		if (!created) throw new Error("Output vanished after create");
		return created;
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
		const result = await createOsOutputRevision(this.deps.tenant, {
			id: crypto.randomUUID(),
			organizationId: this.deps.organizationId,
			outputId: input.outputId,
			...stored,
			note: input.note ?? null,
			createdByKind: this.deps.actorKind,
			createdById: input.actorId,
			expectedRevision: input.expectedRevision,
		});
		if (!result.ok) throw new Error(`Revise failed: ${result.reason}`);
		const revised = await this.getOutput(input.outputId);
		if (!revised) throw new Error("Output vanished after revise");
		return revised;
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
			.map((item) => ({
				id: item.id,
				title: item.title,
				disposition: item.disposition,
				workKind: item.workKind,
				priority: item.priority ?? null,
				projectId: item.projectId ?? null,
				updatedAt: item.updatedAt ?? item.createdAt,
			}))
			.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
			.slice(0, limit);
	}
}
