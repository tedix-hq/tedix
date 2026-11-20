/**
 * What the bindings read and write. The agent loop never sees a database;
 * it sees this port. Outputs use the activated workspace object; core
 * directories and Work use the shared database.
 */
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import type {
	AllowAppReadInput,
	AppRuntimeReads,
	RegisterAppScheduleInput,
} from "@tedix/api-contract/schemas/os-app-runtime";
import type { WorkspaceFileText } from "@tedix/api-contract/utils/workspace-file-text";

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

export interface CreateAppInput {
	name: string;
	description?: string;
	/** `server.js` and `client.js` are required; see the app file rules. */
	files: Record<string, string>;
	/** Files of this workspace the app may read: a name, then the file's id. */
	reads?: AppRuntimeReads;
}

/** A new app with its first saved revision. */
export interface CreatedApp {
	id: string;
	name: string;
	revision: number;
	revisionId: string;
}

/**
 * One connected source as the agent sees it. It names no person and holds no
 * credential: whose account a personal source uses is never shown.
 */
export interface ResourceSummary {
	id: string;
	name: string;
	kind: string;
	status: string;
	/** The name apps use for this source; null when it has none. */
	slot: string | null;
	providerId: string;
	/** The service's display name, or its id when it has no entry. */
	service: string;
	/** Whose account reads it: each person's own, or one the organization shares. */
	connectionScope: "personal" | "organization";
	connectionInstanceId: string | null;
	/** What the source grants at the service; null when not recorded. */
	providerAccess: { canRead: boolean; canWrite: boolean } | null;
	/**
	 * Whether the person the turn acts for has the account this source needs.
	 * null for a source that needs no account.
	 */
	connectedForYou: boolean | null;
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

export interface StartRunInput {
	title: string;
	brief: string;
	doneWhen: string;
	executor: "codex" | "claude-code";
	/** False when the run changes no files and only reports back. */
	changesCode?: boolean;
	projectId?: string;
}

export interface WorkspaceSnapshot {
	id: string;
	name: string;
	description: string | null;
	organizationId: string;
	projectIds: string[];
}

export interface WorkspaceRunPort {
	/** The projects the person who sent the turn may start a run in. */
	listRunProjects(): Promise<Array<{ id: string; key: string; name: string }>>;
	startRun(input: StartRunInput): Promise<{
		kind: "agent_run";
		workItemId: string;
		title: string;
		executor: StartRunInput["executor"];
		url: string;
		/** For the runner wake; not shown to the agent. */
		projectId: string;
	}>;
	readRun(input: { workItemId: string; afterSeq?: number }): Promise<{
		kind: "agent_run_steps";
		workItemId: string;
		live: boolean;
		steps: Array<{ seq: number; at: number; kind: string; text: string }>;
		messages: import("@tedix/api-contract/schemas/work-attempt-steps").WorkAttemptMessage[];
	}>;
	sendRunMessage(input: { workItemId: string; message: string }): Promise<{
		kind: "agent_run_message";
		workItemId: string;
		messageId: string;
	}>;
	stopRun(input: { workItemId: string }): Promise<{
		kind: "agent_run_stop";
		workItemId: string;
	}>;
}

export interface WorkspaceDataPort {
	workspace(): Promise<WorkspaceSnapshot>;
	listOutputs(options?: {
		kind?: OutputSummary["kind"];
		status?: OutputSummary["status"];
	}): Promise<OutputSummary[]>;
	getOutput(outputId: string): Promise<OutputDetail | null>;
	/**
	 * The whole text kept beside an uploaded file of this workspace; null when
	 * none was kept. Callers first check that the file's document is readable.
	 */
	readFileText(file: {
		workspaceId: string;
		resourceId: string;
	}): Promise<WorkspaceFileText | null>;
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
	/** Checks a new app's name, files and the files it asks to read; saves nothing. */
	checkNewApp(input: CreateAppInput): Promise<void>;
	/** Creates an app in this workspace with revision 1. It may read only `reads`. */
	createApp(input: CreateAppInput & { actorId: string }): Promise<CreatedApp>;
	/** The titles of the files `reads` names, each active and in this workspace. */
	readableFileTitles(reads: unknown): Promise<string[]>;
	/** Lets an existing app read more files of this workspace, as a new revision. */
	allowAppRead(input: AllowAppReadInput & { actorId: string }): Promise<{
		id: string;
		name: string;
		revision: number;
		revisionId: string;
	}>;
	registerAppSchedule(
		input: RegisterAppScheduleInput & { actorId: string },
	): Promise<{ gadgetId: string; triggerId: string; name: string }>;
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
