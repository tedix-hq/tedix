import { ChatStreamHub } from "../src/chat-stream-hub";
import { AgentTediDO } from "../src/do";

/**
 * An `AgentTediDO` for plain-bun behaviour tests, built without the Agents SDK
 * constructor. The prototype supplies the real methods under test; the caller
 * supplies only the state and collaborators that method reads (`env`, `state`,
 * stubbed sibling methods). Private members are reachable at runtime, so the
 * probe is typed loosely.
 */
export type TediDoProbe = Record<string, any>;

/** Explicit unit-only admission double. It proves no tenant custody or native persistence. */
export function unitRuntimeAdmission(ownerInput: {
	tediId: string | null;
	orgId: string | null;
}) {
	const owner = Object.freeze({ ...ownerInput });
	const claims = new Map<string, Record<string, any>>();
	const inputs = new Map<string, string>();
	const receipts = new Map<string, string>();
	let state = "active";
	const generation = 1;
	const encode = (value: unknown): string => {
		const sorted = (v: unknown): unknown => {
			if (v === null || typeof v === "boolean" || typeof v === "string")
				return v;
			if (typeof v === "number" && Number.isFinite(v)) return v;
			if (Array.isArray(v)) return v.map(sorted);
			if (v && typeof v === "object")
				return Object.fromEntries(
					Object.keys(v)
						.sort()
						.map((k) => [k, sorted((v as Record<string, unknown>)[k])]),
				);
			throw new Error("Unit admission input missing or invalid");
		};
		const result = JSON.stringify(sorted(value));
		if (result === undefined) throw new Error("Unit admission input missing");
		return result;
	};
	const hash = async (value: unknown) =>
		Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(encode(value)),
				),
			),
		)
			.map((n) => n.toString(16).padStart(2, "0"))
			.join("");
	const original = (input: {
		runId: string;
		sessionKey?: string;
		input?: unknown;
		principalId?: string;
		inputHash?: string;
	}) => {
		const claim = claims.get(input.runId);
		if (
			!claim ||
			(input.sessionKey !== undefined &&
				claim.sessionKey !== input.sessionKey) ||
			(input.principalId !== undefined &&
				claim.principalId !== input.principalId) ||
			(input.inputHash !== undefined && claim.inputHash !== input.inputHash) ||
			(Object.hasOwn(input, "input") &&
				inputs.get(input.runId) !== encode(input.input))
		)
			throw new Error("Unit original admission identity changed or missing");
		return { ...claim };
	};
	return {
		owner,
		read: () => ({ state, generation, owner }),
		gate: {
			assertTurn(input: {
				turnId: string;
				generation: number;
				requestHash: string;
			}) {
				const c = claims.get(input.turnId);
				if (
					!c ||
					state !== "active" ||
					c.terminal ||
					c.generation !== input.generation ||
					c.requestHash !== input.requestHash
				)
					throw new Error("Unit original turn dispatch inactive or changed");
				return { ...c };
			},
			claim: (runId: string) => {
				const c = claims.get(runId);
				return c ? { ...c } : null;
			},
			completeTurn: (input: {
				turnId: string;
				generation: number;
				requestHash: string;
			}) => {
				const c = claims.get(input.turnId);
				if (
					!c ||
					c.generation !== input.generation ||
					c.requestHash !== input.requestHash ||
					!receipts.has(input.turnId)
				)
					throw new Error("Unit completion lacks original receipt");
				c.terminal = true;
				c.status = "completed";
			},
			quarantine: () => {
				state = "quarantined";
			},
		},
		async beginAcceptedTurn(input: {
			runId: string;
			sessionKey: string;
			principalId: string;
			input: unknown;
			expectedGeneration: number;
		}) {
			if (
				state !== "active" ||
				input.expectedGeneration !== generation ||
				!input.runId ||
				!input.sessionKey ||
				typeof input.principalId !== "string" ||
				!input.principalId
			)
				throw new Error("Unit admission inactive or invalid");
			const encoded = encode(input.input),
				prior = claims.get(input.runId);
			if (
				prior &&
				(inputs.get(input.runId) !== encoded ||
					prior.sessionKey !== input.sessionKey ||
					prior.principalId !== input.principalId)
			)
				throw new Error("Unit accepted input changed");
			const digest = await hash(input.input);
			if (state !== "active")
				throw new Error("Unit admission inactive after input digest");
			const claim = prior ?? {
				owner,
				runId: input.runId,
				turnId: input.runId,
				sessionKey: input.sessionKey,
				principalId: input.principalId,
				inputHash: digest,
				requestHash: digest,
				generation,
				status: "running",
			};
			claims.set(input.runId, claim);
			inputs.set(input.runId, encoded);
			return { accepted: { ...claim } };
		},
		async assertOriginalClaim(input: {
			runId: string;
			sessionKey?: string;
			input?: unknown;
			principalId?: string;
			inputHash?: string;
		}) {
			return original(input);
		},
		async assertAcceptedTurn(input: {
			runId: string;
			sessionKey?: string;
			input?: unknown;
			principalId?: string;
			inputHash?: string;
		}) {
			const c = original(input);
			if (state !== "active" || c.terminal)
				throw new Error("Unit dispatch inactive");
			return c;
		},
		assertAcceptedTurnSync(input: {
			runId: string;
			expected?: Record<string, any>;
		}) {
			const c = original({ runId: input.runId });
			if (
				state !== "active" ||
				c.terminal ||
				(input.expected && encode(c) !== encode(input.expected))
			)
				throw new Error(
					"Unit synchronous accepted identity changed or inactive",
				);
			return c;
		},
		async recordTerminalReceipt(runId: string, receipt: unknown) {
			const c = original({ runId }),
				encoded = encode(receipt),
				prior = receipts.get(runId);
			if (prior !== undefined && prior !== encoded)
				throw new Error("Unit terminal receipt changed");
			receipts.set(runId, encoded);
			return c;
		},
		async prepareEvidence(action: string, input?: unknown) {
			return hash({ action, input: input ?? null });
		},
	};
}

/** Prototype-only unit collaborator: no native storage, custody or replay enforcement is proved. */
export function unitHistoricalExecution() {
	return { assertRun(_runId: string | null | undefined): void {} };
}

export function tediDo(fields: Record<string, unknown> = {}): TediDoProbe {
	const probe = Object.create(AgentTediDO.prototype) as TediDoProbe;
	const fixtureState = (fields.state ?? { tediId: "unit-only-principal" }) as {
		tediId?: string;
		orgId?: string;
	};
	// Only the fixture supplies tenant identity; absent organization stays null.
	const admission = unitRuntimeAdmission({
		tediId: fixtureState.tediId ?? null,
		orgId: fixtureState.orgId ?? null,
	});
	// Agents 0.25 starts the lifecycle before entering wrapped async methods.
	// These prototype-only probes deliberately skip the SDK constructor.
	for (const [key, value] of Object.entries({
		lifecycle: { isStarted: () => true },
		// A unit label only; no canonical tenant or physical custody is asserted.
		state: fixtureState,
		runtimeAdmission: () => admission,
		historicalExecution: () => unitHistoricalExecution(),
		...fields,
		ctx:
			fields.ctx && (fields.ctx as { storage?: unknown }).storage
				? fields.ctx
				: { storage: memoryStorage(), ...(fields.ctx as object) },
	})) {
		Object.defineProperty(probe, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return probe;
}

/**
 * Use real admission and historical execution guards against the supplied storage owner. Passing a
 * Workerd state proves native SQL/KV behavior without starting Agent lifecycle;
 * passing memoryStorage does not supply native admission evidence.
 */
export function admittedTediDo(
	ctx: DurableObjectState,
	state: { tediId: string; orgId: string },
): TediDoProbe {
	return tediDo({
		ctx,
		state,
		runtimeAdmission: (AgentTediDO.prototype as TediDoProbe).runtimeAdmission,
		historicalExecution: (AgentTediDO.prototype as TediDoProbe)
			.historicalExecution,
	});
}

/** An in-memory `ctx.storage` (the KV subset the DO uses), with a write log. */
export function memoryStorage(initial: Record<string, unknown> = {}) {
	const data = new Map<string, unknown>(Object.entries(initial));
	const writes: Array<{ op: "put" | "delete"; key: string }> = [];
	let transactionTail: Promise<unknown> = Promise.resolve();
	return {
		async transaction<T>(callback: (storage: any) => Promise<T>): Promise<T> {
			const next = transactionTail.then(() => callback(this));
			transactionTail = next.catch(() => undefined);
			return next;
		},
		data,
		writes,
		// Native sync KV and async storage share the same live owner/receipt map.
		// This source double supplies API parity, not SQLite or custody proof.
		kv: {
			get<T>(key: string): T | undefined {
				return data.get(key) as T | undefined;
			},
			put(key: string, value: unknown): void {
				writes.push({ op: "put", key });
				data.set(key, value);
			},
			delete(key: string): boolean {
				writes.push({ op: "delete", key });
				return data.delete(key);
			},
			list<T>(options: { prefix?: string } = {}): Map<string, T> {
				return new Map(
					[...data].filter(
						([key]) => !options.prefix || key.startsWith(options.prefix),
					),
				) as Map<string, T>;
			},
		},
		async get<T>(key: string): Promise<T | undefined> {
			return data.get(key) as T | undefined;
		},
		async put(key: string, value: unknown): Promise<void> {
			writes.push({ op: "put", key });
			data.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			writes.push({ op: "delete", key });
			return data.delete(key);
		},
		async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
			const out = new Map<string, T>();
			for (const [key, value] of data) {
				if (!options.prefix || key.startsWith(options.prefix))
					out.set(key, value as T);
			}
			return out;
		},
	};
}

/** Parse an SSE body into its `data:` frames. */
export function sseFrames(body: string): Array<Record<string, unknown>> {
	return body
		.split("\n\n")
		.map((event) =>
			event
				.split("\n")
				.find((line) => line.startsWith("data: "))
				?.slice("data: ".length),
		)
		.filter((data): data is string => Boolean(data))
		.map((data) => JSON.parse(data) as Record<string, unknown>);
}

export interface FacetStreamInput {
	system: string;
	tools: Record<string, unknown>;
	userText: string;
	onDelta: (text: string) => void;
	onChunk: (body: string) => void;
	[key: string]: unknown;
}

/**
 * Replace every native tool-family builder with one marker tool named after
 * the builder, so a test can see which families reached a turn.
 */
export function nativeToolMarkers(): Record<
	string,
	() => Record<string, unknown>
> {
	const marker = (name: string) => () => ({ [name]: { marker: name } });
	return Object.fromEntries(
		[
			"workspaceAiTools",
			"browserAiTools",
			"skillReadTool",
			"durableCodemodeAiTools",
			"cronAiTool",
			"workstationAiTool",
			"objectStoreAiTools",
			"r2SqlAiTool",
		].map((name) => [name, marker(name)]),
	);
}

/**
 * A DO wired for one `streamChatTurn`: a real `ChatStreamHub`, a recording
 * session harness and background queue, a facet turn the test scripts, and
 * {@link nativeToolMarkers} for the native tool families.
 */
export function chatTurnProbe(options: {
	facetTurn?: (input: FacetStreamInput) => Promise<Record<string, unknown>>;
	mcpRuntime?: Record<string, unknown> | null;
	platform?: Record<string, unknown> | null;
	fields?: Record<string, unknown>;
}) {
	const pending: Promise<unknown>[] = [];
	const appended: Array<{ sessionKey: string; turn: unknown; key: string }> =
		[];
	const queued: Array<{ callback: string; payload: unknown }> = [];
	const facetInputs: FacetStreamInput[] = [];
	const agent = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme", systemPrompt: "SYSTEM" },
		ctx: {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			},
		},
		activeTurnBinding: null,
		async ensureIdentity() {},
		sessionHarness: {
			async appendTurn(sessionKey: string, turn: unknown, key: string) {
				appended.push({ sessionKey, turn, key });
				return true;
			},
		},
		async getMcpRuntime() {
			return options.mcpRuntime ?? null;
		},
		async getPlatformClient() {
			return options.platform ?? null;
		},
		...nativeToolMarkers(),
		async cognitiveAddenda() {
			return "";
		},
		clearActiveTurn() {
			agent.activeTurnBinding = null;
		},
		effectiveStepCeiling: () => 8,
		async streamConversationFacetTurn(input: FacetStreamInput) {
			facetInputs.push(input);
			return options.facetTurn
				? options.facetTurn(input)
				: { assistantText: "" };
		},
		async dispatchTurnMemoryEffects() {},
		async queue(callback: string, payload: unknown) {
			queued.push({ callback, payload });
			return "queued";
		},
		enqueueCompaction() {},
		...options.fields,
	});
	return {
		agent,
		appended,
		queued,
		facetInputs,
		/** Stream one turn and wait for its background pump to settle. */
		async run(input: Record<string, unknown>) {
			agent.chatStreamHub ??= new ChatStreamHub();
			const response = (await agent.streamChatTurn({
				sessionKey: "main",
				clientRequestId: "req-1",
				...input,
			})) as Response;
			const body = response.text();
			await Promise.allSettled(pending);
			return { response, frames: sseFrames(await body) };
		},
	};
}

/**
 * A DO wired for `prepareMcpFacetTurn`, the tool/system composition shared by
 * every MCP, workflow and mesh facet turn. Native tool families are markers.
 */
export function mcpFacetTurnProbe(
	options: {
		mcpRuntime?: Record<string, unknown> | null;
		platform?: Record<string, unknown> | null;
		fields?: Record<string, unknown>;
	} = {},
) {
	return tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme", systemPrompt: "SYSTEM" },
		async getMcpRuntime() {
			return options.mcpRuntime ?? null;
		},
		async getPlatformClient() {
			return options.platform ?? null;
		},
		...nativeToolMarkers(),
		async cognitiveAddenda() {
			return "";
		},
		...options.fields,
	});
}

/** The canonical input `prepareMcpFacetTurn` receives for a plain turn. */
export const MCP_FACET_TURN_INPUT = {
	sessionKey: "main",
	userMessage: "hello",
	conversationId: "conversation",
	runId: "tedi-1:mcp:req-1",
};

/**
 * A DO wired for `runFacetWorkflowTurnImpl`, the durable workflow turn: MCP
 * setup and the conversation facet are scripted, commits are recorded.
 */
export function facetWorkflowTurnProbe(
	options: {
		facetTurn?: (
			input: Record<string, unknown>,
		) => Promise<Record<string, unknown>>;
		fields?: Record<string, unknown>;
	} = {},
) {
	const facetInputs: Array<Record<string, unknown>> = [];
	const commits: Array<Record<string, unknown>> = [];
	const prepared: Array<Record<string, unknown>> = [];
	const appends: Array<{
		sessionKey: string;
		turn: Record<string, unknown>;
		key: string;
	}> = [];
	const order: string[] = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		activeTurnBinding: null,
		async ensureIdentity() {},
		async ensureModelPolicy() {},
		logDanglingTurnIfAny() {},
		sessionHarness: {
			async appendTurn(
				sessionKey: string,
				turn: Record<string, unknown>,
				key: string,
			) {
				appends.push({ sessionKey, turn, key });
				order.push(`append:${turn.role}:${key}`);
				return true;
			},
		},
		async prepareMcpFacetTurn(input: Record<string, unknown>) {
			prepared.push(input);
			return { system: "SYSTEM", tools: {}, turnBinding: null };
		},
		async runConversationFacetTurn(input: Record<string, unknown>) {
			order.push("facet");
			facetInputs.push(input);
			return options.facetTurn
				? options.facetTurn(input)
				: { assistantText: "done", turnError: null };
		},
		effectiveStepCeiling: () => 40,
		clearActiveTurn() {},
		peekPendingToolSteps: () => [],
		async commitAssistantTurn(commit: Record<string, unknown>) {
			order.push("commit");
			commits.push(commit);
		},
		...options.fields,
	});
	return {
		agent,
		facetInputs,
		commits,
		prepared,
		appends,
		order,
		run(input: Record<string, unknown>) {
			return agent.runFacetWorkflowTurnImpl({
				sessionKey: "main",
				runId: "tedi-1:mcp:req-1",
				conversationId: "conversation",
				userTs: 1,
				userText: "hello",
				...input,
			});
		},
	};
}

/**
 * A fully constructed `AgentTediDO` (class fields initialized) over an inert
 * fake Durable Object context. Use when the behaviour under test lives in a
 * field initializer; prefer {@link tediDo} otherwise.
 */
export function constructedTediDo(
	env: Record<string, unknown> = {},
): TediDoProbe {
	const cursor = {
		toArray: () => [],
		one: () => ({}),
		raw: () => [][Symbol.iterator](),
		columnNames: [],
		rowsRead: 0,
		rowsWritten: 0,
		*[Symbol.iterator]() {},
	};
	const storage = {
		...memoryStorage(),
		sql: { exec: () => cursor, databaseSize: 0 },
		transactionSync: <T>(run: () => T) => run(),
		setAlarm: async () => {},
		getAlarm: async () => null,
		deleteAlarm: async () => {},
		kv: {
			get: () => undefined,
			put: () => {},
			delete: () => false,
			list: () => [],
		},
	};
	const ctx = {
		storage,
		id: { toString: () => "do-id", name: "acme" },
		blockConcurrencyWhile: async <T>(run: () => Promise<T>) => run(),
		waitUntil: () => {},
		acceptWebSocket: () => {},
		getWebSockets: () => [],
		setWebSocketAutoResponse: () => {},
		exports: {},
	};
	const namespace = {
		idFromName: (name: string) => ({ toString: () => name }),
		get: () => ({}),
	};
	const Ctor = AgentTediDO as unknown as new (
		ctx: unknown,
		env: unknown,
	) => TediDoProbe;
	return new Ctor(ctx, { TEDI_COMPUTER_WORKSPACE: namespace, ...env });
}

/**
 * A DO whose `subAgent` returns one scripted facet serving the conversation,
 * judge and synthesis turn methods. Records the facet calls, cumulative
 * budget settlements, gateway attribution and Analytics Engine datapoints.
 */
export function facetRunnerProbe(
	options: {
		priorTurnCount?: number;
		fail?: boolean;
		usage?: { totalTokens: number };
		/** NDJSON frames the conversation facet streams. */
		stream?: string[];
		fields?: Record<string, unknown>;
	} = {},
) {
	const calls: string[] = [];
	const configs: Array<Record<string, unknown>> = [];
	const facetNames: string[] = [];
	const settled: Array<[string, unknown]> = [];
	const datapoints: Array<Record<string, unknown>> = [];
	let registryDuringTurn: unknown;
	const result = () => {
		registryDuringTurn = agent.activeFacetTurnTools.get("run-1");
		if (options.fail) throw new Error("facet evicted");
		return {
			assistantText: "answer",
			turnCount: 1,
			turnMs: 1,
			requestId: "r",
			modelIdentity: { provider: "workers-ai", model: "judge-model" },
			...(options.usage ? { usage: options.usage } : {}),
		};
	};
	const configure =
		(name: string) => async (config: Record<string, unknown>) => {
			calls.push(name);
			configs.push(config);
			if (options.fail && name !== "configure")
				throw new Error("facet evicted");
			return { priorTurnCount: options.priorTurnCount ?? 1 };
		};
	const facet = {
		completedTurnCount: () => options.priorTurnCount ?? 1,
		async runConfiguredConversationTurn(input: {
			configuration: Record<string, unknown>;
			text: string;
			firstTurnText?: string;
			freshHistory?: boolean;
		}) {
			if (input.freshHistory) {
				calls.push(`fresh:${input.text}`);
				return { priorTurnCount: 4, result: result() };
			}
			const configured = await configure("configure")(input.configuration);
			calls.push(
				`run:${configured.priorTurnCount === 0 ? (input.firstTurnText ?? input.text) : input.text}`,
			);
			return { ...configured, result: result() };
		},
		async streamConfiguredConversationTurn(input: {
			configuration: Record<string, unknown>;
		}) {
			await configure("configure")(input.configuration);
			registryDuringTurn = agent.activeFacetTurnTools.get("run-1");
			if (options.fail) throw new Error("facet evicted");
			const lines = options.stream ?? [];
			return new ReadableStream({
				start(controller) {
					for (const line of lines)
						controller.enqueue(new TextEncoder().encode(`${line}\n`));
					controller.close();
				},
			});
		},
		configureJudgeTurn: configure("configureJudge"),
		async runJudgeTurn(input: { text: string }) {
			calls.push(`judge:${input.text}`);
			return result();
		},
		configureSynthesisTurn: configure("configureSynthesis"),
		async runSynthesisTurn(input: { text: string }) {
			calls.push(`synthesis:${input.text}`);
			return result();
		},
	};
	const agent = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme", systemPrompt: "SYSTEM" },
		runtimeConfigCache: { modelPolicy: undefined },
		activeFacetTurnTools: new Map(),
		activeFacetTurnConversations: new Map(),
		activeFacetTurnAuthorities: new Map(),
		async subAgent(_facetClass: unknown, name: string) {
			facetNames.push(name);
			return facet;
		},
		admitInferenceTurn() {},
		tediAigMetadata: (source: string, correlation: unknown) => ({
			source,
			correlation,
		}),
		modelOverrideForSurface: () => null,
		modelOverrideForTurn: () => null,
		sessionHarness: {
			async buildContext() {
				return [{ role: "user", content: "earlier question", ts: 0 }];
			},
		},
		settleCumulativeInferenceTokens(runId: string, tokens: unknown) {
			settled.push([runId, tokens]);
		},
		emitFacetTurnDatapoint(event: Record<string, unknown>) {
			datapoints.push(event);
		},
		...options.fields,
	});
	return {
		agent,
		calls,
		configs,
		facetNames,
		settled,
		datapoints,
		registryDuringTurn: () => registryDuringTurn,
	};
}

/**
 * A DO test fixture with identity and model
 * policy, drains and MCP are inert; native tool families are markers; the
 * harness context and cognitive addenda are scripted.
 */
export function wsTurnProbe(fields: Record<string, unknown> = {}) {
	const agent = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme", systemPrompt: "SYSTEM" },
		messages: [],
		activeTurnMetadata: null,
		currentTurn: null,
		activeTurnBinding: null,
		async ensureIdentity() {},
		async ensureModelPolicy() {},
		modelOverrideForTurn: () => null,
		async drainPendingRepoCommits() {},
		async drainPendingCodemodeExecutions() {},
		messengerSessionKey: () => null,
		getMessengerContext: () => null,
		async assertChatTurnActive() {},
		admitInferenceTurn() {},
		sessionHarness: {
			appendTurn: async () => true,
			buildContext: async () => [],
		},
		async getMcpRuntime() {
			return null;
		},
		async getPlatformClient() {
			return null;
		},
		clearActiveTurn() {},
		async cognitiveAddenda() {
			return "";
		},
		...nativeToolMarkers(),
		effectiveStepCeiling: () => 8,
		...fields,
	});
	return {
		agent,
		/** Run beforeTurn for one user message. */
		beforeTurn(text = "hello", body: Record<string, unknown> = {}) {
			return agent.beforeTurn({
				messages: [{ role: "user", content: text }],
				body,
			});
		},
	};
}

/** Private image store with immutable conditional manifest writes. */
export function workflowImageBucketProbe() {
	const objects = new Map<string, string>();
	const deleted: string[] = [];
	const bucket = {
		async put(key: string, body: string, options?: { onlyIf?: Headers }) {
			if (options?.onlyIf?.get("If-None-Match") === "*" && objects.has(key))
				return null;
			objects.set(key, body);
			return { key };
		},
		async get(key: string) {
			const body = objects.get(key);
			return body === undefined
				? null
				: {
						size: new TextEncoder().encode(body).length,
						text: async () => body,
					};
		},
		async list({ prefix }: { prefix: string }) {
			return {
				objects: [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((key) => ({ key })),
				truncated: false,
			};
		},
		async delete(keys: string | string[]) {
			for (const key of typeof keys === "string" ? [keys] : keys) {
				deleted.push(key);
				objects.delete(key);
			}
		},
	};
	return { bucket, objects, deleted };
}
