/**
 * The runtime a single-writer agent object codes against.
 *
 * An agent object owns its data and runs its own loop: a workspace is one such
 * object, a tedi can be another. Everything the loop touches goes through this
 * interface, so the same object runs on Cloudflare (`./cloudflare`), on a self-hosted workerd (`./workerd`)
 * and, later, on a Kubernetes/Postgres installation (sketched in README.md).
 * Every method is asynchronous even where today's host is synchronous, so the
 * object never has to change when the host does.
 */

/**
 * Where the object's state is allowed to live.
 *
 * - `eu`: a Cloudflare object created inside the EU jurisdiction. Required for
 *   EU organizations; the Cloudflare implementation refuses to address an EU
 *   object any other way.
 * - `global`: a Cloudflare object with no jurisdiction restriction.
 * - `local`: a self-hosted process keeps state on its own disk. Residency is
 *   wherever that process runs, so no narrower value is honest.
 */
export type AgentJurisdiction = "eu" | "global" | "local";

/** Plain JSON. Event payloads and alarm payloads are stored as this. */
export type AgentJson =
	| string
	| number
	| boolean
	| null
	| AgentJson[]
	| { [key: string]: AgentJson };

/** A value SQL can bind or return. */
export type AgentSqlValue =
	| string
	| number
	| bigint
	| boolean
	| null
	| ArrayBuffer
	| Uint8Array;

export interface AgentSqlStatement {
	readonly sql: string;
	readonly params?: readonly AgentSqlValue[];
}

export interface AgentSqlResult {
	/** Rows inserted, updated or deleted by the statement. */
	readonly rowsWritten: number;
}

/**
 * One named, ordered schema step. Names are applied once per object and
 * recorded, so a migration list only ever grows at the end.
 */
export interface AgentMigration {
	readonly name: string;
	readonly statements: readonly string[];
}

/**
 * Single-writer SQL for one agent object. The implementation is the only writer:
 * two calls never interleave inside a statement, and `batch` is atomic.
 */
export interface AgentStorage {
	/** The id of the object this storage belongs to. */
	readonly objectId: string;
	exec(sql: string, params?: readonly AgentSqlValue[]): Promise<AgentSqlResult>;
	query<Row extends Record<string, AgentSqlValue>>(
		sql: string,
		params?: readonly AgentSqlValue[],
	): Promise<Row[]>;
	/** Runs every statement or none of them. */
	batch(statements: readonly AgentSqlStatement[]): Promise<void>;
	/** Applies the migrations not yet recorded, in order; returns their names. */
	migrate(migrations: readonly AgentMigration[]): Promise<string[]>;
	/** The migration names already applied, in application order. */
	appliedMigrations(): Promise<string[]>;
}

/**
 * A named capability the sandboxed code reaches as `env.NAME`. `stub` is what
 * the loader hands the code (an RPC target, a service stub or a Durable Object
 * stub); `declaration` is the complete TypeScript declaration an agent needs
 * to call it, returned whole by `describe`.
 */
export interface AgentBinding {
	readonly name: string;
	/** One line, for the catalog an agent sees before it asks for details. */
	readonly description: string;
	/** The full TypeScript declaration of `env.NAME`, ready to show a model. */
	readonly declaration: string;
	readonly stub: unknown;
}

export interface AgentBindingSummary {
	readonly name: string;
	readonly description: string;
}

export interface AgentBindings {
	register(binding: AgentBinding): void;
	unregister(name: string): boolean;
	has(name: string): boolean;
	list(): AgentBindingSummary[];
	/**
	 * Everything a model needs to use `env.NAME`, in one call: the description
	 * and the whole declaration. Throws when the binding does not exist.
	 */
	describe(name: string): string;
	/** The prompt text that lists every binding with its one-line description. */
	catalog(): string;
}

export interface SandboxLimits {
	/** Wall-clock budget for one run. The run fails with `timeout` past it. */
	readonly timeoutMs?: number;
	/** Longest serialized result returned; longer results are cut and flagged. */
	readonly maxResultChars?: number;
	/** Most console lines kept from one run. */
	readonly maxLogLines?: number;
}

export interface SandboxRunInput {
	/**
	 * The snippet. Either a module whose default export is
	 * `async (env) => value`, or a bare function body that receives `env`.
	 */
	readonly code: string;
	/** Binding names to expose; every registered binding when omitted. */
	readonly bindings?: readonly string[];
	readonly limits?: SandboxLimits;
}

export type SandboxRunResult =
	| {
			readonly ok: true;
			/** The snippet's JSON result; `undefined` when it returned nothing. */
			readonly value: AgentJson | undefined;
			readonly truncated: boolean;
			readonly logs: string[];
			readonly durationMs: number;
	  }
	| {
			readonly ok: false;
			readonly reason: "error" | "timeout" | "load";
			readonly error: string;
			readonly logs: string[];
			readonly durationMs: number;
	  };

/**
 * Runs agent-written code with no network at all. The only things the code
 * can reach are the bindings passed in; on Cloudflare and workerd that is a
 * Worker Loader manifest with `globalOutbound: null`.
 */
export interface AgentSandbox {
	run(input: SandboxRunInput): Promise<SandboxRunResult>;
}

export interface AgentEventInput {
	readonly type: string;
	readonly payload: AgentJson;
}

export interface AgentEvent extends AgentEventInput {
	/** Strictly increasing per object. A client resumes from the last one it saw. */
	readonly cursor: number;
	/** Unix milliseconds. */
	readonly at: number;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentSubscribeOptions {
	/** Replay every stored event after this cursor before going live. */
	readonly after?: number;
}

/**
 * The feed connected clients read. Every published event is stored with a
 * cursor, so a client that drops can reconnect with the last cursor it saw and
 * miss nothing that is still retained.
 */
export interface AgentEvents {
	publish(event: AgentEventInput): Promise<AgentEvent>;
	/** Returns the function that ends the subscription. */
	subscribe(
		listener: AgentEventListener,
		options?: AgentSubscribeOptions,
	): Promise<() => void>;
	replay(after: number, limit?: number): Promise<AgentEvent[]>;
	/** The cursor of the newest stored event; 0 before the first one. */
	head(): Promise<number>;
	/**
	 * Hands a client's upgrade request to the host's WebSocket transport. The
	 * request may carry `?after=<cursor>`; the stored events after it are sent
	 * first. The object's `fetch` calls this for its events route.
	 */
	connect(request: Request): Promise<Response>;
	/** Number of connected clients. */
	connections(): number;
}

export interface AgentAlarm {
	readonly id: string;
	/** Unix milliseconds. */
	readonly at: number;
	readonly payload: AgentJson;
}

export type AgentAlarmHandler = (alarm: AgentAlarm) => Promise<void>;

export interface AgentAlarms {
	schedule(at: number | Date, payload: AgentJson): Promise<AgentAlarm>;
	cancel(id: string): Promise<boolean>;
	/** Pending alarms, soonest first. */
	list(): Promise<AgentAlarm[]>;
	/** Replaces the handler that receives due alarms. */
	onAlarm(handler: AgentAlarmHandler): void;
	/**
	 * Delivers every alarm due at `now` to the handler and re-arms the host
	 * timer for the next one. The object's `alarm()` calls this.
	 */
	dispatchDue(now?: number): Promise<AgentAlarm[]>;
}

export interface AgentRuntime {
	readonly objectId: string;
	readonly jurisdiction: AgentJurisdiction;
	readonly storage: AgentStorage;
	readonly sandbox: AgentSandbox;
	readonly bindings: AgentBindings;
	readonly events: AgentEvents;
	readonly alarms: AgentAlarms;
}

const BINDING_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * A binding name is what the sandboxed code writes after `env.`. It has to be
 * a plain upper-case identifier, and it may never collide with a property of
 * `Object.prototype`, since the loader env is a plain object.
 */
export function assertAgentBindingName(name: string): void {
	if (!BINDING_NAME_RE.test(name)) {
		throw new Error(
			`Binding name ${JSON.stringify(name)} must match ${BINDING_NAME_RE}`,
		);
	}
	if (name in Object.prototype) {
		throw new Error(`Binding name ${JSON.stringify(name)} is reserved`);
	}
}

/** The one description format every implementation returns from `describe`. */
export function formatAgentBindingDescription(
	binding: Pick<AgentBinding, "name" | "description" | "declaration">,
): string {
	return (
		`Binding: ${binding.name}\n\n${binding.description.trim()}\n\n` +
		"```ts\n" +
		`${binding.declaration.trim()}\n` +
		"```\n"
	);
}
