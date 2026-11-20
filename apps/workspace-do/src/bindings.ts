/**
 * The objects the sandbox `env` exposes. Each is a plain object over the
 * data port, then wrapped with `wrapBinding`, so every call is checked,
 * executed and written to the change record exactly as a gateway tool call
 * would be. Nothing here knows about the model or the Durable Object.
 */
import type {
	AccountabilityAdapter,
	Actor,
	ChangeRecord,
	ComplianceAdapter,
	MemoryAdapter,
	RevisionRef,
	Source,
	UndoPlan,
} from "@tedix/agent-governance/types";
import { wrapBinding } from "@tedix/agent-governance/wrap-binding";
import {
	OsOutputContentSchema,
	type OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { applyDocumentBlockPatch } from "@tedix/api-contract/utils/document-patch";
import type {
	AllowAppReadInput,
	RegisterAppScheduleInput,
} from "@tedix/api-contract/schemas/os-app-runtime";
import type { BindingName } from "./declarations";
import { buildMemoryBinding } from "./memory-binding";
import {
	FILE_TEXT_PART_CHARS,
	encodedLength,
	fileTextLines,
	fileTextUnavailable,
	readTextPart,
	searchTextLines,
} from "./file-text";
import { buildSheetBinding } from "./sheet-binding";
import { buildPresentationBinding } from "./presentation-bindings";
import { buildView, type ShownView } from "./views";
import { approvalDomain, checkWebUrl, type WebPort } from "./web";
import type { workspaceAccounts } from "./accounts";
import { ACCOUNTS_UNAVAILABLE } from "./prompt";
import { isMachineWriteTool } from "@tedix/api-contract/schemas/machines";
import { MACHINE_UNAVAILABLE, type workspaceMachine } from "./machine";
import { PERSON_UNAVAILABLE, type workspacePerson } from "./person";
import type {
	CreateAppInput,
	CreateWorkInput,
	OutputDetail,
	OutputSummary,
	WorkspaceDataPort,
	WorkspaceRunPort,
} from "./data-port";

const OPEN_DISPOSITIONS = new Set([
	"proposed",
	"accepted",
	"in_progress",
	"blocked",
	"review",
]);

export interface BindingDeps {
	data: WorkspaceDataPort;
	runs?: WorkspaceRunPort;
	compliance: ComplianceAdapter;
	accountability: AccountabilityAdapter;
	memory?: MemoryAdapter;
	actor: Actor;
	source: Source;
	onRecorded?: (record: ChangeRecord) => void;
	/** Puts a view in the running turn's answer; throws past the turn's limit. */
	showView?: (view: ShownView) => void;
	/** Web page reads for the running conversation; absent outside a chat turn. */
	web?: WebPort;
	/** Shows a "Connect" card in the running turn's answer; absent outside a chat turn. */
	requestConnection?: (request: ConnectionRequest) => void;
	scheduleRegistered?: (run: {
		gadgetId: string;
		triggerId: string;
		name: string;
	}) => void;
	accounts?: ReturnType<typeof workspaceAccounts>;
	accountActor?: Actor;
	/** Absent unless a signed-in person sent the turn themself. */
	machine?: ReturnType<typeof workspaceMachine>;
	/** Absent unless a signed-in person sent the turn themself. */
	person?: ReturnType<typeof workspacePerson>;
}

/** What the chat needs to show a "Connect" card. It names no person. */
export interface ConnectionRequest {
	resourceId: string;
	resourceName: string;
	providerId: string;
	service: string;
	connectionScope: "personal" | "organization";
	reason?: string;
}

/** The longest reason shown on a "Connect" card. */
export const CONNECTION_REASON_MAX_CHARS = 240;

function revisionRef(output: OutputSummary | OutputDetail | null | undefined) {
	return output?.revisionId ? { revisionId: output.revisionId } : undefined;
}

export function buildWorkspaceBindings(
	deps: BindingDeps,
): Record<BindingName, object> {
	const common = {
		compliance: deps.compliance,
		accountability: deps.accountability,
		actor: deps.actor,
		source: deps.source,
		onRecorded: deps.onRecorded,
	};
	const data = deps.data;

	// The lines of an uploaded file's text, or the reason it has none.
	const fileText = async (input: { outputId?: unknown }) => {
		if (typeof input?.outputId !== "string" || !input.outputId)
			throw new Error("Name the file by its outputId");
		const output = await data.getOutput(input.outputId);
		if (!output?.content) throw new Error("File not found or unavailable");
		const file =
			output.content.kind === "document" ? output.content.file : undefined;
		if (!file)
			throw new Error(
				"This is not an uploaded file. Read it with env.outputs.get(outputId).",
			);
		const stored = await data.readFileText(file);
		const named = { outputId: output.id, title: output.title };
		return stored?.status === "text"
			? { named, lines: fileTextLines(stored.text) }
			: { named, reason: fileTextUnavailable(stored) };
	};
	const outputs = {
		list: (options?: {
			kind?: OutputSummary["kind"];
			status?: OutputSummary["status"];
		}) => data.listOutputs(options),
		get: (outputId: string) => data.getOutput(outputId),
		readFileText: async (input: {
			outputId: string;
			startLine?: number;
			lineCount?: number;
		}) => {
			const file = await fileText(input);
			if (!file.lines)
				return { readable: false as const, ...file.named, reason: file.reason };
			return {
				readable: true as const,
				...file.named,
				...readTextPart(file.lines, input, FILE_TEXT_PART_CHARS, encodedLength),
			};
		},
		searchFileText: async (input: {
			outputId: string;
			query: string;
			startLine?: number;
		}) => {
			const file = await fileText(input);
			if (!file.lines)
				return { readable: false as const, ...file.named, reason: file.reason };
			return {
				readable: true as const,
				...file.named,
				...searchTextLines(file.lines, input),
			};
		},
		create: (input: { title: string; content: OsOutputContent }) =>
			data.createOutput({ ...input, actorId: deps.actor.id }),
		revise: (input: {
			outputId: string;
			content: OsOutputContent;
			expectedRevision: number;
			note?: string;
		}) => data.reviseOutput({ ...input, actorId: deps.actor.id }),
	};
	const readDocument = async (input: { outputId: string }) => {
		const output = await data.getOutput(input.outputId);
		if (!output || output.content?.kind !== "document")
			throw new Error("Document not found or unavailable");
		return { ...output, content: output.content };
	};
	const documents = {
		read: readDocument,
		replace: async (input: {
			outputId: string;
			expectedRevision: number;
			content: unknown;
		}) => {
			await readDocument(input);
			const content = OsOutputContentSchema.parse(input.content);
			if (content.kind !== "document")
				throw new Error("Expected document content");
			return data.reviseOutput({
				outputId: input.outputId,
				expectedRevision: input.expectedRevision,
				content,
				actorId: deps.actor.id,
			});
		},
		edit: async (input: {
			outputId: string;
			expectedRevision: number;
			ops: unknown;
		}) => {
			const output = await readDocument(input);
			return data.reviseOutput({
				outputId: input.outputId,
				expectedRevision: input.expectedRevision,
				content: applyDocumentBlockPatch(output.content, input.ops),
				actorId: deps.actor.id,
			});
		},
	};
	const documentWrite = {
		riskTier: "bounded_write" as const,
		blastRadius: "single_resource" as const,
		before: async (args: unknown[]) =>
			revisionRef(
				await data.getOutput((args[0] as { outputId: string }).outputId),
			),
		after: async (_args: unknown[], result: unknown) =>
			revisionRef(result as OutputDetail),
		undo: (
			_args: unknown[],
			_result: unknown,
			before?: RevisionRef,
		): UndoPlan | undefined =>
			before ? { kind: "rollback_revision", toRevision: before } : undefined,
	};
	// Saving a new app, or letting an app read a workspace file, always holds
	// for the person's approval. The checks below run first, so a card is only
	// ever shown for an app that loads and for files this workspace has.
	const appCreateGate = wrapBinding(
		{
			create: (input: CreateAppInput) =>
				data.createApp({ ...input, actorId: deps.actor.id }),
			allowRead: (input: AllowAppReadInput) =>
				data.allowAppRead({ ...input, actorId: deps.actor.id }),
		},
		{
			...common,
			resource: "app",
			methods: {
				create: { riskTier: "bounded_write", blastRadius: "single_resource" },
				allowRead: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
			},
		},
	);
	const apps = {
		list: () => data.listApps(),
		create: async (input: CreateAppInput) => {
			await data.checkNewApp(input);
			return appCreateGate.create(input);
		},
		allowRead: async (input: AllowAppReadInput) => {
			if (!(await data.readableFileTitles(input?.reads)).length)
				throw new Error("Name the files in reads: { name: outputId }");
			return appCreateGate.allowRead(input);
		},
		registerSchedule: async (input: RegisterAppScheduleInput) => {
			const run = await data.registerAppSchedule({
				...input,
				actorId: deps.actor.id,
			});
			deps.scheduleRegistered?.(run);
			return {
				...run,
				enabled: false,
				message: "The schedule is off until a person turns it on.",
			};
		},
		getCode: (input: { appId: string; revisionId?: string }) =>
			data.getAppCode(input),
		versions: (input: { appId: string }) => data.listAppVersions(input),
		readFile: async (input: { appId: string; path: string }) => {
			const app = await data.getAppCode({ appId: input.appId });
			if (!Object.hasOwn(app.files, input.path))
				throw new Error("App file not found");
			return {
				appId: app.id,
				path: input.path,
				revisionId: app.revisionId,
				proposalId: app.proposalId,
				sequence: app.sequence,
				content: app.files[input.path],
			};
		},
		grep: async (input: { appId: string; query: string }) => {
			if (typeof input.query !== "string" || !input.query)
				throw new Error("A search needs text");
			const app = await data.getAppCode({ appId: input.appId });
			const matches: Array<{ path: string; line: number; text: string }> = [];
			let truncated = false;
			for (const [path, text] of Object.entries(app.files)) {
				for (const [line, value] of text.split("\n").entries()) {
					if (!value.includes(input.query)) continue;
					if (matches.length === 200) {
						truncated = true;
						break;
					}
					matches.push({ path, line: line + 1, text: value.slice(0, 2000) });
				}
			}
			return { revisionId: app.revisionId, matches, truncated };
		},
		editFile: (input: {
			appId: string;
			path: string;
			expectedRevisionId: string;
			proposalId?: string;
			expectedSequence?: number;
			before: string;
			after: string;
		}) =>
			data.editAppFiles({
				appId: input.appId,
				expectedRevisionId: input.expectedRevisionId,
				proposalId: input.proposalId,
				expectedSequence: input.expectedSequence,
				edits: [{ path: input.path, before: input.before, after: input.after }],
				actorId: deps.actor.id,
			}),
		writeFile: (input: {
			appId: string;
			path: string;
			expectedRevisionId: string;
			proposalId?: string;
			expectedSequence?: number;
			content: string;
		}) =>
			data.editAppFiles({
				appId: input.appId,
				expectedRevisionId: input.expectedRevisionId,
				proposalId: input.proposalId,
				expectedSequence: input.expectedSequence,
				edits: [{ path: input.path, after: input.content }],
				actorId: deps.actor.id,
			}),
		restoreVersion: (input: {
			appId: string;
			revisionId: string;
			expectedRevisionId: string;
			proposalId?: string;
			expectedSequence?: number;
		}) =>
			data.editAppFiles({
				appId: input.appId,
				expectedRevisionId: input.expectedRevisionId,
				proposalId: input.proposalId,
				expectedSequence: input.expectedSequence,
				edits: [],
				restoreRevisionId: input.revisionId,
				actorId: deps.actor.id,
			}),
	};
	const resources = {
		list: () => data.listResources(),
		// Changes nothing: it only puts a card in the chat. A request that
		// cannot lead anywhere shows no card and says what to do instead.
		requestConnection: async (input: {
			resourceId?: unknown;
			reason?: unknown;
		}) => {
			if (typeof input?.resourceId !== "string" || !input.resourceId)
				throw new Error("Name the source by its resourceId");
			const resource = (await data.listResources()).find(
				(item) => item.id === input.resourceId,
			);
			if (!resource)
				throw new Error(
					"No connected source has that id. List them with env.resources.list().",
				);
			if (resource.connectedForYou === null)
				return {
					requested: false as const,
					message: `${resource.name} needs no account, so there is nothing to connect.`,
				};
			if (resource.connectedForYou)
				return {
					requested: false as const,
					message: `The ${resource.service} account for ${resource.name} is already connected.`,
				};
			if (!deps.requestConnection)
				throw new Error("A connection can be asked for only in a chat turn");
			const reason =
				typeof input.reason === "string"
					? input.reason.trim().slice(0, CONNECTION_REASON_MAX_CHARS)
					: "";
			deps.requestConnection({
				resourceId: resource.id,
				resourceName: resource.name,
				providerId: resource.providerId,
				service: resource.service,
				connectionScope: resource.connectionScope,
				...(reason ? { reason } : {}),
			});
			return {
				requested: true as const,
				message:
					resource.connectionScope === "personal"
						? `The chat now shows a "Connect ${resource.service}" card. Say in one sentence that the person can connect their own ${resource.service} account there. Do not ask again in this answer.`
						: `The chat now shows a "Connect ${resource.service}" card. Say in one sentence that an organization admin connects the shared ${resource.service} account there. Do not ask again in this answer.`,
			};
		},
	};
	const runPort = () => {
		if (!deps.runs)
			throw new Error("Coding runs are available in workspace chat");
		return deps.runs;
	};
	const work = {
		list: (options?: { disposition?: string; limit?: number }) =>
			data.listWork(options),
		listOpen: async () =>
			(await data.listWork({ limit: 500 }))
				.filter((item) => OPEN_DISPOSITIONS.has(item.disposition))
				.map(({ id, title, disposition, workKind, priority }) => ({
					id,
					title,
					disposition,
					workKind,
					priority,
				})),
		create: (input: CreateWorkInput) =>
			data.createWork({ ...input, actorId: deps.actor.id }),
		listProjects: () => runPort().listRunProjects(),
		startRun: async (input: Parameters<WorkspaceRunPort["startRun"]>[0]) => {
			const { projectId, ...run } = await runPort().startRun(input);
			await deps.machine?.wakeRunner({
				workItemId: run.workItemId,
				projectId,
				executor: run.executor,
			});
			return run;
		},
		readRun: (input: Parameters<WorkspaceRunPort["readRun"]>[0]) =>
			runPort().readRun(input),
		sendRunMessage: (
			input: Parameters<WorkspaceRunPort["sendRunMessage"]>[0],
		) => runPort().sendRunMessage(input),
		stopRun: (input: Parameters<WorkspaceRunPort["stopRun"]>[0]) =>
			runPort().stopRun(input),
	};

	// The first page from a domain in a conversation holds for approval. The
	// gate's arguments name only the conversation and domain, so one approval
	// covers that domain for the rest of the conversation.
	const webGate = wrapBinding(
		{
			fetch: (grant: { conversationId: string; domain: string }) => {
				deps.web?.allowDomain(grant.domain);
				return { domain: grant.domain, allowed: true as const };
			},
		},
		{
			...common,
			resource: "web_domain",
			methods: {
				fetch: {
					riskTier: "external_side_effect",
					blastRadius: "external_system",
				},
			},
		},
	);
	const web = {
		fetch: async (url: unknown) => {
			const port = deps.web;
			if (!port) throw new Error("Web pages can be read only in a chat turn");
			const domain = approvalDomain(checkWebUrl(url));
			if (!port.isDomainAllowed(domain))
				await webGate.fetch({ conversationId: port.conversationId, domain });
			return port.fetchPage(url as string);
		},
	};

	const machinePort = () => {
		if (!deps.machine) throw new Error(MACHINE_UNAVAILABLE);
		return deps.machine;
	};
	type MachineCall = Parameters<ReturnType<typeof workspaceMachine>["call"]>[0];
	// Changing files or running a command on a machine always holds for the
	// person's approval here. The API then applies the machine's own rules.
	const machineWriteGate = wrapBinding(
		{ call: (input: MachineCall) => machinePort().call(input) },
		{
			...common,
			resource: "machine_write",
			methods: {
				call: {
					riskTier: "external_side_effect",
					blastRadius: "external_system",
				},
			},
		},
	);
	const machine = {
		list: () => machinePort().list(),
		call: (input: MachineCall) => {
			const port = machinePort();
			return typeof input?.tool === "string" && isMachineWriteTool(input.tool)
				? machineWriteGate.call(input)
				: port.call(input);
		},
		read: (input: { callId?: unknown }) => machinePort().read(input),
	};

	const person = {
		memory: (input?: { query?: unknown; limit?: unknown }) => {
			if (!deps.person) throw new Error(PERSON_UNAVAILABLE);
			return deps.person.memory(input);
		},
	};

	const views = {
		show: (input: unknown) => {
			if (!deps.showView) throw new Error("Views need a running chat turn");
			const view = buildView(input, crypto.randomUUID());
			deps.showView(view);
			return { viewId: view.viewId, shown: true as const };
		},
	};

	return {
		memory: buildMemoryBinding(deps),
		views: wrapBinding(views, {
			...common,
			resource: "view",
			methods: { show: { riskTier: "read", blastRadius: "none" } },
		}),
		sheets: buildSheetBinding(deps),
		presentations: buildPresentationBinding(deps),
		documents: wrapBinding(documents, {
			...common,
			resource: "output",
			methods: {
				read: { riskTier: "read", blastRadius: "none" },
				replace: documentWrite,
				edit: documentWrite,
			},
		}),
		outputs: wrapBinding(outputs, {
			...common,
			resource: "output",
			methods: {
				list: { riskTier: "read", blastRadius: "none" },
				get: { riskTier: "read", blastRadius: "none" },
				readFileText: { riskTier: "read", blastRadius: "none" },
				searchFileText: { riskTier: "read", blastRadius: "none" },
				create: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					after: async (_args: unknown[], result: unknown) =>
						revisionRef(result as OutputDetail),
				},
				revise: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					before: async (args: unknown[]) => {
						const input = args[0] as { outputId: string };
						return revisionRef(await data.getOutput(input.outputId));
					},
					after: async (_args: unknown[], result: unknown) =>
						revisionRef(result as OutputDetail),
					undo: (
						_args: unknown[],
						_result: unknown,
						before?: RevisionRef,
					): UndoPlan | undefined =>
						before
							? { kind: "rollback_revision", toRevision: before }
							: undefined,
				},
			},
		}),
		apps: wrapBinding(apps, {
			...common,
			resource: "app",
			methods: {
				registerSchedule: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
				list: { riskTier: "read", blastRadius: "none" },
				getCode: { riskTier: "read", blastRadius: "none" },
				versions: { riskTier: "read", blastRadius: "none" },
				readFile: { riskTier: "read", blastRadius: "none" },
				grep: { riskTier: "read", blastRadius: "none" },
				// The name and source check; the save itself is the gate above.
				create: {
					resource: "app_check",
					riskTier: "read",
					blastRadius: "none",
				},
				allowRead: {
					resource: "app_check",
					riskTier: "read",
					blastRadius: "none",
				},
				// Proposals cannot advance the app revision. The person reviews all files once.
				editFile: {
					resource: "app_draft",
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
				writeFile: {
					resource: "app_draft",
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
				restoreVersion: {
					resource: "app_draft",
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
			},
		}),
		resources: wrapBinding(resources, {
			...common,
			resource: "resource",
			methods: {
				list: { riskTier: "read", blastRadius: "none" },
				requestConnection: { riskTier: "read", blastRadius: "none" },
			},
		}),
		accounts: wrapBinding(
			deps.accounts ?? {
				list: accountsUnavailable,
				describe: accountsUnavailable,
				read: accountsUnavailable,
			},
			{
				...common,
				actor: deps.accountActor ?? common.actor,
				resource: "connected_account",
				methods: {
					list: { riskTier: "read", blastRadius: "none" },
					describe: { riskTier: "read", blastRadius: "none" },
					read: { riskTier: "read", blastRadius: "none" },
				},
			},
		),
		web: wrapBinding(web, {
			...common,
			resource: "web",
			methods: { fetch: { riskTier: "read", blastRadius: "none" } },
		}),
		machine: wrapBinding(machine, {
			...common,
			resource: "machine",
			methods: {
				list: { riskTier: "read", blastRadius: "none" },
				// A read tool, or the check before the gate above holds a write.
				call: { riskTier: "read", blastRadius: "none" },
				read: { riskTier: "read", blastRadius: "none" },
			},
		}),
		person: wrapBinding(person, {
			...common,
			resource: "person",
			methods: { memory: { riskTier: "read", blastRadius: "none" } },
		}),
		work: wrapBinding(work, {
			...common,
			resource: "work",
			methods: {
				list: { riskTier: "read", blastRadius: "none" },
				listOpen: { riskTier: "read", blastRadius: "none" },
				listProjects: { riskTier: "read", blastRadius: "none" },
				startRun: { riskTier: "bounded_write", blastRadius: "single_resource" },
				readRun: { riskTier: "read", blastRadius: "none" },
				sendRunMessage: {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
				stopRun: { riskTier: "bounded_write", blastRadius: "single_resource" },
				create: { riskTier: "bounded_write", blastRadius: "single_resource" },
			},
		}),
	};
}

function accountsUnavailable(): never {
	throw new Error(ACCOUNTS_UNAVAILABLE);
}
