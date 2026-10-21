import {
	normalizePageToolDescriptors,
	PAGE_TOOL_LIMITS,
	type PageToolCallEvent,
	type PageToolDescriptor,
	type PageToolResult,
} from "@tedix/chat-transport/page-tools";

/**
 * Page tools the host registered for this widget session: the host page's own
 * actions (fill the card on screen, choose an option), which the chat may ask
 * the widget to run for one turn.
 *
 * The host passes `pageTools: { list() }` at mount. Each turn takes a snapshot
 * of that list; only tools in the snapshot may run for that turn, whatever a
 * frame names. Results go back to the runtime as untrusted page data.
 */
export interface HostPageToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export interface HostPageTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: PageToolDescriptor["annotations"];
	/** The person taps an inline confirm in the chat before it runs. */
	confirm?: boolean;
	/** Plain words for the activity row, e.g. "filled the answer". */
	describe?: (args: Record<string, unknown>) => string | null;
	/**
	 * Called just before the tool runs. Returns how to put the page back if the
	 * person taps Undo, or null where the page has no undo for this action.
	 */
	prepareUndo?: (args: Record<string, unknown>) => (() => unknown) | null;
	execute: (
		args: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	) => Promise<HostPageToolResult>;
}

export interface HostPageTools {
	list(): readonly HostPageTool[];
}

export interface PageToolSnapshot {
	descriptors: PageToolDescriptor[];
	tools: ReadonlyMap<string, HostPageTool>;
}

export const EMPTY_PAGE_TOOLS: PageToolSnapshot = {
	descriptors: [],
	tools: new Map(),
};

export function isHostPageTools(value: unknown): value is HostPageTools {
	return Boolean(
		value &&
		typeof value === "object" &&
		typeof (value as { list?: unknown }).list === "function",
	);
}

/** One turn's allow-list: bounded, well-formed, and executable. */
export function snapshotPageTools(
	host: HostPageTools | null | undefined,
): PageToolSnapshot {
	if (!host) return EMPTY_PAGE_TOOLS;
	let listed: readonly HostPageTool[];
	try {
		listed = host.list();
	} catch {
		return EMPTY_PAGE_TOOLS;
	}
	if (!Array.isArray(listed)) return EMPTY_PAGE_TOOLS;
	const executable = listed.filter(
		(tool) => tool && typeof tool.execute === "function",
	);
	const descriptors = normalizePageToolDescriptors(
		executable.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
			confirm: tool.confirm === true,
		})),
	);
	const tools = new Map<string, HostPageTool>();
	for (const descriptor of descriptors) {
		const tool = executable.find((entry) => entry.name === descriptor.name);
		if (tool) tools.set(descriptor.name, tool);
	}
	return { descriptors, tools };
}

function resultText(result: HostPageToolResult): string {
	if (result.structuredContent) {
		try {
			return JSON.stringify(result.structuredContent);
		} catch {
			/* fall through to the text parts */
		}
	}
	return (Array.isArray(result.content) ? result.content : [])
		.map((part) => (typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

export interface PageToolRunOutcome {
	result: PageToolResult;
	/** Activity phrase, or null for a quiet read. */
	label: string | null;
	undo: (() => unknown) | null;
	declined: boolean;
}

/**
 * Run one requested call. A tool outside this turn's snapshot never runs. A
 * tool that needs confirmation runs only after the person taps confirm, even
 * when the model's arguments claim the person already agreed.
 */
export async function runPageToolCall(input: {
	call: PageToolCallEvent;
	snapshot: PageToolSnapshot;
	confirm: (tool: HostPageTool, call: PageToolCallEvent) => Promise<boolean>;
	signal?: AbortSignal;
}): Promise<PageToolRunOutcome> {
	const tool = input.snapshot.tools.get(input.call.name);
	if (!tool)
		return {
			result: {
				ok: false,
				content: `"${input.call.name}" is not offered on this page for this turn.`,
			},
			label: null,
			undo: null,
			declined: false,
		};
	const needsConfirm = tool.confirm === true || input.call.confirm;
	if (needsConfirm && !(await input.confirm(tool, input.call)))
		return {
			result: {
				ok: false,
				content:
					"The person did not confirm in the chat. Nothing was submitted.",
			},
			label: null,
			undo: null,
			declined: true,
		};
	let undo: (() => unknown) | null = null;
	try {
		undo = tool.prepareUndo?.(input.call.args) ?? null;
	} catch {
		undo = null;
	}
	let raw: HostPageToolResult;
	try {
		raw = await tool.execute(input.call.args, { signal: input.signal });
	} catch (error) {
		raw = {
			content: [
				{
					type: "text",
					text:
						error instanceof Error ? error.message : "The page tool failed.",
				},
			],
			isError: true,
		};
	}
	const ok = raw?.isError !== true;
	let label: string | null = null;
	try {
		label = ok ? (tool.describe?.(input.call.args) ?? null) : null;
	} catch {
		label = null;
	}
	return {
		result: {
			ok,
			content: resultText(raw ?? { content: [] }).slice(
				0,
				PAGE_TOOL_LIMITS.resultMaxLength,
			),
		},
		label,
		undo: ok ? undo : null,
		declined: false,
	};
}
