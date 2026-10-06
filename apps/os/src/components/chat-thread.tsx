import {
	isLocalAiUnavailable,
	isLocalWorkersAi,
	LOCAL_AI_UNAVAILABLE,
} from "@/lib/local-inference";
import {
	ArrowCounterClockwise,
	ArrowDown,
	ArrowUp,
	CaretDown,
	File,
	FolderSimple,
	Info,
	MagnifyingGlass,
	Microphone,
	Plus,
	Paperclip,
	Square,
	X,
} from "@phosphor-icons/react";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
	EnqueueHomeMessageOutput,
	HomeReadOnlyApp,
	HomeMessage,
	HomeRun,
	HomeRunSet,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { ComponentType } from "react";
import {
	Fragment,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isImeComposing } from "@/lib/keyboard";
import {
	appendVoiceTranscript,
	useComposerDictation,
} from "@/lib/use-composer-dictation";
import {
	VOICE_WAVE_BAR_COUNT,
	voiceWaveBarHeight,
} from "@tedix/chat-transport/voice-composer";
import {
	Alert,
	AlertAction,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Loader } from "@/components/kumo/loader";
import { Text } from "@/components/kumo/text";
import { Badge } from "@/components/kumo/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { ClipboardText } from "@/components/kumo/clipboard-text";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { ChatMarkdown } from "@/components/chat-markdown";
import { ConversationCapabilityPalette } from "@/components/conversation-capability-palette";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Textarea } from "@/components/kumo/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import type { QueryClient } from "@tanstack/react-query";
import { osApi, osChatReadApi, osDirectReadApi } from "@/lib/api";
import { observeScrollResize } from "@tedix/chat-transport/composer-semantics";
import {
	ApprovalCard,
	type ApprovalCardData,
	approvalsFromRunSet,
	type CardRunLinkProps,
	dedupeDelegations,
	DelegationWorkCard,
	ExecutionLinkChip,
	mergeToolEvents,
	pruneDepartedRunFrames,
	RunControls,
	sortToolStates,
	TOOL_EVENT_KINDS,
	WorkTraceCard,
} from "@/components/chat-cards";
import {
	StreamedAssistantBubble,
	StreamedPhaseRow,
	StreamedRationaleRow,
} from "@/components/chat-streaming";
import { isNearBottom } from "@tedix/chat-transport/composer-semantics";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { visibleOverlays } from "@/lib/overlay-state";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";
import { CostChip } from "@/components/cost-chip";
import { kernelUsageReading } from "@/lib/cost-reading";
import { errorMessage } from "@/lib/orpc-error";
import {
	emptyProvisionalSends,
	carryProvisionalFirstTurn,
	hasProvisionalSend,
	isUnknownSendOutcome,
	listProvisionalSends,
	PROVISIONAL_SEND_LABEL,
	type ProvisionalSend,
	type ProvisionalSendAction,
	type ProvisionalSendMap,
	provisionalSendMessageId,
	reduceProvisionalSends,
	takeCarriedProvisionalFirstTurn,
} from "@/lib/provisional-send";
import { useChatTransport } from "@/lib/use-capn-chat";
import { prepareChatAttachment } from "@/lib/chat-attachment-upload";
import { useTediNames } from "@/lib/use-tedi-names";
import type { ConversationStreamStatus } from "@/lib/conversation-stream";
import { useRealtimeStatus, useRealtimeSurface } from "@/lib/use-realtime";
import { absoluteTime, relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { WidgetFrame } from "@/components/widget-frame";
import { chatWidgetTargetsFromMetadata } from "@/lib/chat-widget-targets";
import {
	homeMessagesQueryKey,
	homeMessagesQueryOptions,
	homeRunSetQueryKey,
	homeRunSetQueryOptions,
	modelCatalogQueryOptions,
	operationalContextQueryOptions,
	SKILL_CATALOG_LIMIT,
	skillCatalogQueryOptions,
} from "@/lib/os-query-options";
import { initialModelRef, modelsForNewSelection } from "@/lib/model-selection";
import { parseSkillReferences } from "@tedix/api-contract/utils/skill-reference";
import {
	ChatSkillPicker,
	ChatSkillPills,
} from "@/components/chat-skill-picker";
import {
	type ComposerSkill,
	composerReachableSkills,
	draftPickerTrigger,
	filterComposerSkills,
	insertSkillReference,
	removeSkillReference,
} from "@/lib/chat-skill-picker";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/kumo/dropdown-menu";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	ACTIVE_PROJECTION_RECONCILE_MS,
	IDLE_PROJECTION_RECONCILE_MS,
	canonicalProjectionInterval,
} from "@tedix/chat-transport/canonical-projection";
import {
	type ModelImageInputSupport,
	resolveModelImageInput,
} from "@tedix/api-contract/schemas/model-catalog";
import type { ModelCatalogModel } from "@tedix/api-contract/schemas/model-catalog-projection";

/** Connected-app discovery performs connection verification plus live MCP
 * inspection, so it shares the direct-read transport budget with execution. */
const osDirectReadQuery = createTanstackQueryUtils(osDirectReadApi);

const readOnlyToolCatalogQueryOptions = (organizationId?: string) =>
	osDirectReadQuery.kernelRuntime.listReadOnlyTools.queryOptions({
		input: organizationId ? { organizationId } : {},
		staleTime: 30_000,
	});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Fast convergence cadence while a local send is pending or realtime is
 * degraded. */
export const RUN_POLL_INTERVAL_MS = 4000;

/** Canonical reconciliation backstop for mutable run-set state that can change
 * without a parent-run stream frame (for example child orphan settlement). */
export const RUN_SET_RECONCILE_INTERVAL_MS = ACTIVE_PROJECTION_RECONCILE_MS;

export const MESSAGES_PAGE_LIMIT = 50;

export const CHAT_STARTER_PROMPTS = [
	"Summarize the current workspace and identify the next decision.",
	"Investigate the latest output and cite the evidence behind your recommendation.",
	"Delegate a bounded task to the best-qualified digital worker.",
] as const;

export type ChatContext = {
	kind: "workspace" | "gadget" | "output";
	id: string;
	label: string;
};

type ComposerAttachment = TediMessageAttachment & { previewUrl: string | null };

const CHAT_FORMATS = ["Document", "Spreadsheet", "Presentation"] as const;

export type ChatResponseAction =
	| "visualize"
	| "generate-ui"
	| "output"
	| "gadget";

export const CHAT_RESPONSE_ACTIONS: ReadonlyArray<{
	action: ChatResponseAction;
	label: string;
	description: string;
}> = [
	{
		action: "visualize",
		label: "Visualize",
		description:
			"Generate a catalog-constrained json-render MCP UI now, without saving an artifact.",
	},
	{
		action: "generate-ui",
		label: "Generate UI",
		description:
			"Generate a transient free-form HTML/CSS MCP App now, without saving an artifact.",
	},
	{
		action: "output",
		label: "Create output",
		description:
			"Prepare a durable document, sheet, or presentation for review.",
	},
	{
		action: "gadget",
		label: "Build gadget",
		description: "Prepare a reusable Workspace Gadget for review.",
	},
] as const;

/**
 * Promotion is a conversation step, never a hidden persistence shortcut. The
 * operator can inspect or edit this draft before sending it, and durable
 * Output/Gadget creation still goes through the kernel's ordinary approval
 * and tool-policy path. MCP UI remains explicitly transient.
 */
export function chatResponseActionPrompt(action: ChatResponseAction): string {
	switch (action) {
		case "visualize":
			return "Generate a polished, transient json-render MCP UI for the immediately preceding response. Inspect ui.get_catalog, author a custom catalog-constrained layoutSpec, validate it with ui.validate_layout, and return ui.create_view directly so it renders inline. Preserve a useful structured fallback. Do not create or modify a durable Gadget or Output.";
		case "generate-ui":
			return "Generate a polished, transient free-form HTML/CSS MCP App for the immediately preceding response. Return ui.create_mcp_app directly with self-contained semantic HTML/CSS, the relevant structured data, and a meaningful summary fallback so it renders inline. Do not use remote assets and do not create or modify a durable Gadget or Output.";
		case "output":
			return "Turn the immediately preceding response into a durable OS Output. First propose the best format and title, then ask for my confirmation before creating or modifying anything.";
		case "gadget":
			return "Turn the immediately preceding response into a reusable OS Gadget. First propose what the Gadget will do and which capabilities it needs, then ask for my confirmation before creating or modifying anything.";
	}
}

export function chatResponseActionSendsImmediately(
	action: ChatResponseAction,
): boolean {
	return action === "visualize" || action === "generate-ui";
}

/** Only the newest successful prose answer may offer follow-up actions. */
/**
 * The message the continuation chips attach to, or null.
 *
 * The chips promote an answer — visualize it, build a gadget from it. A turn
 * that reports a failure has nothing to promote, and offering "Visualize" under
 * "I couldn't complete that turn" reads as the product not knowing what just
 * happened. The parent message is legitimately `completed` in that case (it
 * delivered the report), so the failure has to come from the child run it
 * names, which the run set already carries.
 */
export function latestActionableAssistantMessageId(
	messages: readonly HomeMessage[],
	runs: readonly HomeRun[] = [],
): string | null {
	const failedRuns = new Set(
		runs.flatMap((run) =>
			run.id &&
			!ACTIVE_RUN_STATUSES.has(run.status) &&
			run.status !== "completed"
				? [run.id]
				: [],
		),
	);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "user") return null;
		if (
			message?.role === "assistant" &&
			message.status === "completed" &&
			!(message.childRunId && failedRuns.has(message.childRunId)) &&
			decodeChatContext(message.content).content.trim().length > 0
		) {
			return message.id;
		}
	}
	return null;
}

const CHAT_SLASH_COMMANDS = [
	{
		command: "/summarize",
		instruction:
			"Summarize the current conversation with decisions, evidence, and next actions.",
	},
	{
		command: "/delegate",
		instruction:
			"Prepare a bounded delegation proposal; do not dispatch without the required approval.",
	},
	{
		command: "/investigate",
		instruction:
			"Investigate this request and cite the evidence supporting each conclusion.",
	},
	{
		command: "/read",
		instruction:
			'Run one explicit read-only MCP tool: /read app.tool {"argument": "value"}',
	},
] as const;

type DirectReadCommand = {
	appSlug: string;
	toolName: string;
	arguments: Record<string, unknown>;
};

type DirectReadRequest = DirectReadCommand & {
	conversationId: string;
	idempotencyKey: string;
	organizationId?: string;
	workspaceContext?: {
		workspaceId: string;
		workpiece?: { kind: "gadget" | "output"; id: string };
	};
};

/** Parse only an explicit, fully-qualified direct-read command. Natural-language
 * requests remain Home turns and retain kernel/tedi governance. */
export function parseDirectReadCommand(
	content: string,
): DirectReadCommand | null {
	const match = content
		.trim()
		.match(
			/^\/read\s+([a-z0-9-]+)\.([a-zA-Z0-9_.-]+)(?:\s+(\{[\s\S]*\}))?\s*$/,
		);
	if (!match?.[1] || !match[2]) return null;
	let args: Record<string, unknown> = {};
	if (match[3]) {
		try {
			const parsed: unknown = JSON.parse(match[3]);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				return null;
			args = parsed as Record<string, unknown>;
		} catch {
			return null;
		}
	}
	return { appSlug: match[1], toolName: match[2], arguments: args };
}

type ReadTool = HomeReadOnlyApp["tools"][number];
type JsonSchemaField = {
	type?: string | string[];
	title?: string;
	description?: string;
	default?: unknown;
	enum?: unknown[];
};

function initialReadValues(tool: ReadTool | null): Record<string, string> {
	if (!tool) return {};
	return Object.fromEntries(
		readToolFields(tool).flatMap((field) => {
			if (field.schema.default === undefined) return [];
			const value = field.schema.default;
			return [
				[field.name, typeof value === "string" ? value : JSON.stringify(value)],
			];
		}),
	);
}

function readConnectionLabel(
	state: HomeReadOnlyApp["connectionState"],
): string {
	return state === "connected"
		? "Connected"
		: state === "connection_required"
			? "Connect"
			: "Unavailable";
}

export function readToolFields(tool: ReadTool | null): Array<{
	name: string;
	required: boolean;
	schema: JsonSchemaField;
}> {
	if (!tool || !tool.inputSchema || typeof tool.inputSchema !== "object")
		return [];
	const root = tool.inputSchema as Record<string, unknown>;
	const properties = root.properties;
	if (
		!properties ||
		typeof properties !== "object" ||
		Array.isArray(properties)
	)
		return [];
	const required = new Set(
		Array.isArray(root.required)
			? root.required.filter(
					(value): value is string => typeof value === "string",
				)
			: [],
	);
	return Object.entries(properties).flatMap(([name, value]) =>
		value && typeof value === "object" && !Array.isArray(value)
			? [
					{
						name,
						required: required.has(name),
						schema: value as JsonSchemaField,
					},
				]
			: [],
	);
}

function coerceReadArgument(raw: string, schema: JsonSchemaField): unknown {
	const type = Array.isArray(schema.type)
		? schema.type.find((value) => value !== "null")
		: schema.type;
	if (schema.enum) {
		const exactString = schema.enum.find(
			(value) => typeof value === "string" && value === raw,
		);
		if (exactString !== undefined) return exactString;
		const matchingValue = schema.enum.find((value) => String(value) === raw);
		if (matchingValue !== undefined) return matchingValue;
	}
	if (type === "number" || type === "integer") {
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) throw new Error("Enter a valid number");
		return parsed;
	}
	if (type === "boolean") return raw === "true";
	if (type === "object" || type === "array") return JSON.parse(raw);
	return raw;
}

export function buildReadArguments(
	tool: ReadTool,
	values: Record<string, string>,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const field of readToolFields(tool)) {
		const raw = values[field.name]?.trim() ?? "";
		if (!raw) {
			if (field.required) throw new Error(`${field.name} is required`);
			continue;
		}
		try {
			output[field.name] = coerceReadArgument(raw, field.schema);
		} catch (error) {
			const types = Array.isArray(field.schema.type)
				? field.schema.type
				: [field.schema.type];
			if (types.includes("object") || types.includes("array")) {
				throw new Error(`${field.name} must be valid JSON`);
			}
			throw error;
		}
	}
	return output;
}

function DirectReadComposer({
	apps,
	pending,
	onClose,
	onRun,
}: {
	apps: HomeReadOnlyApp[];
	pending: boolean;
	onClose: () => void;
	onRun: (command: DirectReadCommand) => void;
}) {
	const [search, setSearch] = useState("");
	const initiallyConnected =
		apps.find((app) => app.connectionState === "connected") ?? apps[0];
	const [appSlug, setAppSlug] = useState(initiallyConnected?.slug ?? "");
	const selectedApp = apps.find((app) => app.slug === appSlug) ?? apps[0];
	const [toolName, setToolName] = useState(selectedApp?.tools[0]?.name ?? "");
	const selectedTool =
		selectedApp?.tools.find((tool) => tool.name === toolName) ??
		selectedApp?.tools[0] ??
		null;
	const [values, setValues] = useState<Record<string, string>>(() =>
		initialReadValues(selectedTool),
	);
	const [error, setError] = useState<string | null>(null);
	const visibleApps = apps.filter((app) =>
		`${app.name} ${app.slug} ${app.tools.map((tool) => tool.title).join(" ")}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	);
	return (
		<Card
			size="sm"
			className="relative z-30 mb-2 max-h-[min(70vh,48rem)] overflow-y-auto bg-kumo-base shadow-tedix-floating"
		>
			<CardHeader>
				<CardTitle>Read from a connected app</CardTitle>
			</CardHeader>
			<CardContent className="grid gap-3">
				<Input
					aria-label="Search connected apps"
					placeholder="Search apps and tools"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
					{visibleApps.length === 0 ? (
						<Text role="label" tone="secondary" className="m-0">
							No app or read action matches your search.
						</Text>
					) : null}
					{visibleApps.map((app) => (
						<Button
							key={app.slug}
							type="button"
							size="sm"
							variant={app.slug === selectedApp?.slug ? "secondary" : "ghost"}
							aria-pressed={app.slug === selectedApp?.slug}
							onClick={() => {
								setAppSlug(app.slug);
								setToolName(app.tools[0]?.name ?? "");
								setValues(initialReadValues(app.tools[0] ?? null));
							}}
						>
							{app.name}
							<Badge variant="outline" className="ml-1">
								{readConnectionLabel(app.connectionState)}
							</Badge>
						</Button>
					))}
				</div>
				{selectedApp ? (
					<div className="grid gap-1">
						<Label>Read action</Label>
						<div className="flex flex-wrap gap-1">
							{selectedApp.tools.map((tool) => (
								<Button
									key={tool.name}
									type="button"
									size="sm"
									variant={
										tool.name === selectedTool?.name ? "outline" : "ghost"
									}
									aria-pressed={tool.name === selectedTool?.name}
									onClick={() => {
										setToolName(tool.name);
										setValues(initialReadValues(tool));
									}}
								>
									{tool.title}
									{tool.connectionState !== "connected" ? (
										<Badge variant="outline" className="ml-1">
											{readConnectionLabel(tool.connectionState)}
										</Badge>
									) : null}
								</Button>
							))}
						</div>
					</div>
				) : null}
				{selectedTool ? (
					<div className="grid gap-2">
						{selectedTool.description ? (
							<Text role="label" tone="secondary" className="m-0">
								{selectedTool.description}
							</Text>
						) : null}
						{selectedTool.connectionState !== "connected" ? (
							<Alert
								variant={
									selectedTool.connectionState === "connection_required"
										? "info"
										: "destructive"
								}
							>
								<AlertTitle>
									{selectedTool.connectionState === "connection_required"
										? `Connect ${selectedApp?.name ?? "this app"}`
										: "This read is unavailable"}
								</AlertTitle>
								<AlertDescription>
									{selectedTool.connectionReason ??
										"The configured credential cannot currently be verified."}
								</AlertDescription>
								{selectedTool.connectProviderId ? (
									<AlertAction>
										<Button
											size="sm"
											variant="outline"
											render={
												<Link
													to="/admin/connections"
													search={{
														q: "",
														status: "used",
														connect: selectedTool.connectProviderId,
													}}
												/>
											}
										>
											Connect
										</Button>
									</AlertAction>
								) : null}
							</Alert>
						) : null}
						{readToolFields(selectedTool).map((field) => (
							<div className="grid gap-1" key={field.name}>
								<Label htmlFor={`direct-read-${field.name}`}>
									{field.schema.title ?? field.name}
									{field.required ? " *" : ""}
								</Label>
								{field.schema.enum ? (
									<Select
										value={values[field.name] ?? ""}
										onValueChange={(value) =>
											setValues((current) => ({
												...current,
												[field.name]: String(value ?? ""),
											}))
										}
									>
										<SelectTrigger
											id={`direct-read-${field.name}`}
											aria-label={field.schema.title ?? field.name}
										>
											<SelectValue placeholder="Choose a value" />
										</SelectTrigger>
										<SelectContent>
											{field.schema.enum.map((option) => (
												<SelectItem key={String(option)} value={String(option)}>
													{String(option)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : field.schema.type === "boolean" ? (
									<Select
										value={values[field.name] ?? ""}
										onValueChange={(value) =>
											setValues((current) => ({
												...current,
												[field.name]: String(value ?? ""),
											}))
										}
									>
										<SelectTrigger
											id={`direct-read-${field.name}`}
											aria-label={field.schema.title ?? field.name}
										>
											<SelectValue placeholder="Choose true or false" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="true">True</SelectItem>
											<SelectItem value="false">False</SelectItem>
										</SelectContent>
									</Select>
								) : field.schema.type === "object" ||
								  field.schema.type === "array" ? (
									<Textarea
										id={`direct-read-${field.name}`}
										aria-label={field.schema.title ?? field.name}
										placeholder={field.schema.description ?? "Enter valid JSON"}
										value={values[field.name] ?? ""}
										onValueChange={(value) =>
											setValues((current) => ({
												...current,
												[field.name]: value,
											}))
										}
										minRows={3}
										maxRows={8}
									/>
								) : (
									<Input
										id={`direct-read-${field.name}`}
										aria-label={field.schema.title ?? field.name}
										placeholder={
											field.schema.description ?? field.schema.type?.toString()
										}
										value={values[field.name] ?? ""}
										onChange={(event) =>
											setValues((current) => ({
												...current,
												[field.name]: event.target.value,
											}))
										}
									/>
								)}
							</div>
						))}
					</div>
				) : null}
				{error ? (
					<Text role="label" tone="error" className="m-0">
						{error}
					</Text>
				) : null}
			</CardContent>
			<CardFooter className="justify-end">
				<Button type="button" size="sm" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					loading={pending}
					disabled={
						!selectedApp ||
						!selectedTool ||
						selectedTool.connectionState !== "connected" ||
						pending
					}
					onClick={() => {
						if (!selectedApp || !selectedTool) return;
						try {
							onRun({
								appSlug: selectedApp.slug,
								toolName: selectedTool.name,
								arguments: buildReadArguments(selectedTool, values),
							});
						} catch (cause) {
							setError(
								cause instanceof Error ? cause.message : "Check the arguments",
							);
						}
					}}
				>
					Run read
				</Button>
			</CardFooter>
		</Card>
	);
}

function attachmentType(file: File): TediMessageAttachment["type"] {
	return file.type.startsWith("image/") ? "image" : "file";
}

/**
 * Declared image-input capability of the model this composer would send to.
 *
 * The projection row wins (it is the org's own evaluated catalog), the static
 * catalog answers a ref the projection did not list, and anything else — no
 * selection yet, a custom or org-configured deployment, the deliberately
 * ungated env default — is `unknown`. `unknown` is never collapsed into a
 * verdict here; that is the whole point of the tri-state.
 */
export function selectedModelImageInput(
	models: readonly ModelCatalogModel[],
	selectedRef: string | null,
): ModelImageInputSupport {
	if (selectedRef === null) return "unknown";
	const listed = models.find((model) => model.ref === selectedRef);
	return listed ? listed.imageInput : resolveModelImageInput(selectedRef);
}

/**
 * Why this model must not be given an image, or null when it may be.
 *
 * `unknown` refuses. Attaching and hoping is the expensive failure: an image
 * the model rejects is part of the durable turn, so it replays on every
 * subsequent request in the conversation and wedges it permanently — there is
 * no client-side recovery from that, while a refused attachment costs one
 * sentence and a model switch.
 */
export function imageAttachmentRefusal(
	support: ModelImageInputSupport,
	modelLabel: string,
): string | null {
	if (support === "supported") return null;
	if (support === "unsupported") {
		return `${modelLabel} cannot read images: its serving path drops image attachments, so the file would never reach the model. Pick a vision-capable model, or send the file's contents as text.`;
	}
	return `${modelLabel} does not declare image support, so Tedix will not attach one: an image this model rejects stays in the turn and replays on every later message. Pick a model whose image support is declared.`;
}

/**
 * Why the composer will not take an image right now, or null when it will.
 *
 * Three states, not two. The gate is right to fail closed before a model is
 * resolved — the send would fall through to the server default (`modelRef:
 * undefined`), whose image support this client cannot read — but "the selected
 * model does not declare image support" is a FALSE sentence when nothing is
 * selected, and it is exactly the state the operator sees while the catalog
 * query is in flight and permanently if it fails or returns no allowed model.
 * So the no-selection states get their own copy, and a catalog still resolving
 * is told apart from one that resolved to nothing.
 */
export function composerImageRefusal(input: {
	models: readonly ModelCatalogModel[];
	selectedRef: string | null;
	modelLabel: string;
	/** The catalog query is in flight, or has landed but not yet been applied. */
	selectionPending: boolean;
}): string | null {
	if (input.selectedRef === null) {
		return input.selectionPending
			? "Tedix is still loading which models this workspace may use, so it cannot yet tell whether the model that would answer can read images. Send the message without the image, or try again in a moment."
			: "No model is resolved for this workspace, so the message would route to the server's default — whose image support Tedix cannot read here, and an image the model rejects stays in the turn and replays on every later message. Pick a model whose image support is declared, or send the file's contents as text.";
	}
	return imageAttachmentRefusal(
		selectedModelImageInput(input.models, input.selectedRef),
		input.modelLabel,
	);
}

async function readComposerAttachment(file: File): Promise<ComposerAttachment> {
	const prepared = await prepareChatAttachment(file);
	const content = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(reader.error ?? new Error("Could not read attachment"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(prepared.blob);
	});
	return {
		content,
		fileName: file.name,
		mimeType: prepared.mimeType,
		size: prepared.blob.size,
		type: attachmentType(file),
		previewUrl: file.type.startsWith("image/") ? content : null,
	};
}

const CONTEXT_PREFIX = "[[tedix-context:";

/** A readable durable envelope rather than browser-only composer state. */
export function encodeChatContext(
	context: ChatContext,
	content: string,
): string {
	return `${CONTEXT_PREFIX}${context.kind}:${context.id}:${encodeURIComponent(context.label)}]]\n\n${content}`;
}

export function decodeChatContext(content: string): {
	context: ChatContext | null;
	content: string;
} {
	if (!content.startsWith(CONTEXT_PREFIX)) return { context: null, content };
	const end = content.indexOf("]]\n\n");
	if (end < 0) return { context: null, content };
	const fields = content.slice(CONTEXT_PREFIX.length, end).split(":");
	if (fields.length !== 3) return { context: null, content };
	const [kind, id, encodedLabel] = fields;
	if (
		(kind !== "workspace" && kind !== "gadget" && kind !== "output") ||
		!id ||
		!encodedLabel
	) {
		return { context: null, content };
	}
	try {
		return {
			context: { kind, id, label: decodeURIComponent(encodedLabel) },
			content: content.slice(end + 4),
		};
	} catch {
		return { context: null, content };
	}
}

/** Run statuses `readRunSet` reports in `activeRunIds` — the running set. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"requires_approval",
]);

/** Active work is rendered as live chrome only. Completed delegation history is
 * already represented by its own transcript turn and run detail. */
export function activeDelegations(runs: readonly HomeRun[]) {
	return dedupeDelegations(
		runs.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)),
	);
}

/** The enqueue status union retains a legacy `needs_delegation` sentinel for
 * every fast terminal Kernel turn. Only a typed delegate route is a real
 * request for operator choice; direct Home answers must not show that notice. */
export function needsDelegationChoice(
	output: EnqueueHomeMessageOutput,
): boolean {
	if (output.status !== "needs_delegation") return false;
	const metadata = output.run.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return false;
	}
	const route = metadata.kernelRoute;
	return Boolean(
		route &&
		typeof route === "object" &&
		!Array.isArray(route) &&
		(route as Record<string, unknown>).routeKind === "delegate_tedi",
	);
}

/** localStorage key for the per-conversation composer draft. A not-yet-created
 * conversation (`conversationId === null`) drafts under the shared "new" key. */
export function chatDraftKey(conversationId: string | null): string {
	return `tedix-os:chat-draft:${conversationId ?? "new"}`;
}

/**
 * The OS creates a conversation with its first persisted turn. An omitted id
 * is deliberately meaningful to the API (it selects the caller's default
 * Home thread), so the synthetic New state must mint an explicit id instead.
 */
export function newHomeConversationId(
	randomUuid: () => string = () => crypto.randomUUID(),
): string {
	return `home:os:${randomUuid()}`;
}

/**
 * Preserve an existing thread and a pending New-thread id verbatim. Only the
 * first send from the synthetic state mints an OS-owned conversation id.
 */
export function conversationIdForSend(
	conversationId: string | null,
	pendingNewConversationId: string | null,
	randomUuid: () => string = () => crypto.randomUUID(),
): string {
	return (
		conversationId ??
		pendingNewConversationId ??
		newHomeConversationId(randomUuid)
	);
}

/** Pure draft restore — storage failures (private mode, quota) read as "". */
export function restoreChatDraft(
	storage: Pick<Storage, "getItem">,
	conversationId: string | null,
): string {
	try {
		return storage.getItem(chatDraftKey(conversationId)) ?? "";
	} catch {
		return "";
	}
}

/**
 * The idempotency key is the run id server-side, so a retry of a failed send
 * must reuse the key verbatim; only a brand-new send mints one. The key is
 * held until the send succeeds — errors keep it for the retry path.
 */
export function nextIdempotencyKey(
	current: string | null,
	generate: () => string = () => crypto.randomUUID(),
): string {
	return current ?? generate();
}

/**
 * Bounded tail for reload-mid-run hydration: `readRunEvents({ tail })` returns
 * at most this many recent events per active run. 200 comfortably covers the
 * delta chunks + tool frames of an in-flight turn without unbounded replay —
 * anything older is durable transcript territory owned by `readMessages`.
 */
export const HYDRATE_RUN_EVENTS_TAIL = 200;

/**
 * Hydrate-once guard: grants hydration for a run id exactly once per guard
 * set (the set is recreated on conversation switch, which re-arms every run).
 * Mutates `hydrated` on a grant so concurrent effect re-runs cannot double
 * fetch the same run.
 */
export function shouldHydrateRun(
	hydrated: Set<string>,
	runId: string,
): boolean {
	if (hydrated.has(runId)) return false;
	hydrated.add(runId);
	return true;
}

/**
 * Id-keyed append of hydrated run events: re-delivery (overlapping tails, an
 * effect racing a conversation refetch) never duplicates an event. Returns
 * `previous` unchanged (same reference) when nothing new arrived so React
 * state updates can bail out.
 */
export function appendHydrateEvents(
	previous: RuntimeStreamEvent[],
	incoming: readonly RuntimeStreamEvent[],
): RuntimeStreamEvent[] {
	const seen = new Set(previous.map((event) => event.id));
	const fresh = incoming.filter((event) => {
		if (seen.has(event.id)) return false;
		seen.add(event.id);
		return true;
	});
	return fresh.length === 0 ? previous : [...previous, ...fresh];
}

function invalidateHomeTranscript(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	conversationId: string,
): void {
	queryClient.invalidateQueries({
		queryKey: homeMessagesQueryKey(conversationId),
	});
}

/**
 * Focus-convergence handler (pure seam): a returning tab invalidates the run
 * set and the newest transcript slice so multi-tab edits converge — the
 * queries are id-keyed idempotent caches, so re-delivery is a no-op. Chosen
 * over `refetchOnWindowFocus: "always"` because invalidation reuses the exact
 * refresh path the realtime durable-event tap already drives (one convergence
 * mechanism, not two) and stays scoped to this surface instead of changing
 * the query options wherever the hooks are reused.
 */
export function invalidateOnFocus(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	conversationId: string | null,
): void {
	if (conversationId === null) return;
	queryClient.invalidateQueries({
		queryKey: homeRunSetQueryKey(conversationId),
	});
	invalidateHomeTranscript(queryClient, conversationId);
}

/**
 * A pending approval needs one canonical re-read whenever its stream becomes
 * usable. That includes `idle` -> `open` when the shared stream was already
 * established before this conversation mounted: React Query may have retained
 * a run set from an earlier visit, and the approval may have been resolved
 * externally while that cached query was inactive.
 */
export function shouldReconcileApprovalsOnStreamOpen(
	previous: ConversationStreamStatus,
	next: ConversationStreamStatus,
): boolean {
	return next === "open" && previous !== "open";
}

/** A card the operator is still being asked to decide — expiry is terminal. */
export function isUnresolvedApprovalCard(card: ApprovalCardData): boolean {
	return card.expired !== true;
}

/**
 * Reconnect reconciliation. The durable event stream is live-only for state
 * the client did not fold itself: an approval resolved by another tab, the
 * CLI, or an approval rule while this connection was down publishes exactly
 * one `approval.resolved`, and a card that missed it renders "pending"
 * forever between canonical reconciliation ticks. An ordinary reconnect also
 * refreshes immediately instead of waiting for that backstop, querying current
 * state after the subscription reconnects.
 *
 * Bounded on purpose. It refetches the one run set — the batched join that
 * already carries the authoritative state of every card on screen
 * (`approvalsFromRunSet`) — and never the transcript, per-card reads, or run
 * event history. It is skipped entirely when nothing is pending, so a
 * reconnect on a quiet conversation costs no read at all.
 */
export function reconcileApprovalsAfterReconnect(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	conversationId: string | null,
	approvals: readonly ApprovalCardData[],
): boolean {
	if (conversationId === null) return false;
	if (!approvals.some(isUnresolvedApprovalCard)) return false;
	queryClient.invalidateQueries({
		queryKey: homeRunSetQueryKey(conversationId),
	});
	return true;
}

const ROLE_ORDER_RANK: Record<HomeMessage["role"], number> = {
	// Same-instant tie-break: a run's `<runId>:input` row sorts before its
	// `<runId>:assistant` row even when they share a createdAt.
	system: 0,
	user: 1,
	tool: 2,
	runtime: 3,
	assistant: 4,
};

export function compareHomeMessages(a: HomeMessage, b: HomeMessage): number {
	const at = Date.parse(a.createdAt);
	const bt = Date.parse(b.createdAt);
	if (at !== bt) return at - bt;
	const rank = ROLE_ORDER_RANK[a.role] - ROLE_ORDER_RANK[b.role];
	if (rank !== 0) return rank;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Idempotent transcript merge: the cache is keyed by message id, so
 * re-delivery of a message (poll overlap, page overlap, enqueue echo followed
 * by the durable row) is a plain overwrite — never a duplicate bubble.
 * Returns the full cache as an oldest-first ordered array.
 */
export function mergeHomeMessages(
	cache: Map<string, HomeMessage>,
	incoming: readonly HomeMessage[],
): HomeMessage[] {
	for (const message of incoming) cache.set(message.id, message);
	return [...cache.values()].sort(compareHomeMessages);
}

/**
 * A delegated run can settle before its deterministic async-completion message
 * is visible in the transcript. The run projection already carries the exact
 * terminal child preview, so use it to prevent a false "no written response"
 * bubble while the durable message is repaired server-side.
 */
export function applyDelegatedRunPreviews(
	messages: readonly HomeMessage[],
	runs: readonly HomeRun[],
): HomeMessage[] {
	const completedDelegations = new Set(
		messages.flatMap((message) =>
			message.role === "assistant" &&
			message.runId &&
			message.id === `${message.runId}:async-completion:assistant` &&
			message.content.trim()
				? [message.runId]
				: [],
		),
	);
	const runsWithCanonicalAnswer = new Set(
		messages.flatMap((message) =>
			message.role === "assistant" && message.content.trim() && message.runId
				? [message.runId]
				: [],
		),
	);
	const previews = new Map<string, string>();
	const activeRuns = new Set<string>();
	for (const run of runs) {
		if (!run.id) continue;
		if (ACTIVE_RUN_STATUSES.has(run.status)) {
			activeRuns.add(run.id);
			continue;
		}
		const metadata = recordOrNull(run.metadata);
		const preview = metadata?.childRunPreview;
		if (typeof preview === "string" && preview.trim()) {
			previews.set(run.id, preview);
		}
	}
	return messages.flatMap((message) => {
		const metadata = recordOrNull(recordOrNull(message.metadata)?.metadata);
		const workOrder = recordOrNull(metadata?.delegationWorkOrder);
		// A plain dispatch receipt is superseded by its durable child outcome.
		// Preserve proposals, failures, attachments, and structured results.
		if (
			message.role === "assistant" &&
			message.runId &&
			message.id === `${message.runId}:assistant` &&
			message.childRunId &&
			completedDelegations.has(message.runId) &&
			metadata?.homeSubject === true &&
			!metadata.homePlan &&
			(!workOrder ||
				(workOrder.kind === "tedi.delegate" &&
					workOrder.status !== "requires_approval" &&
					!metadata.approvalRequestId)) &&
			!metadata.delegationError &&
			!message.attachments?.length &&
			chatWidgetTargetsFromMetadata(message.metadata).length === 0 &&
			directReadResult(message) === null &&
			!directReadError(message)
		)
			return [];
		if (
			message.role === "assistant" &&
			!message.content.trim() &&
			message.runId &&
			message.id === `${message.runId}:assistant` &&
			runsWithCanonicalAnswer.has(message.runId)
		) {
			return [];
		}
		if (
			message.role !== "assistant" ||
			message.content.trim() ||
			!message.runId
		)
			return [message];
		// The dispatch acknowledgement can be completed while its child is
		// still running. The canonical run, not that row, owns turn completion.
		if (activeRuns.has(message.runId)) {
			return [{ ...message, status: "streaming" }];
		}
		const preview = previews.get(message.runId);
		return [preview ? { ...message, content: preview } : message];
	});
}

/**
 * The enqueue response does not echo the persisted user message row, but its
 * identity is deterministic (`<runId>:input`), so the transcript renders it
 * straight from the response — when `readMessages` later returns the durable
 * row, the id-keyed cache overwrites this one silently.
 *
 * `status` is derived, not asserted. `normalizeHomeMessage` returns "pending"
 * for a user row whose run is still active and "completed" once it is terminal
 * (`policy-normalization.ts`), so hardcoding "completed" made the bubble flip
 * completed → pending → completed on the first refetch. Mirroring the read's
 * own rule from `run.status` makes the echo converge instead of contradict.
 */
export function userMessageFromEnqueue(
	output: EnqueueHomeMessageOutput,
	content: string,
): HomeMessage {
	return {
		id: provisionalSendMessageId(output.idempotencyKey),
		organizationId: output.run.organizationId,
		conversationId: output.conversationId,
		runId: output.run.id,
		role: "user",
		status: ACTIVE_RUN_STATUSES.has(output.run.status)
			? "pending"
			: "completed",
		content,
		createdAt: output.run.createdAt,
	};
}

/** One execution action per run, on its latest visible message. */
export function executionLinkMessageIds(
	messages: readonly HomeMessage[],
): Set<string> {
	const latest = new Map<string, string>();
	for (const message of messages) {
		if (message.runId) latest.set(message.runId, message.id);
	}
	return new Set(latest.values());
}

function directReadResult(message: HomeMessage): unknown | null {
	const metadata = message.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		return null;
	const envelope = metadata as Record<string, unknown>;
	if (envelope.directReadResult !== undefined) return envelope.directReadResult;
	const nested = envelope.metadata;
	if (!nested || typeof nested !== "object" || Array.isArray(nested))
		return null;
	return (nested as Record<string, unknown>).directReadResult ?? null;
}

export function directReadError(message: HomeMessage): {
	kind: string;
	retryable: boolean;
	connectProviderId: string | null;
} | null {
	const metadata = message.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
		return null;
	const envelope = metadata as Record<string, unknown>;
	const nested = envelope.metadata;
	const candidate =
		envelope.directReadError ??
		(nested && typeof nested === "object" && !Array.isArray(nested)
			? (nested as Record<string, unknown>).directReadError
			: undefined);
	if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
		return null;
	const value = candidate as Record<string, unknown>;
	if (typeof value.kind !== "string") return null;
	return {
		kind: value.kind,
		retryable: value.retryable === true,
		connectProviderId:
			typeof value.connectProviderId === "string"
				? value.connectProviderId
				: null,
	};
}

/**
 * Renders a direct-read tool result. Every string here is tool-authored — the
 * object keys as much as the values — so each goes through
 * `sanitizeUntrustedText` at the render site, per the rule in
 * `@/lib/untrusted-text`: a sanitizer a component has to remember to call is
 * one that eventually gets skipped, and this component was the proof.
 *
 * React already escapes markup on this path, so the residual risk is the
 * invisible characters — a U+202E dropped into a key or value reorders the
 * operator's own reading flow without changing the string.
 *
 * Exported for the hostile-string test.
 */
export function StructuredReadResult({ value }: { value: unknown }) {
	if (Array.isArray(value)) {
		return (
			<div className="grid gap-2">
				{value.slice(0, 20).map((item, index) => (
					<Surface key={index} className="p-2">
						<StructuredReadResult value={item} />
					</Surface>
				))}
			</div>
		);
	}
	if (value && typeof value === "object") {
		return (
			<dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(8rem,auto)_1fr]">
				{Object.entries(value as Record<string, unknown>)
					.slice(0, 40)
					.map(([key, item]) => (
						<Fragment key={key}>
							<Text as="dt" role="label" tone="secondary" weight="medium">
								{sanitizeUntrustedText(key)}
							</Text>
							<Text as="dd" role="body" className="m-0 min-w-0 break-words">
								{item && typeof item === "object" ? (
									<StructuredReadResult value={item} />
								) : (
									sanitizeUntrustedText(String(item ?? "—"))
								)}
							</Text>
						</Fragment>
					))}
			</dl>
		);
	}
	return <span>{sanitizeUntrustedText(String(value ?? "—"))}</span>;
}

// ---------------------------------------------------------------------------
// Pure presentational subcomponents (exported for tests)
// ---------------------------------------------------------------------------

/**
 * One transcript entry. Per the design brief the two roles get asymmetric
 * treatments: user turns are right-aligned bubbles (one grey step below the
 * canvas, 24px radius with a squared bottom-right corner, capped at
 * min(680px, 78%)); assistant turns are no bubble — plain text directly on
 * the canvas at full column width.
 */
export function ChatMessageBubble({
	message,
	showExecutionLink = true,
	context,
	workspaceId,
	LinkComponent,
}: {
	message: HomeMessage;
	showExecutionLink?: boolean;
	context?: ChatContext;
	workspaceId?: string;
	LinkComponent?: ComponentType<CardRunLinkProps>;
}) {
	const isUser = message.role === "user";
	const decoded = decodeChatContext(message.content);
	const structuredResult = directReadResult(message);
	const readFailure = directReadError(message);
	const emptyLabel = emptyMessageLabel(message);
	return (
		<li
			data-role={message.role}
			className={cn(
				"group/message flex w-full min-w-0 max-w-full",
				isUser ? "justify-end" : "justify-start",
			)}
		>
			<div
				className={cn(
					"flex min-w-0 flex-col gap-1",
					isUser
						? "max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg bg-kumo-fill px-4 py-2.5"
						: "max-w-full py-0.5",
				)}
			>
				{decoded.context &&
				!(
					(decoded.context.kind === "workspace" &&
						decoded.context.id === workspaceId) ||
					(decoded.context.kind === context?.kind &&
						decoded.context.id === context.id)
				) ? (
					<Badge variant="outline" className="w-fit gap-1.5">
						<FolderSimple size={13} aria-hidden />
						{decoded.context.kind}: {decoded.context.label}
					</Badge>
				) : null}
				{decoded.content ? (
					<ChatMarkdown content={decoded.content} preserveLineBreaks={isUser} />
				) : (
					<Text role="label" tone="secondary" className="m-0">
						{emptyLabel}
					</Text>
				)}
				{structuredResult !== null ? (
					<Surface className="mt-2 p-3">
						<StructuredReadResult value={structuredResult} />
					</Surface>
				) : null}
				{readFailure ? (
					<Alert variant="destructive" className="mt-2">
						<AlertTitle>
							{readFailure.kind === "connection_required"
								? "Connection required"
								: "Connected app read failed"}
						</AlertTitle>
						<AlertDescription>
							{readFailure.retryable
								? "This failure is safe to retry with the same request."
								: "Review the connection or tool policy before trying again."}
						</AlertDescription>
						{readFailure.connectProviderId ? (
							<AlertAction>
								<Button
									size="sm"
									variant="outline"
									render={
										<Link
											to="/admin/connections"
											search={{
												q: "",
												status: "used",
												connect: readFailure.connectProviderId,
											}}
										/>
									}
								>
									Connect app
								</Button>
							</AlertAction>
						) : null}
					</Alert>
				) : null}
				<Text
					as="span"
					role="label"
					tone="secondary"
					className={cn(
						"flex flex-wrap items-center gap-2 tabular-nums",
						isUser && "justify-end",
					)}
				>
					<time
						dateTime={message.createdAt}
						title={absoluteTime(message.createdAt)}
					>
						{relativeTime(message.createdAt)}
					</time>
					{message.status === "failed" ? (
						<span className="text-kumo-danger">failed</span>
					) : null}
					{message.status === "canceled" ? <span>canceled</span> : null}
					{message.runId && showExecutionLink ? (
						<ExecutionLinkChip
							runId={message.runId}
							label="Details"
							appearance="inline"
							LinkComponent={LinkComponent}
						/>
					) : null}
					{/*
					 * Per-turn copy, on assistant turns only — a user turn is already in
					 * the operator's hands. Built on the ClipboardText adapter rather
					 * than a local `navigator.clipboard` button so it shares the one
					 * confirmation animation, the one polite live-region announcement,
					 * and the one accessible label set with every other copy in Console.
					 * Revealed on hover to keep the transcript quiet, and on
					 * `focus-within` so it is reachable by keyboard — the control is
					 * always in the tab order, only its opacity changes.
					 */}
					{!isUser && decoded.content ? (
						<ClipboardText
							size="sm"
							text="Copy response"
							textToCopy={decoded.content}
							labels={{ copyAction: "Copy this response to the clipboard" }}
							className="w-fit opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 motion-reduce:transition-none"
						/>
					) : null}
				</Text>
			</div>
		</li>
	);
}

/**
 * Truthful fallback for durable rows whose useful payload is not prose. The
 * row remains visible because its timestamp and execution link are canonical;
 * only the implementation-residue `(no text)` label is replaced.
 */
export function emptyMessageLabel(message: HomeMessage): string {
	const attachmentCount = message.attachments?.length ?? 0;
	if (attachmentCount > 0) {
		return `${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`;
	}
	if (chatWidgetTargetsFromMetadata(message.metadata).length > 0) {
		return "Interactive result attached";
	}
	if (directReadResult(message) !== null)
		return "Connected app result attached";
	if (directReadError(message)) return "Connected app read failed";
	if (message.role === "user") return "Message sent without text";
	if (message.role === "tool") return "Tool result recorded";
	if (message.role === "runtime") return "Execution update recorded";
	if (message.role === "system") return "System context recorded";
	if (message.status === "failed") {
		return "Response failed before text was produced";
	}
	if (message.status === "canceled") {
		return "Response canceled before text was produced";
	}
	if (message.status === "pending" || message.status === "streaming") {
		return "Response is still being prepared";
	}
	return message.runId
		? "Execution completed without a written response"
		: "No written response";
}

/** MCP Apps returned with a durable assistant turn, rendered in Kumo chat chrome. */
export function ChatMessageWidgets({
	message,
	onFollowUp,
}: {
	message: HomeMessage;
	onFollowUp?: (message: string) => void;
}) {
	if (message.role !== "assistant") return null;
	const targets = chatWidgetTargetsFromMetadata(message.metadata);
	if (targets.length === 0) return null;

	return (
		<>
			{targets.map((target) => (
				<li
					key={target.resourceUri}
					data-slot="mcp-app-widget"
					className="flex min-w-0 max-w-full justify-start overflow-hidden"
				>
					<div className="min-w-0 max-w-full flex-1 overflow-hidden">
						<WidgetFrame
							appSlug={target.appSlug}
							resourceUri={target.resourceUri}
							title={`${target.appSlug} app`}
							toolInput={target.toolInput}
							toolResult={target.toolResult}
							onFollowUp={onFollowUp}
						/>
					</div>
				</li>
			))}
		</>
	);
}

/** Native continuation controls for promoting one answer through Tedix-owned surfaces. */
export function ChatResponseActions({
	onChoose,
}: {
	onChoose: (action: ChatResponseAction) => void;
}) {
	return (
		<li
			data-slot="chat-response-actions"
			className="flex min-w-0 flex-wrap items-center gap-1.5"
		>
			<Text as="span" role="label" tone="secondary" className="mr-1">
				Continue with
			</Text>
			{CHAT_RESPONSE_ACTIONS.map((item) => (
				<Button
					key={item.action}
					type="button"
					size="xs"
					variant="outline"
					title={item.description}
					onClick={() => onChoose(item.action)}
				>
					{item.label}
				</Button>
			))}
		</li>
	);
}

/**
 * Keep the detached-scroll affordance in its own row between the scrollport
 * and composer so it cannot cover cards while the user reads the thread.
 */
export function JumpToLatestControl({
	visible,
	onJump,
}: {
	visible: boolean;
	onJump: () => void;
}) {
	if (!visible) return null;

	return (
		<div
			data-slot="jump-to-latest-control"
			className="pointer-events-none flex shrink-0 justify-center py-1"
		>
			<Button
				aria-label="Jump to latest"
				size="icon-sm"
				variant="outline"
				className="pointer-events-auto !rounded-full bg-kumo-base shadow-tedix-floating"
				icon={<ArrowDown aria-hidden="true" size={16} />}
				onClick={onJump}
			/>
		</div>
	);
}

function ChatStarterPrompts({
	onChoose,
}: {
	onChoose: (prompt: string) => void;
}) {
	return (
		<div className="chat-starter-prompts mt-5 grid w-full gap-2">
			{CHAT_STARTER_PROMPTS.map((prompt) => (
				<Button
					key={prompt}
					type="button"
					size="sm"
					variant="outline"
					multiline
					className="w-full justify-start whitespace-normal px-3 py-2 text-left"
					onClick={() => onChoose(prompt)}
				>
					{prompt}
				</Button>
			))}
		</div>
	);
}

/**
 * The provisional user turn: the operator's own message, rendered the instant
 * Send is pressed and retired the moment its durable row lands.
 *
 * It is visibly provisional, never dressed as durable. The bubble is muted and
 * dashed, carries `aria-busy` while the call is in flight, and states its own
 * status in an `aria-live` region — "Sending…" claims nothing about the server,
 * and "Delivery unconfirmed" is neither a success nor a failure, which is the
 * only honest reading of a transport that died mid-send.
 *
 * There is no timestamp: the durable row owns `createdAt`, and printing a
 * client clock beside it would render a time the transcript does not agree
 * with the moment the row arrives.
 */
export function ProvisionalUserBubble({ send }: { send: ProvisionalSend }) {
	const pending = send.state === "sending";
	return (
		<li
			data-slot="provisional-user-message"
			data-provisional-state={send.state}
			data-provisional-key={send.idempotencyKey}
			aria-busy={pending || undefined}
			className="flex w-full min-w-0 max-w-full justify-end"
		>
			<div className="flex min-w-0 max-w-[min(680px,78%)] flex-col gap-1 rounded-[24px] rounded-br-lg border border-kumo-hairline border-dashed bg-kumo-tint px-4 py-2.5">
				<Text
					role="body"
					tone="secondary"
					className="m-0 whitespace-pre-wrap break-words tracking-[-0.25px]"
				>
					{decodeChatContext(send.content).content}
				</Text>
				<span
					className="flex items-center justify-end gap-1.5 text-kumo-subtle text-xs"
					// Polite, not assertive: the send status is progress information,
					// and an assertive region would interrupt the transcript log the
					// operator is already reading.
					aria-live="polite"
					role="status"
				>
					{/* Decorative: this span is already the live region. */}
					{pending ? (
						<span aria-hidden="true" className="flex items-center">
							<Loader aria-label="Sending" size={12} />
						</span>
					) : null}
					{PROVISIONAL_SEND_LABEL[send.state]}
					{send.attempts > 1 ? ` · attempt ${send.attempts}` : ""}
				</span>
			</div>
		</li>
	);
}

export function RunningIndicator({ label }: { label?: string | null }) {
	return (
		<li
			className="flex w-full justify-start"
			data-slot="running-indicator"
			aria-live="polite"
		>
			<div className="flex items-center gap-2 py-1 text-kumo-subtle type-tedix-body">
				{/* Decorative: the <li> above is already the live region. */}
				<span aria-hidden="true" className="flex items-center">
					<Loader aria-label="Working" size={16} />
				</span>
				<span>{label || "Working on it…"}</span>
			</div>
		</li>
	);
}

export function SendFailureBanner({
	outcomeUnknown,
	draftHeld = false,
	message,
	retrying = false,
	onRetry,
}: {
	message: string;
	retrying?: boolean;
	onRetry?: () => void;
	/**
	 * The transport died with the send in flight, so whether the server
	 * accepted it is genuinely unknown. Titling that "Message not sent" states
	 * the failure case as fact — and the body text immediately contradicts it.
	 */
	outcomeUnknown?: boolean;
	/**
	 * The message is held in the unconfirmed bubble above rather than back in
	 * the composer. Saying "your draft is intact" while the textarea is empty
	 * points the operator at the wrong place to look for it.
	 */
	draftHeld?: boolean;
}) {
	return (
		<Alert variant="destructive">
			<AlertTitle>
				{outcomeUnknown ? "Message may not have been sent" : "Message not sent"}
			</AlertTitle>
			<AlertDescription>
				{message}{" "}
				{draftHeld
					? "It is shown above as unconfirmed — Retry re-sends it exactly once."
					: outcomeUnknown
						? // Neither claim is safe here: the message may already be
							// durable (so it is not a lost draft), and the composer may
							// be empty (so promising an intact draft points at nothing).
							"Reload to see whether it was recorded before sending it again."
						: "Your draft is intact — Retry re-sends it exactly once."}
			</AlertDescription>
			<AlertAction className="p-2">
				<Button
					size="sm"
					variant="outline"
					icon={<ArrowCounterClockwise size={14} />}
					disabled={retrying}
					onClick={() => onRetry?.()}
				>
					Retry
				</Button>
			</AlertAction>
		</Alert>
	);
}

/** Replaces—not merely disables—the composer while authority is unresolved. */
export function ApprovalInputGate({ count }: { count: number }) {
	return (
		<div
			data-slot="chat-approval-gate"
			role="status"
			className="mx-auto flex w-full max-w-[920px] items-center justify-between gap-3 rounded-2xl border border-kumo-warning bg-kumo-warning-tint px-4 py-3"
		>
			<span className="min-w-0">
				<Text as="strong" role="body" tone="strong" className="block">
					Approval required before the conversation can continue
				</Text>
				<Text as="span" role="label" tone="secondary" className="block">
					Approve or reject the pending delegation above. Sending a new message
					is paused so it cannot be mistaken for that decision.
				</Text>
			</span>
			<Badge variant="outline" className="shrink-0">
				{count} pending
			</Badge>
		</div>
	);
}

/** A live operator decision gates the composer and session auto-approval. */
export function isBlockingApprovalCard(card: ApprovalCardData): boolean {
	return (
		card.expired !== true &&
		(card.decisionMode ?? "approve_or_reject") === "approve_or_reject"
	);
}

/** Selects one exact-scope approval for the in-memory session allowance. */
export function nextSessionAutoApproval(
	cards: readonly ApprovalCardData[],
	allowedScopes: ReadonlySet<string>,
	attemptedApprovalIds: ReadonlySet<string>,
): ApprovalCardData | null {
	return (
		cards.find(
			(card) =>
				isBlockingApprovalCard(card) &&
				card.sessionScopeKey !== undefined &&
				allowedScopes.has(card.sessionScopeKey) &&
				!attemptedApprovalIds.has(card.approvalId),
		) ?? null
	);
}

// ---------------------------------------------------------------------------
// Run-activity seam
// ---------------------------------------------------------------------------

export function runSetPollInterval(input: {
	active: boolean;
	forceActive: boolean;
	realtimeDegraded: boolean;
}): number | false {
	return canonicalProjectionInterval({
		active: input.active,
		urgent: input.forceActive || (input.active && input.realtimeDegraded),
		activeMs:
			input.forceActive || input.realtimeDegraded
				? RUN_POLL_INTERVAL_MS
				: RUN_SET_RECONCILE_INTERVAL_MS,
		idleMs: IDLE_PROJECTION_RECONCILE_MS,
	});
}

export function shouldPollTranscript(input: {
	isActive: boolean;
	pendingRun: boolean;
	realtimeDegraded: boolean;
}): boolean {
	return input.isActive && (input.pendingRun || input.realtimeDegraded);
}

/**
 * The in-flight AFFORDANCE. While work is running the thread must show either
 * streamed assistant text or the running indicator — never nothing. Exported
 * (rather than left inline in the JSX) because the condition is exactly what
 * broke during a delegation: the dispatch ack's overlay was immortal (its
 * durable row is dropped by the server's narration collapse, so the
 * swap-on-durable rule never fired — see `overlay-state.ts`), and a nonzero
 * overlay count suppressed the indicator for the whole minutes-long gap
 * between the ack and the delegated result. The overlay
 * fix is what makes this term honest; the rule itself is unchanged.
 */
export function shouldShowRunningIndicator(input: {
	showRunning: boolean;
	overlayCount: number;
}): boolean {
	return input.showRunning && input.overlayCount === 0;
}

export function useIsRunActive(
	conversationId: string | null,
	forceActive = false,
	realtimeDegraded = false,
): {
	isActive: boolean;
	activeRunIds: string[];
	runSet: HomeRunSet | undefined;
} {
	const query = useQuery({
		...homeRunSetQueryOptions(conversationId ?? ""),
		enabled: conversationId !== null,
		refetchInterval: (current) => {
			const active = (current.state.data?.runSet.activeRunIds.length ?? 0) > 0;
			return runSetPollInterval({ active, forceActive, realtimeDegraded });
		},
	});
	const activeRunIds = query.data?.runSet.activeRunIds ?? [];
	return {
		isActive: forceActive || activeRunIds.length > 0,
		activeRunIds,
		runSet: query.data?.runSet,
	};
}

/**
 * Conversation cost, from usage the run set already carries — no extra read.
 *
 * It measures the kernel route-planner call on each turn and nothing else:
 * `HomeRun.usage.costUsd` is `computeCost(...)` over the planner's tokens
 * (`apps/api/src/rpc/routers/kernel/turn-work.ts`), and the tool/body work of a
 * turn is attributed on the call ledger instead. So the chip names what it
 * measured rather than implying the conversation's total, and a run whose usage
 * was omitted makes the number a floor rather than silently shrinking it.
 */
export function ConversationCostChip({ runs }: { runs: readonly HomeRun[] }) {
	const usages = runs
		.map((run) => run.usage)
		.filter((usage): usage is NonNullable<HomeRun["usage"]> => Boolean(usage));
	return (
		<CostChip
			reading={kernelUsageReading(usages)}
			subject={
				isLocalWorkersAi()
					? "Planning estimate; inference is billed to your Cloudflare account"
					: "Planning cost for this conversation, on platform-included credits"
			}
		/>
	);
}

export type ContextUsedItem = { label: string; value: string };

function recordOrNull(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Secret-free provenance projected from the latest canonical run. This is an
 * allowlist, never a metadata dump: credential-shaped and unknown keys cannot
 * enter the UI.
 */
export function contextUsedItems(
	runs: readonly HomeRun[],
	input: { workspaceId?: string; context?: ChatContext } = {},
): ContextUsedItem[] {
	const latest = [...runs].sort(
		(a, b) =>
			Date.parse(b.updatedAt ?? b.createdAt) -
			Date.parse(a.updatedAt ?? a.createdAt),
	)[0];
	if (!latest) return [];
	const metadata = recordOrNull(latest.metadata);
	const workspace = recordOrNull(metadata?.workspaceContext);
	const workpiece = recordOrNull(workspace?.workpiece);
	const route = recordOrNull(metadata?.kernelRoute);
	const manifest = recordOrNull(metadata?.contextManifest);
	const manifestSources = Array.isArray(manifest?.sources)
		? manifest.sources
				.map(recordOrNull)
				.filter((source): source is Record<string, unknown> => source !== null)
				.map((source) => {
					const name = nonEmptyString(source.name);
					const count = typeof source.count === "number" ? source.count : null;
					return name && count !== null ? `${name}: ${count}` : null;
				})
				.filter((source): source is string => source !== null)
		: [];
	const historyCompaction = recordOrNull(manifest?.historyCompaction);
	const modelRef =
		nonEmptyString(metadata?.modelRef) ?? nonEmptyString(route?.modelRef);
	const workspaceIdFromRun = nonEmptyString(workspace?.workspaceId);
	const workspaceName = nonEmptyString(workspace?.workspaceName);
	const workspaceLabel =
		workspaceName ??
		(input.context?.kind === "workspace" ? input.context.label : null) ??
		input.workspaceId ??
		workspaceIdFromRun;
	const items: Array<ContextUsedItem | null> = [
		{ label: "Organization", value: latest.organizationId },
		workspaceLabel ? { label: "Workspace", value: workspaceLabel } : null,
		input.context && input.context.kind !== "workspace"
			? { label: "Workpiece", value: input.context.label }
			: nonEmptyString(workpiece?.id)
				? {
						label: "Workpiece",
						value: `${nonEmptyString(workpiece?.kind) ?? "resource"}: ${nonEmptyString(workpiece?.id)}`,
					}
				: null,
		modelRef ? { label: "Model", value: modelRef } : null,
		nonEmptyString(route?.routeKind)
			? { label: "Route", value: nonEmptyString(route?.routeKind)! }
			: null,
		nonEmptyString(metadata?.routerVersion)
			? {
					label: "Router version",
					value: nonEmptyString(metadata?.routerVersion)!,
				}
			: null,
		latest.delegatedTediId
			? { label: "Delegated tedi", value: latest.delegatedTediId }
			: null,
		manifestSources.length
			? { label: "Context sources", value: manifestSources.join(" → ") }
			: null,
		typeof manifest?.inputTokens === "number"
			? { label: "Model input", value: `${manifest.inputTokens} tokens` }
			: null,
		typeof latest.usage?.reasoningTokens === "number"
			? {
					label: "Reasoning usage",
					value: `${latest.usage.reasoningTokens} tokens`,
				}
			: null,
		typeof manifest?.budgetTokens === "number"
			? { label: "Context budget", value: `${manifest.budgetTokens} tokens` }
			: null,
		historyCompaction
			? {
					label: "History compaction",
					value: `${historyCompaction.compactedMessages ?? 0} messages compacted; ${historyCompaction.retainedMessages ?? 0} retained (${historyCompaction.source ?? "unknown"})`,
				}
			: { label: "History compaction", value: "Not applied" },
		nonEmptyString(metadata?.workItemId)
			? { label: "Work Item", value: nonEmptyString(metadata?.workItemId)! }
			: null,
	];
	return items.filter((item): item is ContextUsedItem => item !== null);
}

function ContextUsedInspector({
	runs,
	workspaceId,
	context,
}: {
	runs: readonly HomeRun[];
	workspaceId?: string;
	context?: ChatContext;
}) {
	const [open, setOpen] = useState(false);
	const items = useMemo(
		() => contextUsedItems(runs, { workspaceId, context }),
		[runs, workspaceId, context],
	);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Button
				size="sm"
				variant="outline"
				icon={<Info size={14} />}
				disabled={items.length === 0}
				onClick={() => setOpen(true)}
			>
				Context used
			</Button>
			<DialogContent size="base">
				<DialogHeader>
					<DialogTitle>Context used</DialogTitle>
					<DialogDescription>
						Canonical, secret-free context recorded for the latest Kernel run.
					</DialogDescription>
				</DialogHeader>
				<dl className="grid gap-3">
					{items.map((item) => (
						<div key={item.label} className="grid gap-0.5">
							<Text as="dt" role="label" tone="secondary">
								{item.label}
							</Text>
							<Text as="dd" role="body" className="m-0 break-all">
								{item.value}
							</Text>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// ChatThread
// ---------------------------------------------------------------------------

export function ChatThread({
	conversationId,
	onConversationCreated,
	onSendStarted,
	onConversationPrepared,
	prepareNewConversation,
	context,
	workspaceId,
	composerOnly = false,
	autoFocusComposer = false,
	onSendMessageReady,
}: {
	/** `null` = fresh conversation not yet created; the first send creates it. */
	conversationId: string | null;
	/** Reveal the transcript without replacing this thread's pending send state. */
	onSendStarted?: () => void;
	onConversationCreated?: (
		conversationId: string,
		workspaceId?: string,
	) => void;
	onConversationPrepared?: (
		conversationId: string,
		workspaceId: string,
	) => void;
	/**
	 * General Chat uses this hook to make a durable Workspace at the first
	 * substantive send. Workspace chat omits it because its host already exists.
	 */
	prepareNewConversation?: (
		content: string,
	) => Promise<{ workspaceId: string }>;
	context?: ChatContext;
	/** Canonical host Workspace; required for durable Workspace conversation association. */
	workspaceId?: string;
	/**
	 * Render only the composer beneath the conversation list. The first send
	 * creates the conversation through the same path as the full thread.
	 */
	composerOnly?: boolean;
	/**
	 * Focus the composer when the thread mounts or changes conversation. The
	 * Workspace's chat-first layout sets it so the first-send navigation from
	 * `/chat` (a new route tree, so a new composer) lands with the caret where
	 * the user just was.
	 */
	autoFocusComposer?: boolean;
	/** Lets an adjacent user-facing control enqueue a message through this chat. */
	onSendMessageReady?: (send: (content: string) => void) => void;
}) {
	const queryClient = useQueryClient();
	const tediNames = useTediNames();
	const localAiUnavailable = isLocalAiUnavailable();
	const localWorkersAi = isLocalWorkersAi();

	// Idempotent message cache: keyed by message id, merged into ordered state.
	const cacheRef = useRef(new Map<string, HomeMessage>());
	// Which conversation the cache currently belongs to. Pre-set to the enqueue
	// echo when a fresh conversation is created so the prop flip keeps the cache.
	const cacheConversationRef = useRef<string | null>(conversationId);
	// A New thread has no route id until its first turn succeeds. Hold the id
	// across retries so failed first turns cannot create multiple conversations.
	const newConversationIdRef = useRef<string | null>(null);
	const newWorkspaceIdRef = useRef<string | null>(null);
	const preparingConversationRef = useRef(false);
	const [preparingConversation, setPreparingConversation] = useState(false);
	const [messages, setMessages] = useState<HomeMessage[]>([]);
	const [olderCursor, setOlderCursor] = useState<string | null>(null);
	const cursorInitializedRef = useRef(false);
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const [loadEarlierError, setLoadEarlierError] = useState<string | null>(null);

	const [pendingRunId, setPendingRunId] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [sendError, setSendError] = useState<string | null>(null);
	const [sendErrorUnknown, setSendErrorUnknown] = useState(false);
	// Held until the send settles successfully; a retry reuses the same key.
	const idempotencyKeyRef = useRef<string | null>(null);
	const directReadRetryRef = useRef<DirectReadRequest | null>(null);

	// The provisional user-turn plane. Ephemeral by construction (plain React
	// state, wiped on conversation switch and gone on reload), keyed by the
	// idempotency key so a same-key retry lands on the same entry and the
	// durable row's arrival retires exactly one overlay. See `provisional-send.ts`.
	const [provisional, setProvisional] = useState<ProvisionalSendMap>(() =>
		takeCarriedProvisionalFirstTurn(conversationId),
	);
	const dispatchProvisional = useCallback((action: ProvisionalSendAction) => {
		setProvisional((current) => reduceProvisionalSends(current, action));
	}, []);

	const [draft, setDraft] = useState(() =>
		restoreChatDraft(window.localStorage, conversationId),
	);
	const [includeContext, setIncludeContext] = useState(Boolean(context));
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
	const [preparingAttachments, setPreparingAttachments] = useState(false);
	const attachmentPickGeneration = useRef(0);
	const attachmentPreparationRef = useRef(false);
	const attachmentDragDepth = useRef(0);
	const [attachmentDragActive, setAttachmentDragActive] = useState(false);
	// Why the last pick refused an image, if it did. Cleared by the next pick,
	// by a model change, and on conversation switch.
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [directReadOpen, setDirectReadOpen] = useState(false);
	// Session approvals are memory-only, scoped to one exact
	// delegation target, and cleared on a full page/session reset.
	const alwaysApproveScopesRef = useRef(new Set<string>());
	const autoApprovalAttemptedRef = useRef(new Set<string>());
	const attachmentInputRef = useRef<HTMLInputElement | null>(null);
	const operationalContext = useQuery(operationalContextQueryOptions());
	const organizationId = operationalContext.data?.organization.id;
	const readOnlyCatalog = useQuery({
		...readOnlyToolCatalogQueryOptions(organizationId),
		enabled: directReadOpen,
	});
	const [selectedModelRef, setSelectedModelRef] = useState<string | null>(null);
	const modelCatalog = useQuery({
		...modelCatalogQueryOptions(),
		staleTime: 60_000,
	});
	const resolvableModels = useMemo(
		() => modelCatalog.data?.models.filter((model) => model.allowed) ?? [],
		[modelCatalog.data],
	);
	const selectableModels = useMemo(
		() => modelsForNewSelection(resolvableModels),
		[resolvableModels],
	);
	useEffect(() => {
		if (selectedModelRef || resolvableModels.length === 0) return;
		setSelectedModelRef(
			initialModelRef(resolvableModels, modelCatalog.data?.routing.modelRef),
		);
	}, [resolvableModels, modelCatalog.data, selectedModelRef]);
	const selectedModelLabel =
		resolvableModels.find((model) => model.ref === selectedModelRef)?.label ??
		selectedModelRef ??
		"The selected model";
	// Image capability gate. A MIME type says what the file is; it says nothing
	// about whether the model can read it, and the two were conflated here.
	//
	// `selectionPending` covers both halves of "not resolved YET": the query is
	// in flight, or it has landed with allowed models and the effect above has
	// not yet committed the pick. Everything else with a null ref is a resolved
	// nothing — an empty allow-list or a failed catalog — and says so.
	const modelSelectionPending =
		modelCatalog.isPending ||
		(selectedModelRef === null && resolvableModels.length > 0);
	const imageRefusal = localWorkersAi
		? "The local inference model is configured by the launcher. Its image support is not verified here; send text instead."
		: composerImageRefusal({
				models: resolvableModels,
				selectedRef: selectedModelRef,
				modelLabel: selectedModelLabel,
				selectionPending: modelSelectionPending,
			});
	// An image already attached when the operator switches to a model that
	// refuses it: the pick-time filter cannot have caught this one, so the send
	// is blocked with the same named reason rather than wedging the turn.
	const blockedByAttachedImage =
		imageRefusal !== null &&
		attachments.some((attachment) => attachment.type === "image");
	const composerAttachmentError = blockedByAttachedImage
		? imageRefusal
		: attachmentError;

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	// See `autoFocusComposer`: the caret follows the user across the first-send
	// route change from `/chat` into the Workspace.
	useEffect(() => {
		if (!autoFocusComposer) return;
		composerRef.current?.focus();
	}, [autoFocusComposer, conversationId]);
	// Distance from the bottom recorded before an older-page prepend; restored
	// in useLayoutEffect so the viewport does not jump.
	const prependAnchorRef = useRef<number | null>(null);
	const stickToBottomRef = useRef(true);
	// Mirror of stickToBottomRef that drives the "jump to latest" affordance;
	// setState with an unchanged value is a React no-op, so per-scroll updates
	// stay cheap.
	const [pinnedToBottom, setPinnedToBottom] = useState(true);

	// Reset all per-conversation state when the thread switches — unless the
	// "switch" is the prop catching up to the conversation this thread just
	// created via enqueue (cacheConversationRef was pre-set in onSuccess).
	useEffect(() => {
		if (cacheConversationRef.current === conversationId) return;
		cacheConversationRef.current = conversationId;
		// Leaving the synthetic New state starts the next New thread from a
		// distinct id. Keep it only while this same new thread is resolving.
		newConversationIdRef.current = null;
		newWorkspaceIdRef.current = null;
		cacheRef.current = new Map();
		cursorInitializedRef.current = false;
		stickToBottomRef.current = true;
		setPinnedToBottom(true);
		prependAnchorRef.current = null;
		idempotencyKeyRef.current = null;
		setMessages([]);
		setOlderCursor(null);
		setLoadEarlierError(null);
		setPendingRunId(null);
		setNotice(null);
		setSendError(null);
		setSendErrorUnknown(false);
		setAttachmentError(null);
		// Ephemeral overlay only: the durable rows come back from `readMessages`
		attachmentPickGeneration.current += 1;
		attachmentPreparationRef.current = false;
		attachmentDragDepth.current = 0;
		setAttachmentDragActive(false);
		setAttachments([]);
		setPreparingAttachments(false);
		preparingConversationRef.current = false;
		setPreparingConversation(false);
		// and the draft comes back from localStorage below.
		setProvisional(emptyProvisionalSends());
		setDraft(restoreChatDraft(window.localStorage, conversationId));
	}, [conversationId]);

	// One event stream feeds the provisional overlay, the tool-card fold, and
	// durable-event invalidations. Canonical run-set reconciliation remains as a
	// low-frequency backstop for state changes outside that run-local stream.
	const toolFramesRef = useRef(new Map<string, RuntimeStreamEvent>());
	const [toolFrameCount, setToolFrameCount] = useState(0);
	// Runs ever observed active — the prune baseline for departed-run frames.
	const seenActiveRunIdsRef = useRef(new Set<string>());
	const streamSinceRef = useRef(Date.now());
	// L5 reload-mid-run restoration: active runs whose recent events were
	// already fetched (once per run), and the collected events handed to the
	// overlay hook as `hydrate`.
	const hydratedRunIdsRef = useRef(new Set<string>());
	const [hydrateEvents, setHydrateEvents] = useState<RuntimeStreamEvent[]>([]);
	// Durable events no longer invalidate from here. The global connection
	// manager's pump patches the run set and the transcript in place from the
	// same frames this hook folds into overlays (`use-realtime.ts`), so the
	// trailing throttle that existed to soften a broad invalidation is gone
	// with the broad invalidation.
	// The pump lease only; the reconnect signal below comes from this
	// conversation's own stream, never from the worst-first aggregate.
	useRealtimeSurface({ conversationId });
	useEffect(() => {
		toolFramesRef.current = new Map();
		setToolFrameCount(0);
		seenActiveRunIdsRef.current = new Set();
		hydratedRunIdsRef.current = new Set();
		setHydrateEvents([]);
	}, [conversationId]);

	// Degraded-mode polling: when the Cap'n Web stream cannot establish (WS
	// blocked, server regression, a dev origin with no `/capn`), the connection
	// manager flips `degraded` and accelerates the run-set reconciliation below
	// plus transcript refetch — live data keeps flowing, just on a cadence. A
	// slower run-set reconciliation remains armed while any run is active even
	// on a healthy stream, because child orphan settlement and other canonical
	// projection changes do not necessarily emit a parent-run frame. This is the
	// only event fallback: the SSE lane remains retired.
	const realtimeDegraded = useRealtimeStatus().degraded;

	const { isActive, activeRunIds, runSet } = useIsRunActive(
		conversationId,
		pendingRunId !== null,
		realtimeDegraded,
	);
	const approvalCards = useMemo(
		() => (runSet ? approvalsFromRunSet(runSet) : []),
		[runSet],
	);
	const displayMessages = useMemo(
		() => applyDelegatedRunPreviews(messages, runSet?.runs ?? []),
		[messages, runSet],
	);
	const executionLinks = useMemo(
		() => executionLinkMessageIds(displayMessages),
		[displayMessages],
	);
	const blockingApprovalCards = approvalCards.filter(isBlockingApprovalCard);

	// Live-card pruning: when a run leaves the active set its tool frames are
	// dropped — durable evidence lives in the transcript and run detail, so a
	// long-lived tab never accumulates stale cards below fresh messages.
	useEffect(() => {
		if (runSet === undefined) return;
		const changed = pruneDepartedRunFrames(
			toolFramesRef.current,
			seenActiveRunIdsRef.current,
			activeRunIds,
		);
		if (changed) setToolFrameCount(toolFramesRef.current.size);
	}, [runSet, activeRunIds]);

	// Reload-mid-run restoration: when the run set reports active runs on
	// mount or after a conversation switch, fetch each run's recent durable
	// events once (hydrate-once guard) and feed them to the overlay hook —
	// a hard reload during generation shows the partial assistant text
	// immediately while the live stream (since-cutoff-exempt via
	// `activeRunIds`) continues the remainder of the turn.
	useEffect(() => {
		if (conversationId === null || activeRunIds.length === 0) return;
		const toHydrate = activeRunIds.filter((runId) =>
			shouldHydrateRun(hydratedRunIdsRef.current, runId),
		);
		if (toHydrate.length === 0) return;
		const hydratedFor = conversationId;
		void Promise.all(
			toHydrate.map(async (runId) => {
				try {
					const output = await osChatReadApi.kernelRuntime.readRunEvents({
						runId,
						tail: HYDRATE_RUN_EVENTS_TAIL,
					});
					return output.events;
				} catch {
					// Non-fatal: live frames still arrive; un-mark so a later
					// run-set refresh may retry this run's hydration.
					hydratedRunIdsRef.current.delete(runId);
					return [];
				}
			}),
		).then((eventLists) => {
			// The conversation switched while the fetch was in flight — the
			// per-conversation reset already cleared the hydrate state.
			if (cacheConversationRef.current !== hydratedFor) return;
			const events = eventLists.flat();
			if (events.length === 0) return;
			setHydrateEvents((previous) => appendHydrateEvents(previous, events));
		});
	}, [conversationId, activeRunIds]);

	// Transport seam: the Cap'n Web projection — overlays
	// plus canonical-verb actions, with mutations falling back to the identical
	// oRPC calls whenever the socket is down.
	const {
		overlays,
		status: conversationStreamStatus,
		actions: transportActions,
		recordRendered,
	} = useChatTransport(conversationId, {
		// Both live and hydrated frames land here (source: "live" | "hydrate")
		// and fold into the same id-keyed tool-card map — re-delivery across
		// sources is a plain overwrite, never a duplicate card.
		onFrame: (event) => {
			if (!TOOL_EVENT_KINDS.has(event.kind)) return;
			toolFramesRef.current.set(event.id, event);
			setToolFrameCount(toolFramesRef.current.size);
		},
		since: streamSinceRef.current,
		// Historical events of active runs, applied once (idempotent with any
		// re-delivered stream frames).
		hydrate: hydrateEvents,
		// In-flight runs bypass the `since` storm-guard cutoff so a reload
		// mid-run streams the remainder of the turn.
		activeRunIds,
	});

	// Render latency: `terminal_received` fires when the finalize frame lands,
	// but the reader is still looking at the streaming overlay until the durable
	// row replaces it. Reporting from here — the only place that knows a durable
	// assistant row is on screen — closes the last unmeasured leg of a turn and
	// completes the vocabulary the embedded lane already emits in full.
	//
	// Deliberately not inside `visibleOverlays`: that is a pure filter called
	// during render, and telemetry there would fire on every unrelated commit.
	// The correlation store dedupes per run, so this effect may run freely.
	useEffect(() => {
		for (const message of displayMessages) {
			if (message.role !== "assistant" || !message.runId) continue;
			if (message.status === "pending" || message.status === "streaming")
				continue;
			recordRendered(message.runId);
		}
	}, [displayMessages, recordRendered]);

	// Reconnect reconciliation: a resolution that landed while this connection
	// was down is not on the resumed stream, so a card still rendered pending
	// when the lane comes back re-reads the run set once. See
	// `reconcileApprovalsAfterReconnect` for why this is bounded to that one
	// query and skipped when nothing is pending.
	//
	// It reads this conversation'S stream status, not the shell's aggregate.
	// `useRealtimeSurface().status` is worst-first across every live entry, so
	// one unrelated capability sitting in `connecting` holds the aggregate off
	// `open` and the reconnect transition this effect waits for never fires —
	// leaving the stale approval card the reconcile exists to refresh. The
	// transport hook already owns the per-conversation lease and publishes its
	// exact status, which is the one that describes the cards on screen.
	const previousRealtimeStatusRef = useRef<ConversationStreamStatus>("idle");
	// Read inside the effect so the reconcile sees the current cards without
	// re-running on every run-set refresh.
	const approvalCardsRef = useRef(approvalCards);
	approvalCardsRef.current = approvalCards;
	useEffect(() => {
		const previous = previousRealtimeStatusRef.current;
		previousRealtimeStatusRef.current = conversationStreamStatus;
		if (
			!shouldReconcileApprovalsOnStreamOpen(previous, conversationStreamStatus)
		)
			return;
		reconcileApprovalsAfterReconnect(
			queryClient,
			conversationId,
			approvalCardsRef.current,
		);
	}, [conversationStreamStatus, conversationId, queryClient]);

	// Focus convergence: a window-focus listener invalidates the run set and
	// newest transcript slice (see `invalidateOnFocus` for why a listener over
	// `refetchOnWindowFocus: "always"`). Multi-tab convergence follows from
	// the idempotent id-keyed caches + this focus revalidation.
	useEffect(() => {
		const onFocus = () => invalidateOnFocus(queryClient, conversationId);
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [queryClient, conversationId]);

	const [approvalError, setApprovalError] = useState<string | null>(null);
	const respondApproval = useMutation({
		mutationFn: (input: { runId: string; decision: "approve" | "reject" }) =>
			transportActions.respondApproval(input),
		onMutate: () => setApprovalError(null),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
			queryClient.invalidateQueries({
				queryKey: homeMessagesQueryKey(conversationId),
			});
		},
		onError: (error) => {
			setApprovalError(
				errorMessage(
					error,
					"The approval could not be recorded. The card is still pending; try again.",
				),
			);
			void queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
		},
	});
	const alwaysApprove = useCallback(
		(approvalId: string, scopeKey: string) => {
			const card = approvalCards.find(
				(candidate) => candidate.approvalId === approvalId,
			);
			if (!card || respondApproval.isPending) return;
			alwaysApproveScopesRef.current.add(scopeKey);
			autoApprovalAttemptedRef.current.add(approvalId);
			respondApproval.mutate({ runId: card.runId, decision: "approve" });
		},
		[approvalCards, respondApproval],
	);
	useEffect(() => {
		const liveIds = new Set(approvalCards.map((card) => card.approvalId));
		for (const approvalId of autoApprovalAttemptedRef.current) {
			if (!liveIds.has(approvalId)) {
				autoApprovalAttemptedRef.current.delete(approvalId);
			}
		}
		if (respondApproval.isPending) return;
		const card = nextSessionAutoApproval(
			approvalCards,
			alwaysApproveScopesRef.current,
			autoApprovalAttemptedRef.current,
		);
		if (!card) return;
		autoApprovalAttemptedRef.current.add(card.approvalId);
		respondApproval.mutate({ runId: card.runId, decision: "approve" });
	}, [approvalCards, respondApproval]);
	const cancelRun = useMutation({
		mutationFn: (input: { runId: string }) => transportActions.cancelRun(input),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
		},
	});
	const retryRun = useMutation({
		mutationFn: (input: { runId: string }) =>
			osApi.kernelRuntime.retryRun(input),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(conversationId),
			});
			queryClient.invalidateQueries({
				queryKey: homeMessagesQueryKey(conversationId),
			});
		},
	});

	const transcript = useQuery({
		...homeMessagesQueryOptions(conversationId ?? "", MESSAGES_PAGE_LIMIT),
		enabled: conversationId !== null,
		// While a run is live, refresh the newest slice so streaming/completed
		// assistant rows land; the id-keyed merge makes re-delivery a no-op.
		refetchInterval: shouldPollTranscript({
			isActive,
			pendingRun: pendingRunId !== null,
			realtimeDegraded,
		})
			? RUN_POLL_INTERVAL_MS
			: false,
	});

	// Merge each newest-page fetch into the cache. Only the first page of a
	// conversation seeds the older-history cursor — refetches of page 1 return
	// a cursor into history already loaded, which must not clobber paging.
	useEffect(() => {
		const data = transcript.data;
		if (!data) return;
		setMessages(mergeHomeMessages(cacheRef.current, data.messages));
		if (!cursorInitializedRef.current) {
			cursorInitializedRef.current = true;
			setOlderCursor(data.nextCursor ?? null);
		}
	}, [transcript.data]);

	// Durable-wins reconciliation. `{key}:input` is exactly the id the canonical
	// read returns for the user turn, so membership in the transcript is proof
	// the durable row exists and the overlay must go — whatever state it was in.
	// This is the path that retires a bubble left in `outcome_unknown` when the
	// first attempt turns out to have been accepted after all, and it retires
	// exactly one entry because the key is the identity.
	useEffect(() => {
		if (provisional.size === 0) return;
		const durableMessageIds = new Set(messages.map((message) => message.id));
		// Retire the key with the overlay. The key is the run id
		// (execution-proposals derives runId from idempotencyKey) and the durable
		// event id is derived from it, inserted with onConflictDoNothing — so
		// reusing a key whose row already landed makes the server discard the new
		// message's content silently, with no error anywhere. Clearing on success
		// alone was not enough: an outcome-unknown send that turns out to have
		// been accepted is retired here, and the live ref would otherwise carry
		// the consumed key into the operator's next, different message.
		const activeKey = idempotencyKeyRef.current;
		if (
			activeKey !== null &&
			durableMessageIds.has(provisionalSendMessageId(activeKey))
		) {
			idempotencyKeyRef.current = null;
		}
		dispatchProvisional({ type: "reconcile", durableMessageIds });
	}, [messages, provisional.size, dispatchProvisional]);

	const loadEarlier = useCallback(async () => {
		if (!conversationId || !olderCursor || loadingEarlier) return;
		setLoadingEarlier(true);
		setLoadEarlierError(null);
		const el = scrollRef.current;
		prependAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
		try {
			const page = await osApi.kernelRuntime.readMessages({
				conversationId,
				limit: MESSAGES_PAGE_LIMIT,
				cursor: olderCursor,
			});
			setMessages(mergeHomeMessages(cacheRef.current, page.messages));
			setOlderCursor(page.nextCursor ?? null);
		} catch (error) {
			prependAnchorRef.current = null;
			setLoadEarlierError((error as Error).message);
		} finally {
			setLoadingEarlier(false);
		}
	}, [conversationId, olderCursor, loadingEarlier]);

	// Scroll maintenance: restore the pre-prepend anchor after "Load earlier",
	// otherwise follow the tail while the reader is pinned near the bottom.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const anchor = prependAnchorRef.current;
		if (anchor !== null) {
			prependAnchorRef.current = null;
			el.scrollTop = el.scrollHeight - anchor;
			return;
		}
		if (stickToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
		// Every source of transcript height belongs here, not just the durable
		// rows. The thread also renders provisional sends (`provisional`),
		// approval cards, and delegation rows derived from the run set — each
		// grows the column without touching `messages` or `overlays`, so a
		// pinned reader was left above the fold by their own optimistic bubble.
		// `displayMessages` replaces `messages` because it already folds the run
		// set's delegated previews.
	}, [
		displayMessages,
		provisional,
		approvalCards,
		runSet,
		pendingRunId,
		overlays,
		toolFrameCount,
	]);

	const handleScroll = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		const near = isNearBottom(el);
		stickToBottomRef.current = near;
		setPinnedToBottom(near);
	}, []);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		return observeScrollResize(el, () => stickToBottomRef.current);
	}, [composerOnly, conversationId]);

	const jumpToLatest = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		stickToBottomRef.current = true;
		setPinnedToBottom(true);
		el.scrollTop = el.scrollHeight;
	}, []);

	// Resolve the running indicator: once the pending run reports a terminal
	// status in the run set, pull the transcript for the assistant reply.
	useEffect(() => {
		if (!pendingRunId || !runSet) return;
		const pendingRun = runSet.runs.find((run) => run.id === pendingRunId);
		if (!pendingRun) return; // stale snapshot — keep waiting
		if (ACTIVE_RUN_STATUSES.has(pendingRun.status)) return;
		setPendingRunId(null);
		queryClient.invalidateQueries({
			queryKey: homeMessagesQueryKey(conversationId),
		});
	}, [pendingRunId, runSet, conversationId, queryClient]);

	const send = useMutation({
		mutationFn: (input: {
			draftContent: string;
			content: string;
			conversationId: string;
			idempotencyKey: string;
			attachments?: TediMessageAttachment[];
			metadata?: Record<string, unknown>;
			workspaceContext?: {
				workspaceId: string;
				workpiece?: { kind: "gadget" | "output"; id: string };
			};
			modelRef?: string;
		}) =>
			transportActions.enqueueMessage({
				conversationId: input.conversationId,
				content: input.content,
				idempotencyKey: input.idempotencyKey,
				attachments: input.attachments,
				metadata: input.metadata,
				workspaceContext: input.workspaceContext,
				modelRef: input.modelRef,
			}),
		onSuccess: (output, variables) => {
			if (output.status === "failed") {
				// The kernel answered and refused: a known not-sent. Retire the
				// provisional bubble (nothing durable exists to converge on) and put
				// the text back in the composer, keeping the key so Retry re-sends
				// the same run id.
				dispatchProvisional({
					type: "rejected",
					idempotencyKey: variables.idempotencyKey,
				});
				setDraft(variables.draftContent);
				setSendError(output.error ?? "Tedix could not accept the message.");
				return;
			}
			idempotencyKeyRef.current = null;
			setSendError(null);
			setSendErrorUnknown(false);
			// The durable user row now exists (`{key}:input`) and is merged below,
			// so the provisional overlay retires here rather than waiting for the
			// reconcile pass — durable always wins, never coexists.
			dispatchProvisional({
				type: "settled",
				idempotencyKey: variables.idempotencyKey,
			});
			setNotice(
				needsDelegationChoice(output)
					? "This request needs you to choose which tedi handles it. Pick one in the CLI for now; choosing here lands next."
					: null,
			);
			try {
				// The draft was stored under the key we sent from (possibly "new").
				window.localStorage.removeItem(chatDraftKey(conversationId));
			} catch {
				// storage unavailability never blocks the send
			}
			setDraft("");
			stickToBottomRef.current = true;
			// The enqueue persisted the user turn — render it from the response.
			const delivered: HomeMessage[] = [
				userMessageFromEnqueue(output, variables.content),
			];
			if (output.assistantMessage) delivered.push(output.assistantMessage);
			setMessages(mergeHomeMessages(cacheRef.current, delivered));
			if (!output.assistantMessage && output.status !== "needs_delegation") {
				setPendingRunId(output.run.id);
			}
			queryClient.invalidateQueries({
				queryKey: homeRunSetQueryKey(output.conversationId),
			});
			if (conversationId === null) {
				// Keep the cache when the parent flips the route to the new id.
				cacheConversationRef.current = output.conversationId;
				dispatchProvisional({
					type: "adopt",
					conversationId: output.conversationId,
				});
				onConversationCreated?.(
					output.conversationId,
					variables.workspaceContext?.workspaceId,
				);
			}
		},
		onError: (error, variables) => {
			// The key is always kept: Retry re-sends it, and a same-key resend is
			// exactly-once server-side.
			const message = errorMessage(error, "The send failed.");
			setSendError(message);
			// Recorded separately from the overlay because the overlay may already
			// be gone: a durable row can land before the promise rejects.
			setSendErrorUnknown(isUnknownSendOutcome(error));
			if (isUnknownSendOutcome(error)) {
				// The kernel may hold this turn. The bubble stays — as unconfirmed,
				// never as sent — and the composer stays empty so Retry re-sends that
				// message rather than letting a second draft accumulate beside it.
				dispatchProvisional({
					type: "unknown",
					idempotencyKey: variables.idempotencyKey,
					error: message,
				});
				return;
			}
			// The server answered and refused: nothing durable will ever appear, so
			// the overlay goes and the text returns to the composer.
			dispatchProvisional({
				type: "rejected",
				idempotencyKey: variables.idempotencyKey,
			});
			setDraft(variables.draftContent);
		},
		onSettled: () => {
			// The composer is readOnly (never disabled) while sending, so focus is
			// normally retained — this refocus covers the cases where a transcript
			// data load or an error banner stole it mid-send.
			composerRef.current?.focus();
		},
	});

	const directRead = useMutation({
		mutationFn: (input: DirectReadRequest) =>
			osDirectReadApi.kernelRuntime.executeReadOnlyTool(input),
		onSuccess: (output, variables) => {
			setMessages(
				mergeHomeMessages(cacheRef.current, [
					output.requestMessage,
					output.receiptMessage,
				]),
			);
			setDraft("");
			setSendError(null);
			setSendErrorUnknown(false);
			idempotencyKeyRef.current = null;
			directReadRetryRef.current = null;
			try {
				window.localStorage.removeItem(chatDraftKey(variables.conversationId));
			} catch {
				// Draft persistence is best effort.
			}
			invalidateHomeTranscript(queryClient, variables.conversationId);
			setDirectReadOpen(false);
			if (conversationId === null) {
				cacheConversationRef.current = variables.conversationId;
				dispatchProvisional({
					type: "adopt",
					conversationId: variables.conversationId,
				});
				onConversationCreated?.(
					variables.conversationId,
					variables.workspaceContext?.workspaceId,
				);
			}
		},
		onError: (error) => {
			setSendError(
				errorMessage(error, "The direct read could not be started."),
			);
			setSendErrorUnknown(isUnknownSendOutcome(error));
		},
		onSettled: () => composerRef.current?.focus(),
	});

	const startDirectRead = useCallback(
		(command: DirectReadCommand, preparedWorkspaceId?: string) => {
			if (directRead.isPending) return;
			const effectiveWorkspaceId = workspaceId ?? preparedWorkspaceId;
			const targetConversationId = conversationIdForSend(
				conversationId,
				newConversationIdRef.current,
			);
			if (conversationId === null)
				newConversationIdRef.current = targetConversationId;
			const key = nextIdempotencyKey(idempotencyKeyRef.current);
			idempotencyKeyRef.current = key;
			setSendError(null);
			stickToBottomRef.current = true;
			const request: DirectReadRequest = {
				...command,
				conversationId: targetConversationId,
				idempotencyKey: key,
				...(organizationId ? { organizationId } : {}),
				...(effectiveWorkspaceId
					? {
							workspaceContext: {
								workspaceId: effectiveWorkspaceId,
								...(context &&
								includeContext &&
								(context.kind === "gadget" || context.kind === "output")
									? { workpiece: { kind: context.kind, id: context.id } }
									: {}),
							},
						}
					: {}),
			};
			directReadRetryRef.current = request;
			directRead.mutate(request);
		},
		[
			conversationId,
			context,
			directRead,
			includeContext,
			organizationId,
			workspaceId,
		],
	);

	/**
	 * One send path for both the composer and Retry.
	 *
	 * The key is minted once and held across failures, so `content` is bound to
	 * it: a retry re-sends the original text even when the composer has since
	 * been used for something else. The draft leaves the textarea immediately —
	 * the provisional bubble now holds it — but the localStorage copy stays
	 * until the send succeeds, which is what makes a reload mid-send restore the
	 * draft rather than lose it.
	 */
	const startSend = useCallback(
		async (content: string) => {
			if (localAiUnavailable && !parseDirectReadCommand(content)) return;
			if (
				(!content.trim() && attachments.length === 0) ||
				preparingAttachments ||
				preparingConversationRef.current ||
				send.isPending ||
				directRead.isPending ||
				// Enter bypasses the disabled submit button; the gate cannot.
				blockedByAttachedImage
			)
				return;
			let preparedWorkspaceId = newWorkspaceIdRef.current ?? undefined;
			if (
				conversationId === null &&
				!workspaceId &&
				!preparedWorkspaceId &&
				prepareNewConversation
			) {
				preparingConversationRef.current = true;
				setPreparingConversation(true);
				setSendError(null);
				try {
					const prepared = await prepareNewConversation(content);
					preparedWorkspaceId = prepared.workspaceId;
					newWorkspaceIdRef.current = prepared.workspaceId;
				} catch (error) {
					setSendError(
						errorMessage(error, "The workspace could not be prepared."),
					);
					return;
				} finally {
					preparingConversationRef.current = false;
					setPreparingConversation(false);
				}
			}
			const directCommand =
				attachments.length === 0 ? parseDirectReadCommand(content) : null;
			const effectiveWorkspaceId = workspaceId ?? preparedWorkspaceId;
			const contextualContent =
				context && includeContext
					? encodeChatContext(context, content)
					: content;
			const targetConversationId = conversationIdForSend(
				conversationId,
				newConversationIdRef.current,
			);
			if (conversationId === null) {
				newConversationIdRef.current = targetConversationId;
			}
			const key = nextIdempotencyKey(idempotencyKeyRef.current);
			idempotencyKeyRef.current = key;
			if (directCommand) {
				idempotencyKeyRef.current = null;
				startDirectRead(directCommand, preparedWorkspaceId);
				return;
			}
			directReadRetryRef.current = null;
			setSendError(null);
			setSendErrorUnknown(false);
			const provisionalAction = {
				type: "send",
				idempotencyKey: key,
				content: contextualContent,
				conversationId: targetConversationId,
				at: new Date().toISOString(),
			} as const;
			dispatchProvisional(provisionalAction);
			setDraft("");
			onSendStarted?.();
			stickToBottomRef.current = true;
			send.mutate({
				draftContent: content,
				content: contextualContent,
				conversationId: targetConversationId,
				idempotencyKey: key,
				attachments: attachments.map(({ previewUrl, ...attachment }) => {
					void previewUrl;
					return attachment;
				}),
				metadata:
					context && includeContext ? { chatContext: context } : undefined,
				workspaceContext: effectiveWorkspaceId
					? {
							workspaceId: effectiveWorkspaceId,
							...(context &&
							includeContext &&
							(context.kind === "gadget" || context.kind === "output")
								? {
										workpiece: { kind: context.kind, id: context.id },
									}
								: {}),
						}
					: undefined,
				modelRef: localWorkersAi ? undefined : (selectedModelRef ?? undefined),
			});
			if (
				conversationId === null &&
				preparedWorkspaceId &&
				onConversationPrepared
			) {
				carryProvisionalFirstTurn(targetConversationId, provisionalAction);
				onConversationPrepared(targetConversationId, preparedWorkspaceId);
			}
			setAttachments([]);
		},
		[
			attachments,
			preparingAttachments,
			localAiUnavailable,
			localWorkersAi,
			blockedByAttachedImage,
			context,
			conversationId,
			dispatchProvisional,
			includeContext,
			selectedModelRef,
			directRead,
			prepareNewConversation,
			onConversationPrepared,
			onSendStarted,
			startDirectRead,
			send,
			workspaceId,
		],
	);

	const submit = useCallback(() => {
		void startSend(draft);
	}, [draft, startSend]);

	useEffect(() => {
		if (!onSendMessageReady) return;
		onSendMessageReady((content) => {
			void startSend(content);
		});
		return () => onSendMessageReady(() => {});
	}, [onSendMessageReady, startSend]);

	/** Re-send the same key with the same text — never a second message. */
	const retrySend = useCallback(() => {
		const key = idempotencyKeyRef.current;
		const request = send.variables;
		if (!request || request.idempotencyKey !== key || send.isPending) return;
		setSendError(null);
		setSendErrorUnknown(false);
		dispatchProvisional({
			type: "send",
			idempotencyKey: request.idempotencyKey,
			content: request.content,
			conversationId: request.conversationId,
			at: new Date().toISOString(),
		});
		// Replay the complete request, including attachments and context. Passing
		// encoded text through startSend encodes it twice and loses attachments.
		send.mutate(request);
	}, [dispatchProvisional, send]);

	/** Replay the exact direct-read request and key. The server's request-event
	 * insert is the execution fence, so a transport retry returns the durable
	 * receipt without invoking the provider a second time. */
	const retryDirectRead = useCallback(() => {
		const request = directReadRetryRef.current;
		if (!request || directRead.isPending) return;
		setSendError(null);
		setSendErrorUnknown(false);
		directRead.mutate(request);
	}, [directRead]);

	const updateDraft = useCallback(
		(value: string) => {
			setDraft(value);
			try {
				if (value) {
					window.localStorage.setItem(chatDraftKey(conversationId), value);
				} else {
					window.localStorage.removeItem(chatDraftKey(conversationId));
				}
			} catch {
				// draft persistence is best-effort
			}
		},
		[conversationId],
	);
	const dictation = useComposerDictation((transcript) => {
		updateDraft(appendVoiceTranscript(draft, transcript));
		composerRef.current?.focus();
	});

	// --- Composer skill picker -------------------------------------------
	// Skills are governed on their own admin surface but were not invocable
	// where the operator types. A bare slash token opens a bounded picker; a
	// confirmation writes the canonical `/skill <slug>` reference into the
	// message itself, which the kernel's operator-slash parser understands.
	const skillTrigger = draftPickerTrigger(draft);
	const [skillPickerDismissed, setSkillPickerDismissed] = useState(false);
	const [skillActiveIndex, setSkillActiveIndex] = useState(-1);
	const skillCatalog = useQuery({
		...skillCatalogQueryOptions(SKILL_CATALOG_LIMIT),
		enabled: skillTrigger !== null && !skillPickerDismissed,
		// Freshness per open, never per conversation. A catalog cached for the
		// life of a thread makes a skill recorded a minute ago invisible, and a
		// cached failure reads as an empty library. staleTime 0 plus
		// gcTime 0 means every open re-reads rather than replaying a snapshot.
		staleTime: 0,
		gcTime: 0,
		retry: false,
	});
	const reachableSkills = useMemo(
		() => composerReachableSkills(skillCatalog.data?.entries ?? []),
		[skillCatalog.data],
	);
	const skillMatches = useMemo(
		() =>
			skillTrigger === null
				? []
				: filterComposerSkills(reachableSkills, skillTrigger),
		[reachableSkills, skillTrigger],
	);
	const skillPickerOpen =
		skillTrigger !== null &&
		!skillPickerDismissed &&
		(skillCatalog.isPending || skillCatalog.isError || skillMatches.length > 0);
	// Pills are a pure projection of the durable text through the shared parser,
	// so a hand-edited draft and the pill row can never disagree.
	const referencedSlugs = useMemo(() => parseSkillReferences(draft), [draft]);
	const skillTitles = useMemo(() => {
		const titles = new Map<string, string>();
		for (const skill of reachableSkills) titles.set(skill.slug, skill.title);
		return titles;
	}, [reachableSkills]);
	const skillPills = useMemo(
		() =>
			referencedSlugs.map((slug) => ({
				slug,
				title: skillTitles.get(slug) ?? slug,
			})),
		[referencedSlugs, skillTitles],
	);
	const confirmSkill = useCallback(
		(skill: ComposerSkill) => {
			updateDraft(insertSkillReference(draft, skill.slug));
			setSkillActiveIndex(-1);
			composerRef.current?.focus();
		},
		[draft, updateDraft],
	);
	// A new trigger is a new list: a stale highlight would confirm a row the
	// operator can no longer see.
	useEffect(() => {
		setSkillActiveIndex(-1);
		if (skillTrigger === null) setSkillPickerDismissed(false);
	}, [skillTrigger]);

	const showRunning = pendingRunId !== null || isActive;
	const pendingRun = runSet?.runs.find((run) => run.id === pendingRunId);
	const provisionalSends = listProvisionalSends(
		provisional,
		conversationId,
		newConversationIdRef.current,
	);
	// An overlay for this key is still on screen, so the composer must not also
	// hold the text — Retry re-sends the bubble, not a second draft.
	const sendHeldProvisionally = hasProvisionalSend(
		provisional,
		idempotencyKeyRef.current,
	);
	// The overlay is the usual evidence that an outcome is unknown, but it is
	// retired the moment the durable row lands — and the enqueue promise can
	// reject after that (the common flake shape). Without this the banner
	// claimed "Message not sent" while the message sat durably on screen, and
	// promised a held draft next to an empty composer. Classify from the error
	// itself, which stays true whichever order those two events arrive in.
	const sendOutcomeUnknown = sendHeldProvisionally || sendErrorUnknown;
	const showTranscriptSkeleton =
		conversationId !== null && transcript.isPending && messages.length === 0;
	const resetAttachmentDrag = () => {
		attachmentDragDepth.current = 0;
		setAttachmentDragActive(false);
	};
	const addComposerFiles = (selected: File[]) => {
		// Ref fence also covers a picker and drop arriving before React rerenders.
		if (attachmentPreparationRef.current || selected.length === 0) return;
		const capacity = Math.max(0, 5 - attachments.length);
		if (capacity === 0) {
			setAttachmentError("Messages are limited to 5 attachments.");
			return;
		}
		const picked = selected.slice(0, capacity);
		const files =
			imageRefusal === null
				? picked
				: picked.filter((file) => attachmentType(file) !== "image");
		setAttachmentError(
			files.length !== picked.length
				? imageRefusal
				: selected.length > capacity
					? "Messages are limited to 5 attachments; extra files were not added."
					: null,
		);
		if (files.length === 0) return;
		attachmentPreparationRef.current = true;
		setPreparingAttachments(true);
		const generation = ++attachmentPickGeneration.current;
		void Promise.all(files.map(readComposerAttachment))
			.then((items) => {
				if (attachmentPickGeneration.current === generation)
					setAttachments((current) => [...current, ...items]);
			})
			.catch((error: unknown) => {
				if (attachmentPickGeneration.current !== generation) return;
				setAttachmentError(
					error instanceof Error
						? error.message
						: "Could not prepare attachment.",
				);
			})
			.finally(() => {
				if (attachmentPickGeneration.current === generation) {
					attachmentPreparationRef.current = false;
					setPreparingAttachments(false);
				}
			});
	};
	const hasContent =
		displayMessages.length > 0 || provisionalSends.length > 0 || showRunning;
	const actionableAssistantMessageId = showRunning
		? null
		: latestActionableAssistantMessageId(displayMessages, runSet?.runs ?? []);
	const chooseResponseAction = (action: ChatResponseAction) => {
		const prompt = chatResponseActionPrompt(action);
		if (chatResponseActionSendsImmediately(action)) {
			void startSend(prompt);
			return;
		}
		updateDraft(prompt);
		composerRef.current?.focus();
	};

	return (
		<div
			className={
				composerOnly
					? "flex min-h-0 flex-col gap-3"
					: "flex h-full min-h-0 flex-col gap-3"
			}
		>
			{!composerOnly && conversationId !== null ? (
				<Collapsible className="shrink-0">
					<div className="flex justify-end">
						<CollapsibleTrigger className="group">
							Chat details
							<CaretDown
								size={14}
								aria-hidden
								className="transition-transform group-data-panel-open:rotate-180"
							/>
						</CollapsibleTrigger>
					</div>
					<CollapsibleContent>
						<div className="flex flex-wrap items-center justify-end gap-2 pt-2">
							<ConversationCapabilityPalette conversationId={conversationId} />
							{runSet !== undefined ? (
								<>
									<ContextUsedInspector
										runs={runSet.runs}
										workspaceId={workspaceId}
										context={context}
									/>
									<ConversationCostChip runs={runSet.runs} />
								</>
							) : null}
						</div>
					</CollapsibleContent>
				</Collapsible>
			) : null}
			{composerOnly ? null : (
				<div className="relative flex min-h-0 flex-1 flex-col">
					<div
						ref={scrollRef}
						data-slot="conversation-transcript"
						onScroll={handleScroll}
						role="log"
						aria-label="Conversation"
						aria-live="polite"
						tabIndex={0}
						className="min-h-48 flex-1 overflow-y-auto bg-transparent p-4"
					>
						<div className="mx-auto min-w-0 w-full max-w-[920px]">
							{conversationId === null && !hasContent ? (
								<Empty appearance="inline">
									<EmptyHeader>
										<EmptyTitle>New conversation</EmptyTitle>
										<EmptyDescription>
											Your first message creates the thread — the kernel routes
											it, delegates when needed, and every turn stays auditable.
										</EmptyDescription>
										<ChatStarterPrompts onChoose={updateDraft} />
									</EmptyHeader>
								</Empty>
							) : null}
							{showTranscriptSkeleton ? (
								<div className="grid gap-2" aria-hidden>
									<Skeleton className="h-14 w-2/3" />
									<Skeleton className="ml-auto h-14 w-2/3" />
									<Skeleton className="h-14 w-2/3" />
								</div>
							) : null}
							{transcript.isError && messages.length === 0 ? (
								<Alert variant="destructive">
									<AlertTitle>The transcript is unavailable</AlertTitle>
									<AlertDescription>
										{(transcript.error as Error).message}
									</AlertDescription>
								</Alert>
							) : null}
							{conversationId !== null &&
							transcript.isSuccess &&
							!hasContent ? (
								<Empty appearance="inline">
									<EmptyHeader>
										<EmptyTitle>No messages yet</EmptyTitle>
										<EmptyDescription>
											Send the first message below to start this thread.
										</EmptyDescription>
										<ChatStarterPrompts onChoose={updateDraft} />
									</EmptyHeader>
								</Empty>
							) : null}
							{hasContent ? (
								<ul className="m-0 grid min-w-0 list-none gap-4 p-0">
									{olderCursor ? (
										<li className="flex justify-center">
											<Button
												size="sm"
												variant="ghost"
												className="text-kumo-subtle"
												loading={loadingEarlier}
												disabled={loadingEarlier}
												onClick={() => void loadEarlier()}
											>
												Load earlier
											</Button>
										</li>
									) : null}
									{loadEarlierError ? (
										<li
											className="text-center text-kumo-danger text-xs"
											role="alert"
										>
											Could not load earlier messages: {loadEarlierError}
										</li>
									) : null}
									{displayMessages.map((message) => (
										<Fragment key={message.id}>
											<ChatMessageBubble
												message={message}
												showExecutionLink={executionLinks.has(message.id)}
												context={context}
												workspaceId={workspaceId}
											/>
											<ChatMessageWidgets
												message={message}
												onFollowUp={startSend}
											/>
											{message.id === actionableAssistantMessageId ? (
												<ChatResponseActions onChoose={chooseResponseAction} />
											) : null}
										</Fragment>
									))}
									{/* Provisional user turns render after every durable row and
								    before the assistant overlay: they are the newest thing in
								    the thread by construction, and the reconcile pass has
								    already dropped any whose durable row is in `messages`. */}
									{provisionalSends.map((send) => (
										<ProvisionalUserBubble
											key={send.idempotencyKey}
											send={send}
										/>
									))}
									{visibleOverlays(
										overlays,
										new Set(displayMessages.map((message) => message.id)),
										new Set(
											displayMessages
												.filter((message) => message.role === "assistant")
												.flatMap((message) =>
													message.runId ? [message.runId] : [],
												),
										),
									).map((overlay) => (
										<Fragment key={overlay.key}>
											{/* The planner's provisional thinking line, above the
										    answer it precedes. Pre-spaced: it reserves its line for
										    the whole in-flight window, so nothing shifts when the
										    rationale arrives or when the answer supersedes it. */}
											{overlay.phase && !overlay.finalized ? (
												<StreamedRationaleRow rationale={overlay.rationale} />
											) : null}
											{overlay.text ? (
												<StreamedAssistantBubble
													text={overlay.text}
													done={overlay.finalized}
												/>
											) : null}
											{overlay.phase && !overlay.finalized ? (
												<StreamedPhaseRow phase={overlay.phase} />
											) : null}
										</Fragment>
									))}
									{(() => {
										const tools = sortToolStates(
											mergeToolEvents([
												...toolFramesRef.current.values(),
											]).values(),
										);
										return tools.length > 0 ? (
											<WorkTraceCard tools={tools} />
										) : null;
									})()}
									{activeDelegations(runSet?.runs ?? []).map((work) => (
										<DelegationWorkCard
											key={work.childRunId ?? work.runId}
											work={work}
											tediName={
												work.delegatedTediId
													? tediNames[work.delegatedTediId]
													: null
											}
										/>
									))}
									{approvalCards.map((card) => (
										<ApprovalCard
											key={card.approvalId}
											approval={card}
											resolving={
												respondApproval.isPending &&
												respondApproval.variables?.runId === card.runId
											}
											onResolve={(_, decision) =>
												respondApproval.mutate({ runId: card.runId, decision })
											}
											onAlwaysApprove={alwaysApprove}
										/>
									))}
									{approvalError ? (
										<li>
											<Text role="label" tone="error" className="m-0">
												{approvalError}
											</Text>
										</li>
									) : null}
									{pendingRun ? (
										<li className="flex w-full justify-start">
											<RunControls
												status={pendingRun.status}
												delegated={pendingRun.delegatedTediId != null}
												pending={cancelRun.isPending || retryRun.isPending}
												onStop={() =>
													cancelRun.mutate({ runId: pendingRun.id })
												}
												onRetry={() =>
													retryRun.mutate({ runId: pendingRun.id })
												}
											/>
										</li>
									) : null}
									{shouldShowRunningIndicator({
										showRunning,
										overlayCount: overlays.length,
									}) ? (
										<RunningIndicator
											label={
												pendingRun?.progress?.label ??
												pendingRun?.progress?.detail ??
												null
											}
										/>
									) : null}
								</ul>
							) : null}
						</div>
					</div>
					<JumpToLatestControl
						visible={!pinnedToBottom && hasContent}
						onJump={jumpToLatest}
					/>
				</div>
			)}

			{localAiUnavailable ? (
				<Alert variant="info">
					<AlertTitle>Local exploration mode</AlertTitle>
					<AlertDescription>
						{LOCAL_AI_UNAVAILABLE}{" "}
						<a href="https://docs.tedix.dev/getting-started/">
							Set up local inference
						</a>
					</AlertDescription>
				</Alert>
			) : null}
			{notice ? (
				<Alert variant="info">
					<AlertTitle>Delegation choice needed</AlertTitle>
					<AlertDescription>{notice}</AlertDescription>
				</Alert>
			) : null}
			{sendError ? (
				<SendFailureBanner
					message={sendError}
					// The banner's claim is read off the same overlay the transcript
					// renders, so the two can never disagree about whether the outcome
					// is unknown.
					outcomeUnknown={sendOutcomeUnknown}
					draftHeld={sendHeldProvisionally}
					retrying={send.isPending || directRead.isPending}
					onRetry={directReadRetryRef.current ? retryDirectRead : retrySend}
				/>
			) : null}
			{directReadOpen && blockingApprovalCards.length === 0 ? (
				readOnlyCatalog.isLoading ? (
					<Surface
						tier="panel"
						className="mx-auto mb-2 w-full max-w-[920px] p-4"
					>
						<Text role="body" tone="secondary" className="m-0">
							Loading connected app reads…
						</Text>
					</Surface>
				) : readOnlyCatalog.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Connected app reads unavailable</AlertTitle>
						<AlertDescription>
							{errorMessage(
								readOnlyCatalog.error,
								"Could not load the read-only tool catalog.",
							)}
						</AlertDescription>
					</Alert>
				) : (
					<div className="mx-auto w-full max-w-[920px]">
						<DirectReadComposer
							apps={readOnlyCatalog.data?.apps ?? []}
							pending={directRead.isPending}
							onClose={() => setDirectReadOpen(false)}
							onRun={startDirectRead}
						/>
					</div>
				)
			) : null}

			{blockingApprovalCards.length > 0 ? (
				<ApprovalInputGate count={blockingApprovalCards.length} />
			) : (
				<form
					data-slot="chat-composer"
					className="chat-composer relative mx-auto w-full max-w-[920px] rounded-2xl border border-kumo-hairline bg-kumo-base shadow-tedix-raised transition-shadow duration-tedix-standard focus-within:shadow-tedix-floating motion-reduce:transition-none"
					onDragEnter={(event) => {
						if (!Array.from(event.dataTransfer.types).includes("Files")) return;
						event.preventDefault();
						attachmentDragDepth.current += 1;
						setAttachmentDragActive(true);
					}}
					onDragOver={(event) => {
						if (!Array.from(event.dataTransfer.types).includes("Files")) return;
						event.preventDefault();
						event.dataTransfer.dropEffect =
							preparingAttachments || attachments.length >= 5 ? "none" : "copy";
						setAttachmentDragActive(true);
					}}
					onDragLeave={() => {
						attachmentDragDepth.current = Math.max(
							0,
							attachmentDragDepth.current - 1,
						);
						if (attachmentDragDepth.current === 0)
							setAttachmentDragActive(false);
					}}
					onDragEnd={resetAttachmentDrag}
					onDrop={(event) => {
						if (!Array.from(event.dataTransfer.types).includes("Files")) return;
						event.preventDefault();
						event.stopPropagation();
						resetAttachmentDrag();
						addComposerFiles(Array.from(event.dataTransfer.files));
					}}
					onSubmit={(event) => {
						event.preventDefault();
						if (dictation.phase !== "idle") {
							if (dictation.phase === "recording") dictation.stop();
							return;
						}
						submit();
					}}
				>
					{skillPickerOpen ? (
						<ChatSkillPicker
							activeIndex={skillActiveIndex}
							error={skillCatalog.isError}
							loading={skillCatalog.isPending}
							onRetry={() => void skillCatalog.refetch()}
							onSelect={confirmSkill}
							skills={skillMatches}
						/>
					) : null}
					<ChatSkillPills
						skills={skillPills}
						onRemove={(slug) => {
							updateDraft(removeSkillReference(draft, slug));
							composerRef.current?.focus();
						}}
					/>
					{attachmentDragActive ? (
						<Surface
							data-slot="attachment-dropzone"
							role="status"
							className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-kumo-brand p-4"
						>
							<Text role="body" className="m-0 flex items-center gap-2">
								<Paperclip size={20} aria-hidden="true" />
								{preparingAttachments
									? "Preparing attachments…"
									: attachments.length >= 5
										? "Messages are limited to 5 attachments"
										: "Drop files to attach"}
							</Text>
						</Surface>
					) : null}
					<input
						ref={attachmentInputRef}
						type="file"
						className="hidden"
						aria-label="Attach files"
						disabled={preparingAttachments}
						multiple
						onChange={(event) => {
							addComposerFiles(Array.from(event.target.files ?? []));
							event.target.value = "";
						}}
					/>
					{composerAttachmentError ? (
						<p
							data-slot="attachment-error"
							role="alert"
							className="m-0 px-4 pt-3 text-kumo-danger text-xs"
						>
							{composerAttachmentError}
						</p>
					) : null}
					{dictation.error ? (
						<div
							role="alert"
							className="flex items-center justify-between gap-3 px-4 pt-3 text-kumo-danger text-xs"
						>
							<span>{dictation.error}</span>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void dictation.start().catch(() => undefined)}
							>
								Try again
							</Button>
						</div>
					) : null}
					{attachments.length > 0 ? (
						<div className="flex flex-wrap gap-2 px-3 pt-3">
							{attachments.map((attachment) => (
								<div
									key={`${attachment.fileName}:${attachment.size}`}
									className="relative flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-tint px-2 py-1"
								>
									{attachment.previewUrl ? (
										<img
											src={attachment.previewUrl}
											alt=""
											className="size-8 rounded object-cover"
										/>
									) : (
										<File size={14} />
									)}
									<Text as="span" role="label" className="max-w-36 truncate">
										{attachment.fileName}
									</Text>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label={`Remove ${attachment.fileName}`}
										onClick={() =>
											setAttachments((items) =>
												items.filter((item) => item !== attachment),
											)
										}
										icon={<X size={12} />}
									/>
								</div>
							))}
						</div>
					) : null}
					{dictation.phase === "idle" ? (
						<Textarea
							ref={composerRef}
							aria-label="Message"
							placeholder="Message your Tedix OS…"
							value={draft}
							onValueChange={updateDraft}
							onKeyDown={(event) => {
								// The IME guard comes first for the picker too: a candidate
								// selection is Enter/Arrow traffic that belongs to the IME,
								// never to the composer.
								if (isImeComposing(event)) return;
								if (skillPickerOpen && skillMatches.length > 0) {
									if (event.key === "ArrowDown" || event.key === "ArrowUp") {
										event.preventDefault();
										setSkillActiveIndex((index) => {
											const step = event.key === "ArrowDown" ? 1 : -1;
											const next = index + step;
											if (next < 0) return skillMatches.length - 1;
											return next >= skillMatches.length ? 0 : next;
										});
										return;
									}
									// Enter confirms only from a row the operator explicitly
									// highlighted. Typing `/anything` and pressing Enter is
									// still a plain send — the picker never swallows a message.
									if (event.key === "Enter" && !event.shiftKey) {
										const highlighted = skillMatches[skillActiveIndex];
										if (highlighted) {
											event.preventDefault();
											confirmSkill(highlighted);
											return;
										}
									}
								}
								if (skillPickerOpen && event.key === "Escape") {
									event.preventDefault();
									setSkillPickerDismissed(true);
									return;
								}
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									submit();
								}
							}}
							// readOnly (not disabled) while sending: a disabled control blurs
							// the composer and swallows the next Enter — focus must survive
							// the send round-trip.
							readOnly={send.isPending || preparingConversation}
							autoResize
							minRows={1}
							maxRows={8}
							className="min-h-14 resize-none rounded-2xl border-0 bg-transparent px-4 pt-3 pb-1 shadow-none focus-visible:ring-0"
						/>
					) : (
						<div
							className="chat-voice-capture flex min-h-14 items-center gap-3 px-3"
							role="status"
							aria-label={
								dictation.phase === "connecting"
									? "Connecting microphone"
									: dictation.phase === "recording"
										? "Listening"
										: "Transcribing"
							}
						>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="Cancel dictation"
								onClick={dictation.cancel}
								icon={<X size={16} />}
							/>
							{dictation.phase === "recording" ? (
								<div className="chat-voice-wave" aria-hidden="true">
									{Array.from({ length: VOICE_WAVE_BAR_COUNT }, (_, index) => {
										return (
											<i
												key={index}
												style={{
													height: `${voiceWaveBarHeight(dictation.audioHistory[index] ?? 0)}px`,
												}}
											/>
										);
									})}
								</div>
							) : (
								<div className="flex flex-1 justify-center">
									<Loader size="sm" />
								</div>
							)}
							{dictation.phase === "recording" ? (
								<Button
									type="button"
									size="icon-sm"
									aria-label="Stop and transcribe"
									onClick={dictation.stop}
									icon={<Square size={14} weight="fill" />}
								/>
							) : null}
						</div>
					)}
					{dictation.phase === "idle" ? (
						<div className="chat-composer-actions flex items-center justify-between gap-3 px-4 pt-2 pb-3">
							<div className="chat-composer-context flex min-w-0 items-center gap-2">
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												type="button"
												size="icon-sm"
												variant="ghost"
												aria-label="Composer options"
												icon={<Plus size={16} />}
											/>
										}
									/>
									<DropdownMenuContent>
										<DropdownMenuItem onClick={() => setDirectReadOpen(true)}>
											<MagnifyingGlass size={14} />
											Read from connected app
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => attachmentInputRef.current?.click()}
										>
											Attach files
										</DropdownMenuItem>
										{CHAT_SLASH_COMMANDS.map((item) => (
											<DropdownMenuItem
												key={item.command}
												onClick={() =>
													updateDraft(`${item.instruction}\n\n${draft}`.trim())
												}
											>
												{item.command}
											</DropdownMenuItem>
										))}
										{CHAT_FORMATS.map((format) => (
											<DropdownMenuItem
												key={format}
												onClick={() =>
													updateDraft(
														`${draft}${draft ? "\n\n" : ""}Create a ${format} output for this request.`,
													)
												}
											>
												Create {format}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
								{context ? (
									<Button
										type="button"
										size="sm"
										className="chat-composer-chip min-w-0 max-w-32 shrink"
										variant={includeContext ? "outline" : "ghost"}
										aria-pressed={includeContext}
										onClick={() => setIncludeContext((value) => !value)}
									>
										<Paperclip className="shrink-0" size={14} />
										<span className="truncate">{context.label}</span>
									</Button>
								) : null}
								<Text
									as="span"
									role="label"
									className="chat-composer-hint min-w-0 shrink truncate text-kumo-inactive"
								>
									Enter to send · Shift+Enter for a new line
								</Text>
							</div>
							<div className="chat-composer-submit flex shrink-0 items-center justify-end gap-2">
								<Button
									type="button"
									size="icon-sm"
									variant="ghost"
									aria-label="Start dictation"
									disabled={send.isPending}
									onClick={() => void dictation.start().catch(() => undefined)}
									icon={<Microphone size={16} />}
								/>
								{localWorkersAi ? (
									<span
										className="text-xs text-kumo-subtle"
										title="Model configured by the local launcher; inference billed to your Cloudflare account"
									>
										Workers AI · local config
									</span>
								) : (
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													type="button"
													size="sm"
													variant="ghost"
													className="min-w-0 max-w-32"
												>
													<span className="truncate">
														{resolvableModels.find(
															(model) => model.ref === selectedModelRef,
														)?.label ?? "Model"}
													</span>
												</Button>
											}
										/>
										<DropdownMenuContent>
											{selectableModels.map((model) => (
												<DropdownMenuItem
													key={model.ref}
													onClick={() => {
														setSelectedModelRef(model.ref);
														// The refusal is re-derived from the new selection;
														// the stale one must not outlive it.
														setAttachmentError(null);
													}}
												>
													{model.label}
												</DropdownMenuItem>
											))}
										</DropdownMenuContent>
									</DropdownMenu>
								)}
								<Button
									type="submit"
									size="icon-sm"
									aria-label="Send message"
									icon={<ArrowUp size={16} weight="bold" />}
									loading={send.isPending || preparingConversation}
									disabled={
										preparingAttachments ||
										preparingConversation ||
										send.isPending ||
										directRead.isPending ||
										blockedByAttachedImage ||
										(localAiUnavailable && !parseDirectReadCommand(draft)) ||
										(!draft.trim() && attachments.length === 0)
									}
								/>
							</div>
						</div>
					) : null}
				</form>
			)}
		</div>
	);
}
