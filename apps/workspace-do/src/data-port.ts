/**
 * What the bindings read and write. The agent loop never sees a database;
 * it sees this port. Outputs use the activated workspace object; core
 * directories and Work use the shared database.
 */
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
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

export interface AppCode {
	id: string;
	name: string;
	revision: number;
	revisionId: string;
	manifest: OsGadgetManifest;
	files: Record<string, string>;
	proposalId?: string;
	sequence?: number;
}

export interface EditAppFilesInput {
	proposalId?: string;
	expectedSequence?: number;
	appId: string;
	expectedRevisionId: string;
	edits: Array<{ path: string; before?: string; after: string }>;
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
	getAppCode(input: { appId: string; revisionId?: string }): Promise<AppCode>;
	editAppFiles(
		input: EditAppFilesInput & { actorId: string },
	): Promise<AppCode>;
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
