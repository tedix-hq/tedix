/** Temporary passive operator. Callers own authentication, physical/canonical identity and writer gates. */
import type { RuntimeAdmission, AdmissionSnapshot } from "./runtime-admission";
import { cutoverHash, inventoryPiStateCutover } from "./pi-state-cutover";
import type {
	TranscriptResult,
	TranscriptPlan,
} from "./pi-state-cutover-transcript";
const OPERATIONS = "pi_cutover_operator",
	CHECKPOINTS = "pi_cutover_checkpoints";
const ARRAYS = [
	"tables",
	"receipts",
	"privateImages",
	"children",
	"maintenance",
] as const;
type Action =
	| "inspect"
	| "prepare"
	| "apply"
	| "release"
	| "inspectAccounting"
	| "transferAccounting";
interface AccountingTransferReceipt {
	accountingManifestHash: string;
	count: number;
	legacyCount: number;
	nativeCount: number;
	preSourceHash: string;
	postSourceHash: string;
	preDestinationHash: string;
	postDestinationHash: string;
	archiveHash: string;
}
interface AccountingTransferInput {
	operationId: string;
	generation: number;
	sourceHash: string;
}
interface GraphActivation {
	sourceHash: string;
	sessions: Record<
		string,
		{ activeLeaf: string | null; conversationId: number }
	>;
	selectedSessionId: string | null;
	conversationId: number | null;
	hash: string;
}
export function selectCutoverGraphActivation(
	plan: TranscriptPlan,
	result: TranscriptResult,
	facet: boolean,
) {
	if (plan.sourceHash !== result.sourceHash)
		fail("graph mapping source changed");
	const sessions: GraphActivation["sessions"] = {};
	for (const source of plan.sessions) {
		const id = result.activeConversations[source.id];
		if (!Number.isSafeInteger(id) || id! < 1)
			fail("active graph mapping missing");
		sessions[source.id] = {
			activeLeaf: source.activeLeaf,
			conversationId: id!,
		};
	}
	if (
		Object.keys(result.activeConversations).some(
			(id) => !Object.hasOwn(sessions, id),
		)
	)
		fail("unknown active graph session");
	if (facet && !Object.hasOwn(sessions, "") && plan.nodes.length)
		fail("private facet default session is not mapped");
	const selectedSessionId = facet && Object.hasOwn(sessions, "") ? "" : null;
	return {
		sourceHash: plan.sourceHash,
		sessions,
		selectedSessionId,
		conversationId:
			selectedSessionId === null
				? null
				: sessions[selectedSessionId]!.conversationId,
	};
}
interface Operation {
	priorPointer: number | null;
	activation?: GraphActivation;
	destinationHash: string | null;
	sourceHash: string;
	generation: number;
	stage: "prepared" | "applied" | "released";
	result: TranscriptResult | null;
	accounting?: AccountingTransferReceipt;
	accountingArchiveKeys?: string[];
}
function fail(reason: string): never {
	throw new Error(`Cutover operator: ${reason}`);
}
function hash(value: string) {
	if (!/^[a-f0-9]{64}$/.test(value)) fail("invalid hash");
	return value;
}
function operationId(value: string) {
	if (!value || value.length > 256) fail("invalid operation identity");
	return value;
}
/** A transfer retains measured-null receipts; it never invents usage or seals an effect. */
export function validateAccountingCheckpoint(
	key: string,
	value: unknown,
): void {
	const prefix = key.startsWith("think-accounting:")
		? "think-accounting:"
		: "pi-accounting:";
	if (
		!key.startsWith(prefix) ||
		!value ||
		typeof value !== "object" ||
		Array.isArray(value)
	)
		fail("invalid accounting checkpoint");
	const checkpoint = value as Record<string, unknown>;
	if (
		checkpoint.version !== 1 ||
		checkpoint.runId !== key.slice(prefix.length) ||
		!checkpoint.runId ||
		checkpoint.fault !== null ||
		checkpoint.receiptFault === true ||
		!Array.isArray(checkpoint.attempts)
	)
		fail("unresolved accounting checkpoint");
	const ids = new Set<string>();
	for (const raw of checkpoint.attempts) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			fail("invalid accounting attempt");
		const attempt = raw as Record<string, unknown>;
		if (
			typeof attempt.id !== "string" ||
			!attempt.id ||
			ids.has(attempt.id) ||
			attempt.phase !== "completed" ||
			attempt.acknowledged !== true ||
			typeof attempt.effectsStarted !== "boolean" ||
			(attempt.effectsStarted && attempt.effectsSealed !== true)
		)
			fail("unresolved accounting effects or acknowledgment");
		ids.add(attempt.id);
		if (
			!attempt.usage ||
			typeof attempt.usage !== "object" ||
			Array.isArray(attempt.usage)
		)
			fail("missing accounting usage receipt");
		for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
			const number = (attempt.usage as Record<string, unknown>)[field];
			if (
				number !== null &&
				(!Number.isSafeInteger(number) || (number as number) < 0)
			)
				fail("invalid accounting usage receipt");
		}
	}
}
/** Full digest/counts remain stable across pages. A changed inventory rejects the next page. */
export async function pageCutoverInventory(
	storage: DurableObjectStorage,
	input: { offset: number; limit: number; expectedHash?: string },
) {
	if (
		!Number.isSafeInteger(input.offset) ||
		input.offset < 0 ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 200
	)
		fail("invalid page");
	const inventory = await inventoryPiStateCutover(storage);
	for (const key of ARRAYS)
		inventory[key].sort((a, b) =>
			JSON.stringify(a).localeCompare(JSON.stringify(b)),
		);
	const digest = await cutoverHash(inventory);
	if (input.expectedHash !== undefined && hash(input.expectedHash) !== digest)
		fail("inventory changed");
	const counts = Object.fromEntries(
		ARRAYS.map((key) => [key, inventory[key].length]),
	);
	const page = { ...inventory };
	for (const key of ARRAYS)
		(page[key] as unknown[]) = inventory[key].slice(
			input.offset,
			input.offset + input.limit,
		);
	return {
		hash: digest,
		offset: input.offset,
		limit: input.limit,
		counts,
		nextOffset: ARRAYS.some(
			(key) => inventory[key].length > input.offset + input.limit,
		)
			? input.offset + input.limit
			: null,
		inventory: page,
	};
}
export class PiCutoverOperator {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly admission: RuntimeAdmission,
		/** Trusted boundary callback must authenticate and verify ctx.id + canonical/custodial D1 identity; never supplied by a request. */
		private readonly authorize: (
			action: Action,
			owner: RuntimeAdmission["owner"],
		) => void,
		/** Must be the owner ctx.blockConcurrencyWhile; excludes concurrent operator release across awaits. */
		private readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>,
	) {}
	private async serialized<T>(run: () => Promise<T>): Promise<T> {
		// Expected admission conflicts must not escape the native input gate and
		// reset the owner object. Rethrow only after the gate has completed safely.
		const outcome = await this.exclusive(async () => {
			try {
				return { ok: true as const, value: await run() };
			} catch (error) {
				return { ok: false as const, error };
			}
		});
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}
	private access(action: Action) {
		this.authorize(action, this.admission.owner);
	}
	private owner() {
		const { tediId, orgId } = this.admission.owner;
		if (!tediId || !orgId) fail("unverified custody");
		return { tediId, orgId };
	}
	private held(generation: number): AdmissionSnapshot {
		const state = this.admission.read();
		if (!state || state.state !== "held" || state.generation !== generation)
			fail("writer exclusion missing or changed");
		return state;
	}
	private setup() {
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${OPERATIONS} (id TEXT PRIMARY KEY,record TEXT NOT NULL)`,
		);
		this.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS ${CHECKPOINTS} (id TEXT PRIMARY KEY,record TEXT NOT NULL)`,
		);
	}
	private read(id: string): Operation | null {
		const exists = this.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
				OPERATIONS,
			)
			.toArray().length;
		if (!exists) return null;
		const row = this.storage.sql
			.exec<{ record: string }>(
				`SELECT record FROM ${OPERATIONS} WHERE id=?`,
				id,
			)
			.toArray()[0];
		return row ? (JSON.parse(row.record) as Operation) : null;
	}
	private save(id: string, record: Operation) {
		this.setup();
		this.storage.sql.exec(
			`INSERT OR REPLACE INTO ${OPERATIONS} VALUES (?,?)`,
			id,
			JSON.stringify(record),
		);
	}
	async inspect(input: {
		offset: number;
		limit: number;
		expectedHash?: string;
	}) {
		this.access("inspect");
		return this.serialized(async () => {
			const { planPiTranscriptCutover } =
				await import("./pi-state-cutover-transcript");
			const page = await pageCutoverInventory(this.storage, input);
			let sourceHash: string | null = null;
			try {
				sourceHash = (await planPiTranscriptCutover(this.storage, this.owner()))
					.sourceHash;
			} catch {
				/* Metadata remains readable; unavailable plans do not authorize apply. */
			}
			return { ...page, sourceHash };
		});
	}
	private async checkpoints() {
		const entries: [string, string][] = [];
		for (const prefix of ["think-accounting:", "pi-accounting:"]) {
			let startAfter: string | undefined;
			do {
				const page = await this.storage.list({
					prefix,
					limit: 100,
					startAfter,
				});
				for (const [key, value] of page)
					entries.push([key, JSON.stringify(value)]);
				startAfter = page.size === 100 ? [...page.keys()].at(-1) : undefined;
			} while (startAfter !== undefined);
		}
		return entries;
	}
	private async destinationHash(activation?: GraphActivation) {
		const names = this.storage.sql
			.exec<{ name: string; sql: string }>(
				"SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
			)
			.toArray()
			.filter(
				(row) =>
					/^pi_[a-z0-9_]+$/.test(row.name) &&
					row.name !== OPERATIONS &&
					row.name !== CHECKPOINTS,
			);
		const sql = names.map((row) => ({
			...row,
			rows: this.storage.sql
				.exec(`SELECT * FROM ${row.name}`)
				.toArray()
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		}));
		const kv: [string, unknown][] = [];
		for (const prefix of ["pi-ui-entry:", "pi-image-projection:v1:"]) {
			let startAfter: string | undefined;
			do {
				const page = await this.storage.list({
					prefix,
					limit: 100,
					startAfter,
				});
				kv.push(...page);
				startAfter = page.size === 100 ? [...page.keys()].at(-1) : undefined;
			} while (startAfter !== undefined);
		}
		kv.push([
			"pi-cutover-active-graph:v1",
			activation ?? this.storage.kv.get("pi-cutover-active-graph:v1") ?? null,
		]);
		kv.push([
			"pi-active-conversation-id:v1",
			activation?.conversationId ??
				this.storage.kv.get("pi-active-conversation-id:v1") ??
				null,
		]);
		return cutoverHash({ sql, kv });
	}
	private checkCheckpointDestinations(entries: [string, string][]) {
		const exists = this.storage.sql
			.exec(
				"SELECT name FROM sqlite_master WHERE type='table' AND name=?",
				CHECKPOINTS,
			)
			.toArray().length;
		if (!exists) return;
		for (const [key, value] of entries) {
			const prior = this.storage.sql
				.exec<{ record: string }>(
					`SELECT record FROM ${CHECKPOINTS} WHERE id=?`,
					key,
				)
				.toArray()[0];
			if (prior && prior.record !== value)
				fail("checkpoint destination conflict");
		}
	}
	private archive(entries: [string, string][]) {
		this.setup();
		for (const [key, value] of entries) {
			const prior = this.storage.sql
				.exec<{ record: string }>(
					`SELECT record FROM ${CHECKPOINTS} WHERE id=?`,
					key,
				)
				.toArray()[0];
			if (prior && prior.record !== value)
				fail("checkpoint destination conflict");
			if (!prior)
				this.storage.sql.exec(
					`INSERT INTO ${CHECKPOINTS} VALUES (?,?)`,
					key,
					value,
				);
		}
	}
	async prepareCutover(input: {
		operationId: string;
		expectedGeneration: number;
		sourceHash: string;
		evidence: string;
	}) {
		this.access("prepare");
		return this.serialized(() => this.prepareExclusive(input));
	}
	private async prepareExclusive(input: {
		operationId: string;
		expectedGeneration: number;
		sourceHash: string;
		evidence: string;
	}) {
		operationId(input.operationId);
		hash(input.sourceHash);
		hash(input.evidence);
		const prior = this.read(input.operationId);
		if (prior) {
			if (prior.sourceHash !== input.sourceHash) fail("operation conflict");
			this.admission.hold({
				operationId: `cutover-hold:${input.operationId}`,
				expectedGeneration: input.expectedGeneration,
				evidence: input.evidence,
			});
			this.held(prior.generation);
			return { sourceHash: prior.sourceHash, generation: prior.generation };
		}
		const { planPiTranscriptCutover } =
			await import("./pi-state-cutover-transcript");
		const plan = await planPiTranscriptCutover(this.storage, this.owner());
		if (plan.sourceHash !== input.sourceHash) fail("source changed");
		const held = this.admission.hold({
			operationId: `cutover-hold:${input.operationId}`,
			expectedGeneration: input.expectedGeneration,
			evidence: input.evidence,
		});
		this.held(held.generation);
		const frozen = await planPiTranscriptCutover(this.storage, this.owner());
		if (frozen.sourceHash !== input.sourceHash)
			fail("source changed after hold");
		this.storage.transactionSync(() => {
			this.held(held.generation);
			this.save(input.operationId, {
				sourceHash: frozen.sourceHash,
				priorPointer:
					this.storage.kv.get<number>("pi-active-conversation-id:v1") ?? null,
				generation: held.generation,
				stage: "prepared",
				destinationHash: null,
				result: null,
			});
		});
		return { sourceHash: frozen.sourceHash, generation: held.generation };
	}
	async apply(input: {
		operationId: string;
		generation: number;
		sourceHash: string;
	}) {
		this.access("apply");
		return this.serialized(() => this.applyExclusive(input));
	}
	private async applyExclusive(input: {
		operationId: string;
		generation: number;
		sourceHash: string;
	}) {
		operationId(input.operationId);
		hash(input.sourceHash);
		this.held(input.generation);
		const prior = this.read(input.operationId);
		if (
			!prior ||
			prior.sourceHash !== input.sourceHash ||
			prior.generation !== input.generation ||
			prior.stage === "released"
		)
			fail("unprepared or conflicting apply");
		const { planPiTranscriptCutover, applyPiTranscriptCutover } =
			await import("./pi-state-cutover-transcript");
		const plan = await planPiTranscriptCutover(this.storage, this.owner());
		if (plan.sourceHash !== input.sourceHash) fail("source changed");
		if (
			this.storage.kv.get("cf_agents_is_facet") === true &&
			plan.nodes.length &&
			!plan.sessions.some((session) => session.id === "")
		)
			fail("private facet default session is not mapped");
		const checkpoints = await this.checkpoints();
		this.checkCheckpointDestinations(checkpoints);
		this.held(input.generation);
		const currentPointer =
			this.storage.kv.get<number>("pi-active-conversation-id:v1") ?? null;
		if (
			currentPointer !==
			(prior.activation?.conversationId ?? prior.priorPointer)
		)
			fail("original active pointer changed");
		const result = await applyPiTranscriptCutover(this.storage, plan);
		this.held(input.generation);
		const selection = selectCutoverGraphActivation(
			plan,
			result,
			this.storage.kv.get("cf_agents_is_facet") === true,
		);
		const activation: GraphActivation = {
			...selection,
			hash: await cutoverHash(selection),
		};
		if (
			prior.activation &&
			JSON.stringify(prior.activation) !== JSON.stringify(activation)
		)
			fail("graph activation mapping changed");
		const destinationHash = await this.destinationHash(activation);
		this.storage.transactionSync(() => {
			this.held(input.generation);
			if (
				(this.storage.kv.get<number>("pi-active-conversation-id:v1") ??
					null) !== currentPointer
			)
				fail("active pointer changed before commit");
			this.storage.kv.put("pi-cutover-active-graph:v1", activation);
			if (activation.conversationId !== null)
				this.storage.kv.put(
					"pi-active-conversation-id:v1",
					activation.conversationId,
				);
			if (
				JSON.stringify(this.storage.kv.get("pi-cutover-active-graph:v1")) !==
					JSON.stringify(activation) ||
				(activation.conversationId !== null &&
					this.storage.kv.get("pi-active-conversation-id:v1") !==
						activation.conversationId)
			)
				fail("graph activation readback mismatch");
			this.archive(checkpoints);
			this.save(input.operationId, {
				...prior,
				stage: "applied",
				activation,
				result,
				destinationHash,
			});
		});
		return {
			sourceHash: result.sourceHash,
			generation: input.generation,
			entries: Object.keys(result.entries).length,
			conversations: Object.keys(result.leaves).length,
			preservedNativeConversations: result.preservedNativeConversations.length,
		};
	}
	private appliedAccountingOperation(input: AccountingTransferInput) {
		operationId(input.operationId);
		hash(input.sourceHash);
		this.held(input.generation);
		const operation = this.read(input.operationId);
		if (
			!operation ||
			operation.stage !== "applied" ||
			!operation.result ||
			!operation.destinationHash ||
			operation.generation !== input.generation ||
			operation.sourceHash !== input.sourceHash
		)
			fail("accounting requires exact applied original operation");
		return operation;
	}
	private async accountingManifest(input: AccountingTransferInput) {
		const operation = this.appliedAccountingOperation(input);
		if (operation.accounting)
			fail("accounting already transferred; use exact receipt");
		const { planPiTranscriptCutover } =
			await import("./pi-state-cutover-transcript");
		const plan = await planPiTranscriptCutover(this.storage, this.owner());
		if (
			plan.sourceHash !== input.sourceHash ||
			(await this.destinationHash()) !== operation.destinationHash
		)
			fail("accounting source or destination changed");
		const entries = await this.checkpoints();
		const targets = new Map<string, string>();
		for (const [key, value] of entries) {
			validateAccountingCheckpoint(key, JSON.parse(value));
			const target = key.replace(/^think-accounting:/, "pi-accounting:");
			const prior = targets.get(target);
			if (prior !== undefined && prior !== value)
				fail("accounting destination conflict");
			targets.set(target, value);
		}
		this.checkCheckpointDestinations(entries);
		const digests = await Promise.all(
			entries.map(async ([key, value]) => ({
				key,
				sha256: await cutoverHash(value),
			})),
		);
		const nativeEntries = entries.filter(([key]) =>
			key.startsWith("pi-accounting:"),
		);
		const postEntries = [...targets].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		const accountingManifestHash = await cutoverHash({
			owner: this.admission.owner,
			...input,
			entries: digests,
		});
		const preDestinationHash = await cutoverHash(nativeEntries);
		const postDestinationHash = await cutoverHash(postEntries);
		// The source document is structured protocol data emitted by the planner.
		// Only its accounting evidence changes; all transcript bytes stay exact.
		const source = JSON.parse(
			plan.chunks.map((chunk) => chunk.text).join(""),
		) as {
			imagePolicy: string;
			owner: unknown;
			raw: unknown;
			evidence: [string, unknown][];
		};
		const encoded = new Map(source.evidence);
		source.evidence = postEntries.map(([key]) => {
			const sourceKey = encoded.has(key)
				? key
				: key.replace(/^pi-accounting:/, "think-accounting:");
			if (!encoded.has(sourceKey))
				fail("accounting manifest missing source evidence");
			return [key, encoded.get(sourceKey)];
		});
		const text = JSON.stringify(source),
			chunks: string[] = [];
		for (let offset = 0; offset < text.length; offset += 32768)
			chunks.push(await cutoverHash(text.slice(offset, offset + 32768)));
		const postSourceHash = await cutoverHash({
			imagePolicy: "current-turn",
			owner: this.owner(),
			chunks,
		});
		return {
			operation,
			entries,
			postEntries,
			plan,
			accountingManifestHash,
			preDestinationHash,
			postDestinationHash,
			postSourceHash,
		};
	}
	async inspectAccounting(input: AccountingTransferInput) {
		this.access("inspectAccounting");
		return this.serialized(async () => {
			const operation = this.appliedAccountingOperation(input);
			if (operation.accounting) return operation.accounting;
			const manifest = await this.accountingManifest(input);
			return {
				accountingManifestHash: manifest.accountingManifestHash,
				count: manifest.entries.length,
				legacyCount: manifest.entries.filter(([key]) =>
					key.startsWith("think-accounting:"),
				).length,
				nativeCount: manifest.entries.filter(([key]) =>
					key.startsWith("pi-accounting:"),
				).length,
				sourceHash: input.sourceHash,
				destinationHash: manifest.preDestinationHash,
			};
		});
	}
	async transferAccounting(
		input: AccountingTransferInput & { accountingManifestHash: string },
	) {
		this.access("transferAccounting");
		return this.serialized(async () => {
			hash(input.accountingManifestHash);
			const operation = this.appliedAccountingOperation(input);
			if (operation.accounting) {
				if (
					operation.accounting.accountingManifestHash !==
					input.accountingManifestHash
				)
					fail("accounting transfer conflict");
				await this.verifyAccountingTransfer(
					operation.accounting,
					operation.accountingArchiveKeys,
				);
				return operation.accounting;
			}
			const manifest = await this.accountingManifest({
				operationId: input.operationId,
				generation: input.generation,
				sourceHash: input.sourceHash,
			});
			if (manifest.accountingManifestHash !== input.accountingManifestHash)
				fail("accounting manifest changed");
			const receipt: AccountingTransferReceipt = {
				accountingManifestHash: manifest.accountingManifestHash,
				count: manifest.entries.length,
				legacyCount: manifest.entries.filter(([key]) =>
					key.startsWith("think-accounting:"),
				).length,
				nativeCount: manifest.postEntries.length,
				preSourceHash: input.sourceHash,
				postSourceHash: manifest.postSourceHash,
				preDestinationHash: manifest.preDestinationHash,
				postDestinationHash: manifest.postDestinationHash,
				archiveHash: await cutoverHash(manifest.entries),
			};
			this.storage.transactionSync(() => {
				this.held(input.generation);
				for (const [key, value] of manifest.entries)
					if (JSON.stringify(this.storage.kv.get(key)) !== value)
						fail("accounting source changed before transfer");
				this.archive(manifest.entries);
				for (const [key, value] of manifest.postEntries) {
					const existing = this.storage.kv.get(key);
					if (existing !== undefined && JSON.stringify(existing) !== value)
						fail("accounting destination conflict");
					this.storage.kv.put(key, JSON.parse(value));
					if (JSON.stringify(this.storage.kv.get(key)) !== value)
						fail("accounting byte readback mismatch");
				}
				for (const [key] of manifest.entries)
					if (key.startsWith("think-accounting:")) this.storage.kv.delete(key);
				this.save(input.operationId, {
					...manifest.operation,
					accounting: receipt,
					accountingArchiveKeys: manifest.entries.map(([key]) => key),
				});
			});
			await this.verifyAccountingTransfer(
				receipt,
				manifest.entries.map(([key]) => key),
			);
			return receipt;
		});
	}
	private async verifyAccountingTransfer(
		receipt: AccountingTransferReceipt,
		archiveKeys?: string[],
	) {
		if (!archiveKeys || archiveKeys.length !== receipt.count)
			fail("accounting archive manifest missing");
		const archived = archiveKeys.map((key) => {
			const row = this.storage.sql
				.exec<{ record: string }>(
					`SELECT record FROM ${CHECKPOINTS} WHERE id=?`,
					key,
				)
				.toArray()[0];
			if (!row) fail("accounting archive missing");
			return [key, row.record];
		});
		if ((await cutoverHash(archived)) !== receipt.archiveHash)
			fail("accounting archive changed");

		const { planPiTranscriptCutover } =
			await import("./pi-state-cutover-transcript");
		const entries = await this.checkpoints();
		if (
			entries.some(([key]) => key.startsWith("think-accounting:")) ||
			(await cutoverHash(entries)) !== receipt.postDestinationHash ||
			(await planPiTranscriptCutover(this.storage, this.owner())).sourceHash !==
				receipt.postSourceHash
		)
			fail("accounting changed after transfer");
		this.checkCheckpointDestinations(entries);
	}

	async release(input: {
		operationId: string;
		generation: number;
		sourceHash: string;
		evidence: string;
	}) {
		this.access("release");
		return this.serialized(async () => this.releaseExclusive(input));
	}
	private async releaseExclusive(input: {
		operationId: string;
		generation: number;
		sourceHash: string;
		evidence: string;
	}) {
		operationId(input.operationId);
		hash(input.sourceHash);
		hash(input.evidence);
		const prepared = this.read(input.operationId);
		if (!prepared?.activation)
			fail("destination changed or unverified: graph activation missing");
		const { hash: activationHash, ...activationFields } = prepared.activation;
		if (activationHash !== (await cutoverHash(activationFields)))
			fail("graph activation hash changed");
		if (
			!prepared?.destinationHash ||
			prepared.destinationHash !== (await this.destinationHash())
		)
			fail("destination changed or unverified");
		const { planPiTranscriptCutover } =
			await import("./pi-state-cutover-transcript");
		if (prepared.accounting)
			await this.verifyAccountingTransfer(
				prepared.accounting,
				prepared.accountingArchiveKeys,
			);
		if (
			(await planPiTranscriptCutover(this.storage, this.owner())).sourceHash !==
			(prepared.accounting?.postSourceHash ?? input.sourceHash)
		)
			fail("source changed before release");
		return this.storage.transactionSync(() => {
			const prior = this.read(input.operationId);
			if (
				!prior ||
				prior.sourceHash !== input.sourceHash ||
				prior.generation !== input.generation ||
				!prior.result ||
				prior.stage === "prepared"
			)
				fail("unverified destination");
			const state = this.admission.release({
				operationId: `cutover-release:${input.operationId}`,
				expectedGeneration: input.generation,
				evidence: input.evidence,
			});
			const current = this.admission.read();
			if (
				!current ||
				current.state !== "active" ||
				current.generation !== state.generation
			)
				fail("release epoch changed");
			this.save(input.operationId, { ...prior, stage: "released" });
			return {
				state: state.state,
				generation: state.generation,
				sourceHash: prior.sourceHash,
			};
		});
	}
}
