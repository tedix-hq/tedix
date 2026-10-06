/** Temporary explicit graph cutover. Reads raw storage; apply uses only the passive Session kernel. */
import { openPiSessionStore } from "agents/harness/pi";
import {
	createSession,
	defineDoc,
	defineDocFamily,
	AgentDoc,
	InboxDoc,
	LiveDoc,
	ProviderDoc,
	UsageDoc,
	type ConversationId,
	type EntryId,
	type EntryDraft,
} from "@earendil-works/pi-durable";
import type {
	Message,
	AssistantMessage,
	ToolResultMessage,
	ImageContent,
} from "@earendil-works/pi-ai";
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
import {
	cutoverHash,
	inventoryPiStateCutover,
	type CutoverOwner,
} from "./pi-state-cutover";

const CONTEXT = {
	abortSignal: undefined,
	value: () => undefined,
	toString: () => "tedix-transcript-cutover",
};
const SOURCE_TABLES = [
	"cf_agents_session_messages",
	"cf_agents_session_message_chunks",
	"cf_agents_session_compactions",
	"cf_agents_session_config",
	"cf_agents_session_attachment_meta",
	"cf_agents_session_attachment_chunks",
	"cf_agents_session_attachment_refs",
] as const;
type Row = Record<string, JsonValue>;
interface Descriptor extends Record<string, JsonValue> {
	tediId: string;
	orgId: string;
	messageId: string;
	partIndex: number;
	url: string;
	mediaType: string;
	filename: string;
}
export interface TranscriptNode {
	sessionId: string;
	id: string;
	parentId: string | null;
	seq: number;
	display: Row;
	model: Message[];
	hidden: boolean;
}
export interface TranscriptCompaction {
	sessionId: string;
	id: string;
	seq: number;
	from: string;
	to: string;
	summary: string;
	createdAt: number;
}
export interface TranscriptSession {
	id: string;
	roots: string[];
	leaves: string[];
	activeLeaf: string | null;
}
export interface TranscriptPlan {
	version: 1;
	/** Imported references use the ordinary current-turn image authorization policy. */
	imagePolicy: "current-turn";
	owner: CutoverOwner;
	prefix: string;
	sourceHash: string;
	nodes: TranscriptNode[];
	sessions: TranscriptSession[];
	compactions: TranscriptCompaction[];
	descriptors: { token: string; descriptor: Descriptor }[];
	chunks: { sha256: string; text: string }[];
	/** Existing native histories are preserved, and never used as unverified raw ancestry. */
	priorNativeConversations: number[];
}
export interface TranscriptResult {
	sourceHash: string;
	entries: Record<string, number>;
	leaves: Record<string, number>;
	activeConversations: Record<string, number>;
	preservedNativeConversations: number[];
	contexts: Record<string, number>;
}
const Maps = defineDoc<{ sourceHash: string; result: string }>({
	kind: "tedix.cutover.transcript",
	version: 1,
	scope: "session",
	initial: () => ({ sourceHash: "", result: "" }),
	checkpointWhen: () => true,
});
const SourceChunks = defineDocFamily<{ text: string }, string>({
	kind: "tedix.cutover.source",
	version: 1,
	scope: "session",
	family: true,
	initial: (text) => ({ text }),
	checkpointWhen: () => true,
});
const line = new WeakMap<DurableObjectStorage, Promise<void>>();
const key = (sessionId: string, id: string) => JSON.stringify([sessionId, id]);
function fail(message: string): never {
	throw new Error(`Transcript cutover: ${message}`);
}
function parse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		fail("invalid persisted JSON");
	}
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("invalid object");
	return value as Record<string, unknown>;
}
function string(value: unknown): string {
	if (typeof value !== "string") fail("invalid string");
	return value;
}
function integer(value: unknown): number {
	if (!Number.isSafeInteger(value)) fail("invalid integer");
	return value as number;
}
function encoded(value: unknown): JsonValue {
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return { bytes: Array.from(bytes) };
	}
	if (Array.isArray(value)) return value.map(encoded);
	if (value && typeof value === "object" && !(value instanceof Date))
		return Object.fromEntries(
			Object.entries(value).map(([id, item]) => [id, encoded(item)]),
		);
	return JSON.parse(JSON.stringify(value)) as JsonValue;
}
function tables(storage: DurableObjectStorage): Set<string> {
	return new Set(
		storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type='table'",
			)
			.toArray()
			.map((row) => row.name),
	);
}
function rows(
	storage: DurableObjectStorage,
	table: string,
	names: Set<string>,
): Row[] {
	if (!names.has(table)) return [];
	return storage.sql
		.exec(`SELECT * FROM ${table}`)
		.toArray()
		.map((row) => encoded(row) as Row)
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function digestBytes(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (v) =>
		v.toString(16).padStart(2, "0"),
	).join("");
}
function nativeIdle(
	storage: DurableObjectStorage,
	prefix: string,
	names: Set<string>,
): void {
	if (!/^[a-z][a-z0-9_]*_$/.test(prefix)) fail("invalid native prefix");
	for (const suffix of ["tasks", "submissions"] as const) {
		if (!names.has(`${prefix}${suffix}`)) continue;
		for (const row of storage.sql
			.exec<{ record: string; status: string }>(
				`SELECT record,status FROM ${prefix}${suffix}`,
			)
			.toArray()) {
			const record = object(parse(row.record));
			const status =
				suffix === "tasks" ? object(record.state).status : record.status;
			if (status !== row.status) fail("native status conflict");
			if (
				!(suffix === "tasks"
					? status === "terminal"
					: status === "done" || status === "unanswered")
			)
				fail("unresolved native work");
		}
	}
}
function assistant(
	content: AssistantMessage["content"],
	outputs: ToolResultMessage[],
	timestamp: number,
): Message[] {
	return [
		{
			role: "assistant",
			content,
			api: "tedix",
			provider: "tedix",
			model: "imported-context",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: outputs.length ? "toolUse" : "stop",
			timestamp,
		},
		...outputs,
	];
}
async function project(
	display: Row,
	owner: CutoverOwner,
	descriptors: TranscriptPlan["descriptors"],
): Promise<Message[]> {
	const id = string(display.id),
		role = string(display.role),
		timestamp =
			typeof display.createdAt === "string"
				? new Date(display.createdAt).getTime()
				: 0;
	if (!Number.isFinite(timestamp)) fail("invalid message timestamp");
	if (!Array.isArray(display.parts)) fail("invalid parts");
	const content: (AssistantMessage["content"][number] | ImageContent)[] = [],
		outputs: ToolResultMessage[] = [];
	for (const raw of display.parts) {
		const part = object(raw),
			type = string(part.type);
		if (type === "step-start") continue;
		if (type === "text") {
			if (string(part.text).includes("[tedix-image:"))
				fail("reserved source image token");
			content.push({ type: "text", text: string(part.text) });
			continue;
		}
		if (role === "assistant" && type === "reasoning") {
			content.push({
				type: "thinking",
				thinking: string(part.text ?? part.reasoning ?? ""),
			});
			continue;
		}
		if (
			role === "assistant" &&
			(type.startsWith("tool-") || type === "dynamic-tool")
		) {
			if (part.state !== "output-available" && part.state !== "output-error")
				fail("unresolved tool effect");
			const name = string(part.toolName ?? type.slice(5)),
				call = string(part.toolCallId);
			const args = object(part.input);
			content.push({
				type: "toolCall",
				id: call,
				name,
				arguments: encoded(args) as Record<string, JsonValue>,
			});
			// Terminal UI errors carry errorText in the pinned AI SDK. Property
			// presence matters: null, false, zero and empty strings are real results.
			const hasOutput = Object.hasOwn(part, "output"),
				hasResult = Object.hasOwn(part, "result"),
				hasError = Object.hasOwn(part, "errorText");
			if (
				hasOutput &&
				hasResult &&
				JSON.stringify(part.output) !== JSON.stringify(part.result)
			)
				fail("conflicting tool result");
			let output = hasOutput ? part.output : part.result;
			if (hasError) {
				if (part.state !== "output-error" || typeof part.errorText !== "string")
					fail("conflicting tool result");
				if ((hasOutput || hasResult) && output !== part.errorText)
					fail("conflicting tool result");
				output = part.errorText;
			}
			if (output === undefined) fail("missing tool result");
			outputs.push({
				role: "toolResult",
				toolCallId: call,
				toolName: name,
				content: [
					{
						type: "text",
						text: typeof output === "string" ? output : JSON.stringify(output),
					},
				],
				isError: part.state === "output-error",
				timestamp,
			});
			continue;
		}
		if (role === "user" && type === "file") {
			const url = string(part.url),
				mediaType = string(part.mediaType);
			if (!mediaType.startsWith("image/")) fail("unsupported media");
			if (url.startsWith("data:")) {
				const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
				if (!match || match[1] !== mediaType || match[2]!.length % 4)
					fail("invalid inline image");
				content.push({ type: "image", mimeType: mediaType, data: match[2]! });
			} else {
				const parsed = new URL(url);
				if (
					!["http:", "https:", "tedix-r2:"].includes(parsed.protocol) ||
					parsed.username ||
					parsed.password ||
					url.length > 8192
				)
					fail("invalid image URL");
				if (parsed.protocol === "tedix-r2:") {
					const path = decodeURIComponent(parsed.pathname.slice(1)),
						prefix = `__runtime/workflow-images/${encodeURIComponent(owner.tediId)}/`,
						hash = parsed.searchParams.get("sha256");
					if (
						parsed.hostname !== "workflow-image" ||
						!path.startsWith(prefix) ||
						!hash ||
						!/^[a-f0-9]{64}$/.test(hash)
					)
						fail("foreign private image");
					const suffix = path.slice(prefix.length),
						slash = suffix.indexOf("/");
					if (
						slash < 1 ||
						suffix.slice(slash + 1) !== `${hash}.json` ||
						encodeURIComponent(decodeURIComponent(suffix.slice(0, slash))) !==
							suffix.slice(0, slash)
					)
						fail("noncanonical private image");
				}
				const descriptor: Descriptor = {
					...owner,
					messageId: id,
					partIndex: display.parts.indexOf(raw),
					url,
					mediaType,
					filename: typeof part.filename === "string" ? part.filename : "",
				};
				const token = await cutoverHash(descriptor);
				descriptors.push({ token, descriptor });
				content.push({ type: "text", text: `[tedix-image:${token}]` });
			}
			continue;
		}
		fail(`unsupported ${role} part ${type}`);
	}
	if (!content.length) fail("empty model contribution");
	if (role === "user") {
		if (content.some((part) => part.type !== "text" && part.type !== "image"))
			fail("invalid user contribution");
		return [
			{
				role: "user",
				content: content as Extract<Message, { role: "user" }>["content"],
				timestamp,
			},
		];
	}
	if (role === "system") {
		if (content.some((part) => part.type !== "text"))
			fail("invalid system contribution");
		return [
			{
				role: "system",
				content: content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("\n"),
				timestamp,
			},
		];
	}
	if (role !== "assistant") fail("unsupported role");
	return assistant(content as AssistantMessage["content"], outputs, timestamp);
}
function path(
	plan: Pick<TranscriptPlan, "nodes">,
	sessionId: string,
	leaf: string,
): TranscriptNode[] {
	const found = new Map(
		plan.nodes.filter((n) => n.sessionId === sessionId).map((n) => [n.id, n]),
	);
	const result: TranscriptNode[] = [],
		visited = new Set<string>();
	let id: string | null = leaf;
	while (id !== null) {
		if (visited.has(id)) fail("message cycle");
		visited.add(id);
		const node = found.get(id);
		if (!node) fail("missing parent");
		result.unshift(node);
		id = node.parentId;
	}
	return result;
}
function overlays(
	plan: Pick<TranscriptPlan, "nodes" | "compactions">,
	sessionId: string,
	leaf: string,
) {
	const visible = path(plan, sessionId, leaf).filter((n) => !n.hidden),
		selected: {
			from: string;
			to: string;
			summary: string;
			createdAt: number;
		}[] = [];
	for (let i = 0; i < visible.length; i++) {
		const compact = plan.compactions
			.filter(
				(c) =>
					c.sessionId === sessionId &&
					c.from === visible[i]!.id &&
					visible.findIndex((n) => n.id === c.to) >= i,
			)
			.at(-1);
		if (compact) {
			selected.push(compact);
			i = visible.findIndex((n) => n.id === compact.to);
		}
	}
	return { visible, selected };
}
export function projectedTranscriptContext(
	plan: Pick<TranscriptPlan, "nodes" | "compactions">,
	sessionId: string,
	leaf: string,
): Message[] {
	const { visible, selected } = overlays(plan, sessionId, leaf),
		result: Message[] = [];
	for (let i = 0; i < visible.length; i++) {
		const compact = selected.find((c) => c.from === visible[i]!.id);
		if (compact) {
			result.push(
				...assistant(
					[{ type: "text", text: compact.summary }],
					[],
					compact.createdAt,
				),
			);
			i = visible.findIndex((n) => n.id === compact.to);
		} else result.push(...visible[i]!.model);
	}
	return result;
}
function comparable(messages: readonly Message[]): unknown {
	return messages.map((message) => {
		const value = { ...message } as Record<string, unknown>;
		delete value.timestamp;
		if (value.role === "assistant") {
			delete value.model;
			delete value.usage;
		}
		return value;
	});
}
/** Read-only source admission. No SDK capability construction, DDL, dispatch, repair or R2 fetch. */
export async function planPiTranscriptCutover(
	storage: DurableObjectStorage,
	owner: CutoverOwner,
	prefix = "pi_",
): Promise<TranscriptPlan> {
	const inventory = await inventoryPiStateCutover(storage);
	if (inventory.blocked) fail("unresolved source receipts");
	if (
		inventory.storedOwner.unknown ||
		inventory.storedOwner.tediId !== owner.tediId ||
		inventory.storedOwner.orgId !== owner.orgId
	)
		fail("stored ownership mismatch");
	const names = tables(storage);
	nativeIdle(storage, prefix, names);
	const raw = Object.fromEntries(
		SOURCE_TABLES.map((table) => [table, rows(storage, table, names)]),
	) as Record<(typeof SOURCE_TABLES)[number], Row[]>;
	const evidence: [string, unknown][] = [];
	for (const stem of ["think-accounting:", "pi-accounting:"]) {
		let startAfter: string | undefined;
		do {
			const page = await storage.list({ prefix: stem, limit: 100, startAfter });
			for (const [id, value] of page) {
				if (stem.includes("accounting")) {
					const journal = object(value);
					if (
						journal.version !== 1 ||
						journal.runId !== id.slice(stem.length) ||
						journal.fault !== null ||
						journal.receiptFault === true ||
						!Array.isArray(journal.attempts) ||
						journal.attempts.some((a) => {
							const attempt = object(a);
							return (
								attempt.phase !== "completed" ||
								attempt.acknowledged !== true ||
								(attempt.effectsStarted === true &&
									attempt.effectsSealed !== true)
							);
						})
					)
						fail("unresolved accounting effects");
				}
				evidence.push([id, encoded(value)]);
			}
			startAfter = page.size === 100 ? [...page.keys()].at(-1) : undefined;
		} while (startAfter);
	}
	const descriptors: TranscriptPlan["descriptors"] = [],
		nodes: TranscriptNode[] = [];
	const attachmentBytes = new Map<string, Uint8Array>();
	for (const meta of raw.cf_agents_session_attachment_meta) {
		const hash = string(meta.hash),
			parts = raw.cf_agents_session_attachment_chunks
				.filter((row) => row.hash === hash)
				.sort((a, b) => integer(a.idx) - integer(b.idx));
		if (
			parts.length !== integer(meta.chunks) ||
			parts.some((part, i) => part.idx !== i)
		)
			fail("missing attachment chunks");
		const bytes = Uint8Array.from(
			parts.flatMap((part) => {
				const data = object(part.data);
				if (
					!Array.isArray(data.bytes) ||
					data.bytes.some(
						(b) => !Number.isInteger(b) || Number(b) < 0 || Number(b) > 255,
					)
				)
					fail("invalid attachment bytes");
				return data.bytes as number[];
			}),
		);
		if (
			bytes.length !== integer(meta.bytes) ||
			(await digestBytes(bytes)) !== hash
		)
			fail("attachment integrity mismatch");
		attachmentBytes.set(hash, bytes);
	}
	function hydrate(value: JsonValue): JsonValue {
		if (!value || typeof value !== "object") return value;
		if (Array.isArray(value)) return value.map(hydrate);
		const pointer =
			typeof value.url === "string"
				? "url"
				: typeof value.data === "string"
					? "data"
					: null;
		if (pointer && String(value[pointer]).startsWith("attachment:sha256:")) {
			const hash = String(value[pointer]).slice("attachment:sha256:".length),
				bytes = attachmentBytes.get(hash),
				meta = raw.cf_agents_session_attachment_meta.find(
					(row) => row.hash === hash,
				);
			if (!bytes || !meta) fail("missing attachment payload");
			let binary = "";
			for (const byte of bytes) binary += String.fromCharCode(byte);
			return {
				...value,
				[pointer]:
					pointer === "url"
						? `data:${string(meta.media_type)};base64,${btoa(binary)}`
						: btoa(binary),
			};
		}
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, hydrate(v)]),
		);
	}
	const compactions: TranscriptCompaction[] = raw.cf_agents_session_compactions
		.map((row) => ({
			sessionId: string(row.session_id),
			id: string(row.id),
			seq: integer(row.seq),
			from: string(row.from_message_id),
			to: string(row.to_message_id),
			summary: string(row.summary),
			createdAt: integer(row.created_at),
		}))
		.sort((a, b) => a.seq - b.seq);
	for (const row of raw.cf_agents_session_messages) {
		const sessionId = string(row.session_id),
			id = string(row.id),
			continuation = raw.cf_agents_session_message_chunks
				.filter((part) => part.session_id === sessionId && part.id === id)
				.sort((a, b) => integer(a.idx) - integer(b.idx));
		if (
			continuation.length !== integer(row.content_chunks) ||
			continuation.some((part, i) => part.idx !== i)
		)
			fail("missing message chunks");
		const json =
				string(row.content) +
				continuation.map((part) => string(part.content)).join(""),
			parsed = object(parse(json));
		if (parsed.id !== id || parsed.role !== row.role)
			fail("message identity mismatch");
		const display = hydrate(encoded(parsed)) as Row;
		// Stored timestamp is authoritative; SDK's synthetic summary Date must never enter a source hash.
		display.createdAt = new Date(integer(row.created_at)).toISOString();
		const hidden =
			id.startsWith("compaction_") &&
			compactions.some(
				(c) => c.sessionId === sessionId && `compaction_${c.id}` === id,
			);
		nodes.push({
			sessionId,
			id,
			parentId: row.parent_id === null ? null : string(row.parent_id),
			seq: integer(row.seq),
			display,
			model: (await project(display, owner, descriptors)).filter(() => !hidden),
			hidden,
		});
	}
	const identities = new Set(nodes.map((n) => key(n.sessionId, n.id)));
	if (identities.size !== nodes.length) fail("duplicate source identity");
	for (const ref of raw.cf_agents_session_attachment_refs)
		if (
			!identities.has(key(string(ref.session_id), string(ref.message_id))) ||
			!attachmentBytes.has(string(ref.hash))
		)
			fail("orphan attachment reference");
	const sessions: TranscriptSession[] = [];
	for (const sessionId of [
		...new Set([
			...nodes.map((n) => n.sessionId),
			...raw.cf_agents_session_config.map((row) => string(row.session_id)),
		]),
	].sort()) {
		const members = nodes
			.filter((n) => n.sessionId === sessionId)
			.sort((a, b) => a.seq - b.seq);
		if (new Set(members.map((n) => n.seq)).size !== members.length)
			fail("duplicate sequence");
		const leaves = members
				.filter((n) => !members.some((child) => child.parentId === n.id))
				.map((n) => n.id),
			roots = members.filter((n) => n.parentId === null).map((n) => n.id);
		if (!members.length) {
			sessions.push({ id: sessionId, roots: [], leaves: [], activeLeaf: null });
			continue;
		}
		if (!roots.length || !leaves.length) fail("cyclic source graph");
		for (const member of members) {
			path({ nodes }, sessionId, member.id);
			if (
				member.parentId !== null &&
				members.find((parent) => parent.id === member.parentId)!.seq >=
					member.seq
			)
				fail("invalid parent sequence");
		}
		sessions.push({
			id: sessionId,
			roots,
			leaves,
			activeLeaf: members.at(-1)!.id,
		});
	}
	for (const compact of compactions) {
		if (
			!identities.has(key(compact.sessionId, compact.from)) ||
			!identities.has(key(compact.sessionId, compact.to)) ||
			!path({ nodes }, compact.sessionId, compact.to).some(
				(n) => n.id === compact.from,
			)
		)
			fail("invalid compaction span");
	}
	const priorNativeConversations = rows(
		storage,
		`${prefix}conversations`,
		names,
	).map((row) => integer(row.id));
	const priorEntries = rows(storage, `${prefix}entries`, names).map((row) =>
		object(parse(string(row.record))),
	);
	for (const { token, descriptor } of descriptors) {
		const existing = await storage.get(`pi-image-projection:v1:${token}`);
		if (
			existing !== undefined &&
			JSON.stringify(existing) !== JSON.stringify(descriptor)
		)
			fail("stored descriptor conflict");
	}
	const planBase = {
		version: 1 as const,
		imagePolicy: "current-turn" as const,
		owner,
		prefix,
		nodes,
		sessions,
		compactions,
		descriptors,
		priorNativeConversations,
	};
	const facetMarker = await storage.get<unknown>("cf_agents_is_facet");
	const privateFacet = facetMarker === true;
	const storedPointer = await storage.get<number>(
		"pi-active-conversation-id:v1",
	);
	// A root may own only private cognitive facets. Its local transcript is then
	// genuinely empty, not an implicit default session or an unverified native graph.
	let emptyRoot: Record<string, unknown> | undefined;
	if (!sessions.length) {
		const facetName = await storage.get<unknown>("cf_agents_facet_name");
		const facetParentPath = await storage.get<unknown>("cf_agents_parent_path");
		if (
			(facetMarker !== undefined && facetMarker !== false) ||
			facetName !== undefined ||
			facetParentPath !== undefined ||
			SOURCE_TABLES.some((table) => raw[table].length !== 0) ||
			nodes.length ||
			compactions.length ||
			descriptors.length ||
			priorNativeConversations.length ||
			priorEntries.length ||
			storedPointer !== undefined
		)
			fail("empty transcript is not a verified empty root");
		emptyRoot = {
			facetMarker: facetMarker === false ? false : "absent",
			facetName: "absent",
			facetParentPath: "absent",
			storedPointer: "absent",
			priorNativeConversations: [],
			priorEntries: [],
		};
	}
	const originalPointer =
		storedPointer ?? (priorNativeConversations.includes(1) ? 1 : null);
	if (
		privateFacet &&
		originalPointer !== null &&
		(!Number.isSafeInteger(originalPointer) ||
			!priorNativeConversations.includes(originalPointer))
	)
		fail("original native active pointer is unknown");
	// Prior native rows are immutable: admit only a proven imported active context, not cognitive output.
	for (const conversationId of priorNativeConversations) {
		const own = priorEntries.filter(
			(entry) => entry.conversationId === conversationId,
		);
		if (!own.length) continue;
		if (
			own.some(
				(entry) =>
					entry.kind !== "tedix.legacy-message" &&
					entry.kind !== "tedix.transcript.message" &&
					entry.kind !== "tedix.transcript.context",
			)
		)
			fail("existing native cognition requires reconciliation");
		if (
			own.some(
				(entry) =>
					typeof entry.kind === "string" &&
					entry.kind.startsWith("tedix.transcript."),
			)
		)
			continue; // Verified by the immutable native mapping document during apply.
		const model = own
			.sort((a, b) => integer(a.id) - integer(b.id))
			.flatMap((entry) =>
				Array.isArray(entry.model) ? (entry.model as unknown as Message[]) : [],
			);
		const normalized = JSON.parse(JSON.stringify(model)) as Message[];
		// Old descriptor tokens may include a removed policy discriminator; compare logical contribution.
		for (const message of normalized)
			if (Array.isArray(message.content))
				for (const part of message.content)
					if (part.type === "text") {
						const match = /^\[tedix-image:([a-f0-9]{64})\]$/.exec(part.text);
						if (match) {
							const original = object(
								await storage.get(`pi-image-projection:v1:${match[1]}`),
							);
							const descriptor = descriptors.find(
								(d) =>
									d.descriptor.messageId === original.messageId &&
									d.descriptor.partIndex === original.partIndex &&
									d.descriptor.url === original.url &&
									d.descriptor.mediaType === original.mediaType &&
									d.descriptor.filename === original.filename &&
									original.tediId === owner.tediId &&
									original.orgId === owner.orgId,
							);
							if (!descriptor) fail("existing image conflict");
							part.text = `[tedix-image:${descriptor.token}]`;
						}
					}
		if (
			!sessions.some(
				(session) =>
					(!privateFacet ||
						conversationId !== originalPointer ||
						session.id === "") &&
					session.activeLeaf !== null &&
					JSON.stringify(
						comparable(
							projectedTranscriptContext(
								planBase,
								session.id,
								session.activeLeaf!,
							),
						),
					) === JSON.stringify(comparable(normalized)),
			)
		)
			fail("existing native imported context conflict");
	}
	const source = JSON.stringify({
		imagePolicy: "current-turn",
		owner,
		raw,
		evidence,
		...(emptyRoot ? { emptyRoot } : {}),
	});
	const chunks: TranscriptPlan["chunks"] = [];
	for (let offset = 0; offset < source.length; offset += 32768) {
		const text = source.slice(offset, offset + 32768);
		chunks.push({ sha256: await cutoverHash(text), text });
	}
	return {
		...planBase,
		sourceHash: await cutoverHash({
			imagePolicy: "current-turn",
			owner,
			chunks: chunks.map((c) => c.sha256),
		}),
		chunks,
	};
}
/** No activation, deletion, scheduling or model execution. Caller must quarantine ordinary writers. */
export async function applyPiTranscriptCutover(
	storage: DurableObjectStorage,
	plan: TranscriptPlan,
): Promise<TranscriptResult> {
	const previous = line.get(storage) ?? Promise.resolve();
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	line.set(storage, pending);
	await previous;
	try {
		return await applyOnLine(storage, plan);
	} finally {
		release();
		if (line.get(storage) === pending) line.delete(storage);
	}
}
async function applyOnLine(
	storage: DurableObjectStorage,
	plan: TranscriptPlan,
): Promise<TranscriptResult> {
	const fresh = await planPiTranscriptCutover(storage, plan.owner, plan.prefix);
	if (
		fresh.sourceHash !== plan.sourceHash ||
		JSON.stringify({ ...fresh, priorNativeConversations: [] }) !==
			JSON.stringify({ ...plan, priorNativeConversations: [] })
	)
		fail("source or plan changed");
	for (const chunk of plan.chunks)
		if ((await cutoverHash(chunk.text)) !== chunk.sha256)
			fail("manifest chunk mismatch");
	// No write occurs before complete graph, ownership, receipts and native work preflight.
	const native = await openPiSessionStore(storage, { prefix: plan.prefix }),
		session = createSession(native);
	try {
		let result = await session.commit(async (tx) => {
			const mapping = await tx.doc(Maps);
			if (mapping.sourceHash) {
				if (mapping.sourceHash !== plan.sourceHash)
					fail("immutable native manifest changed");
				return JSON.parse(mapping.result) as TranscriptResult;
			}
			const initial: TranscriptResult = {
				sourceHash: plan.sourceHash,
				entries: {},
				leaves: {},
				activeConversations: {},
				contexts: {},
				preservedNativeConversations: plan.priorNativeConversations,
			};
			for (const chunk of plan.chunks) {
				const stored = await tx.doc(SourceChunks, chunk.sha256, chunk.text);
				if (stored.text !== chunk.text) fail("stored source chunk conflict");
			}
			mapping.sourceHash = plan.sourceHash;
			mapping.result = JSON.stringify(initial);
			return initial;
		}, CONTEXT);
		for (const chunk of plan.chunks) {
			const retained = await session.snapshot(
				SourceChunks,
				chunk.sha256,
				CONTEXT,
			);
			if (!retained || retained.text !== chunk.text)
				fail("retained source manifest conflict");
		}
		const locations = new Map<
			string,
			{ conversationId: ConversationId; entryId: EntryId }
		>();
		// Verify the complete retained mapping before resuming any partial graph.
		for (const node of plan.nodes) {
			const id = result.entries[key(node.sessionId, node.id)];
			if (id === undefined) continue;
			const entry = (await native.entry(id as EntryId, CONTEXT))?.entry;
			if (
				!entry ||
				entry.kind !== "tedix.transcript.message" ||
				JSON.stringify(entry.model) !== JSON.stringify(node.model) ||
				JSON.stringify(entry.data) !==
					JSON.stringify({
						sourceSession: node.sessionId,
						originalId: node.id,
						originalRole: string(node.display.role),
						sourceHash: plan.sourceHash,
						display: node.display,
					})
			)
				fail("retained graph entry conflict");
			const displayKey = `${plan.prefix === "pi_" ? "pi-ui-entry:" : `${plan.prefix}ui-entry:`}${id}`;
			const retainedDisplay = await storage.get(displayKey);
			if (
				retainedDisplay !== undefined &&
				JSON.stringify(retainedDisplay) !== JSON.stringify(node.display)
			)
				fail("stored display conflict");
			locations.set(key(node.sessionId, node.id), {
				conversationId: entry.conversationId,
				entryId: entry.id,
			});
		}
		async function initialize(
			tx: Parameters<Parameters<typeof session.commit>[0]>[0],
			conversationId: ConversationId,
			independent: boolean,
		) {
			await tx.doc(LiveDoc, conversationId);
			await tx.doc(InboxDoc, conversationId);
			await tx.doc(UsageDoc, conversationId);
			await tx.doc(ProviderDoc, conversationId);
			if (independent) await tx.doc(AgentDoc, conversationId);
		}
		for (const sourceSession of plan.sessions)
			if (
				!sourceSession.leaves.length &&
				result.activeConversations[sourceSession.id] === undefined
			)
				await session.commit(async (tx) => {
					const conversation = await tx.createConversation({
						ownership: { kind: "ownerless" },
					});
					await initialize(tx, conversation.id, true);
					result.activeConversations[sourceSession.id] = conversation.id;
					const mapping = await tx.doc(Maps);
					mapping.result = JSON.stringify(result);
				}, CONTEXT);
		for (const sourceSession of plan.sessions)
			for (const leaf of sourceSession.leaves) {
				for (const node of path(plan, sourceSession.id, leaf)) {
					const identity = key(node.sessionId, node.id);
					if (locations.has(identity)) continue;
					const parent =
						node.parentId === null
							? undefined
							: locations.get(key(node.sessionId, node.parentId));
					// Public native forks read committed parent documents, so each node and its mapping share one commit.
					const location = await session.commit(async (tx) => {
						let conversationId: ConversationId;
						if (parent) {
							const tail = await tx.scanEntries(
								{ conversationId: parent.conversationId },
								1,
							);
							if (tail.items[0]?.id === parent.entryId)
								conversationId = parent.conversationId;
							else {
								conversationId = (
									await tx.forkConversation(
										parent.conversationId,
										parent.entryId,
										{ ownership: { kind: "ownerless" } },
									)
								).id;
								await initialize(tx, conversationId, false);
							}
						} else {
							conversationId = (
								await tx.createConversation({
									ownership: { kind: "ownerless" },
								})
							).id;
							await initialize(tx, conversationId, true);
						}
						const entry = await tx.appendEntry(conversationId, {
							kind: "tedix.transcript.message",
							model: node.model,
							data: {
								sourceSession: node.sessionId,
								originalId: node.id,
								originalRole: string(node.display.role),
								sourceHash: plan.sourceHash,
								display: node.display,
							},
						});
						result.entries[identity] = entry.id;
						const mapping = await tx.doc(Maps);
						mapping.result = JSON.stringify(result);
						return { conversationId, entryId: entry.id };
					}, CONTEXT);
					locations.set(identity, location);
				}
				const leafKey = key(sourceSession.id, leaf),
					location = locations.get(leafKey)!;
				const { visible, selected } = overlays(plan, sourceSession.id, leaf);
				const edits: NonNullable<EntryDraft["edits"]>[number][] = [];
				for (const compact of selected) {
					let covered = false;
					for (const node of visible) {
						if (node.id === compact.from) {
							covered = true;
							edits.push({
								target: locations.get(key(node.sessionId, node.id))!.entryId,
								action: "replace",
								messages: assistant(
									[{ type: "text", text: compact.summary }],
									[],
									compact.createdAt,
								),
							});
						} else if (covered)
							edits.push({
								target: locations.get(key(node.sessionId, node.id))!.entryId,
								action: "omit",
							});
						if (node.id === compact.to) break;
					}
				}
				const draft = {
					kind: "tedix.transcript.context",
					edits,
					data: {
						sourceSession: sourceSession.id,
						sourceLeaf: leaf,
						sourceHash: plan.sourceHash,
					},
				};
				const prior = result.contexts[leafKey];
				if (prior !== undefined) {
					const entry = (await native.entry(prior as EntryId, CONTEXT))?.entry;
					if (
						!entry ||
						entry.conversationId !== location.conversationId ||
						JSON.stringify({
							kind: entry.kind,
							edits: entry.edits,
							data: entry.data,
						}) !== JSON.stringify(draft)
					)
						fail("retained context conflict");
				} else
					await session.commit(async (tx) => {
						const entry = await tx.appendEntry(location.conversationId, draft);
						result.contexts[leafKey] = entry.id;
						result.leaves[leafKey] = location.conversationId;
						if (leaf === sourceSession.activeLeaf)
							result.activeConversations[sourceSession.id] =
								location.conversationId;
						const mapping = await tx.doc(Maps);
						mapping.result = JSON.stringify(result);
					}, CONTEXT);
			}

		for (const { token, descriptor } of plan.descriptors) {
			const id = `pi-image-projection:v1:${token}`,
				existing = await storage.get(id);
			if (
				existing !== undefined &&
				JSON.stringify(existing) !== JSON.stringify(descriptor)
			)
				fail("stored descriptor conflict");
			await storage.put(id, descriptor);
		}
		for (const node of plan.nodes) {
			const id = `${plan.prefix === "pi_" ? "pi-ui-entry:" : `${plan.prefix}ui-entry:`}${result.entries[key(node.sessionId, node.id)]}`,
				existing = await storage.get(id);
			if (
				existing !== undefined &&
				JSON.stringify(existing) !== JSON.stringify(node.display)
			)
				fail("stored display conflict");
			await storage.put(id, node.display);
		}
		return result;
	} finally {
		await session.close(CONTEXT);
	}
}
