/**
 * What the bindings read and write. The agent loop never sees a database;
 * it sees this port. Today the port reads the shared D1 tables; once the
 * migration moves a workspace's rows into its own object, the same port is
 * backed by `runtime.storage` without touching the bindings or the loop.
 */
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";

export interface OutputSummary {
	id: string;
	kind: "document" | "sheet" | "presentation" | "video";
	title: string;
	status: "active" | "archived";
	revision: number;
	revisionId: string | null;
	updatedAt: string;
}

export interface OutputDetail extends OutputSummary {
	content: OsOutputContent | null;
}

export interface AppSummary {
	id: string;
	name: string;
	description: string | null;
	status: string;
	updatedAt: string;
}

export interface ResourceSummary {
	id: string;
	name: string;
	kind: string;
	status: string;
}

export interface WorkItemSummary {
	id: string;
	title: string;
	disposition: string;
	workKind: string;
	priority: string | null;
	projectId: string | null;
	updatedAt: string;
}

export interface CreateWorkInput {
	title: string;
	description?: string;
	/** Required when the workspace links more than one project. */
	projectId?: string;
	/** A Work kind such as "coding", "research" or "document"; default "other". */
	workKind?: string;
	/** "low" | "medium" | "high" | "critical"; default "medium". */
	priority?: string;
}

export interface WorkspaceSnapshot {
	id: string;
	name: string;
	description: string | null;
	organizationId: string;
	projectIds: string[];
}

export interface WorkspaceDataPort {
	workspace(): Promise<WorkspaceSnapshot>;
	listOutputs(options?: {
		kind?: OutputSummary["kind"];
		status?: OutputSummary["status"];
	}): Promise<OutputSummary[]>;
	getOutput(outputId: string): Promise<OutputDetail | null>;
	createOutput(input: {
		title: string;
		content: OsOutputContent;
		actorId: string;
	}): Promise<OutputDetail>;
	reviseOutput(input: {
		outputId: string;
		content: OsOutputContent;
		expectedRevision: number;
		actorId: string;
		note?: string;
	}): Promise<OutputDetail>;
	listApps(): Promise<AppSummary[]>;
	listResources(): Promise<ResourceSummary[]>;
	listWork(options?: {
		disposition?: string;
		limit?: number;
	}): Promise<WorkItemSummary[]>;
	/** Files a proposed Work Item in a project linked to this workspace. */
	createWork(
		input: CreateWorkInput & { actorId: string },
	): Promise<WorkItemSummary>;
}
