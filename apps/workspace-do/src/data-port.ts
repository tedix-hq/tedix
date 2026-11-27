/**
 * What the bindings read and write. The agent loop never sees a database;
 * it sees this port. Outputs use the activated workspace object; core
 * directories and Work use the shared database.
 */
import type { PublishAppDraft } from "@tedix/api-contract/schemas/workspace-app-draft";
import type {
	AppOperations,
	ListAppOperations,
	RunAppOperation,
} from "@tedix/api-contract/schemas/workspace-app-operation";
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
	/** Pending drafts outside this conversation; no source or proposal details. */
	otherDraftCount?: number;
}

export interface AppVersion {
	revision: number;
	revisionId: string;
	current: boolean;
	savedAt: string;
	savedBy: "person" | "agent" | "automation";
}

export interface EditAppFilesInput {
	proposalId?: string;
	expectedSequence?: number;
	appId: string;
	expectedRevisionId: string;
	edits: Array<{ path: string; before?: string; after: string }>;
	/** Start the draft from this earlier revision's files instead; edits may then be empty. */
	restoreRevisionId?: string;
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
	providerResourceId?: string;
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

export interface WorkListOptions {
	disposition?: string;
	limit?: number;
	projectId?: string;
	/** Words the title contains, any case. */
	query?: string;
}

/**
 * Open Work (proposed or accepted), newest updated first, with an exact open
 * count for every project the list covers.
 */
export interface OpenWorkList {
	/**
	 * project: the one named. led_projects: every active project the
	 * answering tedi leads. linked_projects: the workspace's linked projects.
	 * active_projects: the organization's active projects.
	 */
	covers: "project" | "led_projects" | "linked_projects" | "active_projects";
	items: Array<
		WorkItemSummary & { projectKey: string | null; projectName: string | null }
	>;
	projects: Array<{ id: string; key: string; name: string; open: number }>;
}

/** A run in progress, from its live Attempt. */
export interface LiveRunSummary {
	workItemId: string;
	title: string;
	projectId: string | null;
	project: string | null;
	executor: string;
	requestedExecutor: string | null;
	actualExecutor: { type: string; id: string };
	attemptId: string;
	executorSessionId: string | null;
	externalSessionKey: string | null;
	verifiedHarness: { name: string; version: string } | null;
	expiresAt: string | null;
	/** The Attempt's state: queued, running, waiting or retrying. */
	state: string;
	startedAt: string;
	minutesRunning: number;
	lastHeartbeatAt: string;
	lastStep: { at: string; kind: string; text: string } | null;
	startedInThisChat: boolean;
	/** Whether the person who sent this message may send it a follow-up or stop it. */
	canSteer: boolean;
	url: string;
}

export interface WorkItemDetail extends WorkItemSummary {
	description: string | null;
	project: string | null;
	executor: string | null;
	accountableOwner: string | null;
	dispatchState: string | null;
	holdReason: string | null;
	holdNote: string | null;
	steward: string | null;
	tediNames: Record<string, string>;
	evidence: Array<{
		id: string;
		attemptId: string | null;
		claimKey: string;
		kind: string;
		uri: string;
		label: string | null;
		disposition: string;
	}>;
	moreEvidence: boolean;
	latestRun: {
		id: string;
		state: string;
		outcome: string | null;
		executor: string;
		session: string | null;
		expiresAt: string | null;
		hasLiveLease: boolean;
		report: string | null;
	} | null;
	comments: Array<{ author: string; createdAt: string; body: string }>;
	url: string;
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
	executor: "codex" | "claude-code" | "any-local";
	/** False when the run changes no files and only reports back. */
	changesCode?: boolean;
	/** True when an answer or report needs the project repository. */
	requiresRepository?: boolean;
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
		/** When the run was asked for; its card counts the wait from here. */
		requestedAt: string;
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
	sendRunMessage(input: {
		workItemId: string;
		message: string;
		interrupt?: boolean;
	}): Promise<{
		kind: "agent_run_message";
		workItemId: string;
		messageId: string;
		delivery: "to_running_agent" | "when_run_starts";
		note: string;
	}>;
	stopRun(input: { workItemId: string }): Promise<{
		kind: "agent_run_stop";
		workItemId: string;
	}>;
	/** Runs in progress in the projects this turn's Work reaches. */
	listRuns(): Promise<{
		runs: LiveRunSummary[];
		complete: boolean;
		limit: number;
	}>;
	getWork(workItemId: string): Promise<WorkItemDetail>;
	commentOnWork(input: { workItemId: string; body: string }): Promise<{
		id: string;
		workItemId: string;
	}>;
	acceptWork(input: {
		workItemId: string;
		doneWhen: string;
	}): Promise<WorkItemSummary>;
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
		chatOnly?: true;
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
	getAppAccess(input: {
		appId: string;
	}): Promise<NonNullable<OsGadgetManifest["resourceGrants"]>>;
	getAppCode(input: { appId: string; revisionId?: string }): Promise<AppCode>;
	/** Saved versions of an app, newest first. */
	listAppVersions(input: { appId: string }): Promise<AppVersion[]>;
	editAppFiles(
		input: EditAppFilesInput & { actorId: string },
	): Promise<AppCode>;
	publishAppDraft(input: PublishAppDraft): Promise<CreatedApp>;
	/** The steps an app declares, with their input shape and effect. */
	listAppOperations(input: ListAppOperations): Promise<AppOperations>;
	/** Runs one declared app step as the person who sent the turn. */
	runAppOperation(input: RunAppOperation): Promise<{ result: unknown }>;
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
	/**
	 * Work this turn reaches: the linked projects, or every project of the
	 * organization when the person who sent it is the only one who can open
	 * the workspace.
	 */
	listWork(options?: WorkListOptions): Promise<WorkItemSummary[]>;
	/**
	 * The open board: one named project, or with none named every active
	 * project the answering tedi leads (in a workspace only the sender can
	 * open), else the linked projects.
	 */
	listOpenWork(options?: {
		projectId?: string;
		query?: string;
	}): Promise<OpenWorkList>;
	/** Files a proposed Work Item in a project linked to this workspace. */
	createWork(
		input: CreateWorkInput & { actorId: string },
	): Promise<WorkItemSummary>;
}
