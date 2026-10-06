import { createHash } from "node:crypto";

function fail(message: string): never {
	throw new Error(`Historical liability: ${message}`);
}
const views = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array,
};
/** Synthetic containers enumerate one native item at a time; they are never persisted tags. */
export class StreamArray {
	constructor(readonly items: () => Iterable<unknown>) {}
}
export class StreamObject {
	constructor(readonly fields: Record<string, unknown>) {}
}
/** Only a single independently read KV value may carry a local DAG reference scope. */
export class CanonicalKVValue {
	constructor(readonly value: unknown) {}
}
interface GraphRead {
	nodes: unknown[];
	completed: Set<number>;
	references: number;
	binaryDefinitions: Set<number>;
	activeDefinitions: number[];
}
/** Validate before yielding any graph bytes. Never retain another KV value or cross-value references. */
function hasDagAliases(value: unknown): boolean {
	const seen = new WeakSet<object>(),
		active = new WeakSet<object>(),
		binaryDescendants = new WeakMap<object, boolean>();
	let aliases = false;
	function visit(item: unknown): boolean {
		if (
			item === null ||
			typeof item === "string" ||
			typeof item === "boolean" ||
			(typeof item === "number" && Number.isFinite(item))
		)
			return false;
		if (!item || typeof item !== "object") fail("unsupported source value");
		const binary = item instanceof ArrayBuffer || ArrayBuffer.isView(item);
		if (active.has(item)) fail("unsupported source reference topology");
		if (seen.has(item)) {
			if (binary || binaryDescendants.get(item))
				fail("unsupported source reference topology");
			aliases = true;
			return false;
		}
		seen.add(item);
		if (binary) {
			if (ArrayBuffer.isView(item)) {
				const type = Object.prototype.toString.call(item).slice(8, -1);
				if (type !== "DataView" && !Object.hasOwn(views, type))
					fail("unsupported binary type");
				if (!(item.buffer instanceof ArrayBuffer) || seen.has(item.buffer))
					fail("unsupported source reference topology");
				seen.add(item.buffer);
			}
			return true;
		}
		active.add(item);
		let hasBinary = false;
		if (Array.isArray(item)) {
			const keys = Object.keys(item);
			if (
				keys.length !== item.length ||
				keys.some((key, i) => key !== String(i))
			)
				fail("unsupported source array properties");
			for (const child of item) hasBinary = visit(child) || hasBinary;
		} else {
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null)
				fail("unsupported source object type");
			const row = item as Record<string, unknown>;
			for (const key of Object.keys(row).sort())
				hasBinary = visit(row[key]) || hasBinary;
		}
		active.delete(item);
		binaryDescendants.set(item, hasBinary);
		return hasBinary;
	}
	visit(value);
	return aliases;
}
function* kvValueTokens(value: unknown): Generator<string> {
	if (!hasDagAliases(value)) {
		yield* canonicalTokens(value);
		return;
	}
	const ids = new WeakMap<object, number>(),
		completed = new WeakSet<object>();
	let nextId = 0;
	function* node(item: unknown): Generator<string> {
		if (
			!item ||
			typeof item !== "object" ||
			item instanceof ArrayBuffer ||
			ArrayBuffer.isView(item)
		) {
			yield* canonicalTokens(item);
			return;
		}
		const prior = ids.get(item);
		if (prior !== undefined) {
			if (!completed.has(item)) fail("unsupported source reference topology");
			yield `["ref",${prior}]`;
			return;
		}
		const id = nextId++;
		ids.set(item, id);
		yield `["def",${id},`;
		if (Array.isArray(item)) {
			yield '["array",[';
			for (let i = 0; i < item.length; i++) {
				if (i) yield ",";
				yield* node(item[i]);
			}
			yield "]]";
		} else {
			yield `["object",${Object.getPrototypeOf(item) === null ? '"null"' : '"plain"'},[`;
			let first = true;
			for (const key of Object.keys(item).sort()) {
				if (!first) yield ",";
				first = false;
				yield `[${JSON.stringify(key)},`;
				yield* node((item as Record<string, unknown>)[key]);
				yield "]";
			}
			yield "]]";
		}
		yield "]";
		completed.add(item);
	}
	yield '["graph",1,';
	yield* node(value);
	yield "]";
}
export function* canonicalTokens(
	value: unknown,
	seen = new WeakSet<object>(),
): Generator<string> {
	if (value instanceof CanonicalKVValue) {
		yield* kvValueTokens(value.value);
		return;
	}
	if (value === null) {
		yield '["null"]';
		return;
	}
	if (typeof value === "string" || typeof value === "boolean") {
		yield `["${typeof value}",`;
		yield JSON.stringify(value);
		yield "]";
		return;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		yield '["number",';
		yield Object.is(value, -0) ? '"-0"' : JSON.stringify(value);
		yield "]";
		return;
	}
	if (!value || typeof value !== "object") fail("unsupported source value");
	// Synthetic containers contain no shared native graph. A fresh item read is a separate value.
	if (value instanceof StreamArray) {
		yield '["array",[';
		let first = true;
		for (const item of value.items()) {
			if (!first) yield ",";
			first = false;
			yield* canonicalTokens(item, seen);
		}
		yield "]]";
		return;
	}
	if (value instanceof StreamObject) {
		yield '["object","plain",[';
		let first = true;
		for (const key of Object.keys(value.fields).sort()) {
			if (!first) yield ",";
			first = false;
			yield "[";
			yield JSON.stringify(key);
			yield ",";
			yield* canonicalTokens(value.fields[key], seen);
			yield "]";
		}
		yield "]]";
		return;
	}
	if (seen.has(value)) fail("unsupported source reference topology");
	seen.add(value);
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		const view = ArrayBuffer.isView(value) ? value : null;
		const buffer = view ? view.buffer : (value as ArrayBuffer);
		if (!(buffer instanceof ArrayBuffer) || (view && seen.has(buffer)))
			fail("unsupported source reference topology");
		const type = view
			? Object.prototype.toString.call(view).slice(8, -1)
			: null;
		if (type && type !== "DataView" && !Object.hasOwn(views, type))
			fail("unsupported binary type");
		if (view) seen.add(buffer);
		yield view ? `["view",${JSON.stringify(type)},[` : '["buffer",[';
		let first = true;
		for (const byte of new Uint8Array(buffer)) {
			if (!first) yield ",";
			first = false;
			yield String(byte);
		}
		yield view ? `],${view.byteOffset},${view.byteLength}]` : "]]";
		return;
	}
	if (Array.isArray(value)) {
		const keys = Object.keys(value);
		if (
			keys.length !== value.length ||
			keys.some((key, i) => key !== String(i))
		)
			fail("unsupported source array properties");
		yield '["array",[';
		for (let i = 0; i < value.length; i++) {
			if (i) yield ",";
			yield* canonicalTokens(value[i], seen);
		}
		yield "]]";
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		fail("unsupported source object type");
	yield `["object",${prototype === null ? '"null"' : '"plain"'},[`;
	const row = value as Record<string, unknown>;
	let first = true;
	for (const key of Object.keys(row).sort()) {
		if (!first) yield ",";
		first = false;
		yield "[";
		yield JSON.stringify(key);
		yield ",";
		yield* canonicalTokens(row[key], seen);
		yield "]";
	}
	yield "]]";
}

/** One output chunk and scalar token at a time; no complete source string/UTF8 buffer. */
export function writeCanonical(
	value: unknown,
	onChunk?: (bytes: Uint8Array, part: number) => void,
) {
	const digest = createHash("sha256"),
		encoder = new TextEncoder();
	let chunk = new Uint8Array(1_000_000),
		used = 0,
		bytes = 0,
		parts = 0;
	let pending = "";
	function emit(text: string) {
		for (let at = 0; at < text.length;) {
			let end = Math.min(at + 16_384, text.length);
			if (
				end < text.length &&
				text.charCodeAt(end - 1) >= 0xd800 &&
				text.charCodeAt(end - 1) <= 0xdbff
			)
				end--;
			const piece = encoder.encode(text.slice(at, end));
			at = end;
			for (let offset = 0; offset < piece.length;) {
				const count = Math.min(chunk.length - used, piece.length - offset);
				chunk.set(piece.subarray(offset, offset + count), used);
				used += count;
				offset += count;
				if (used === chunk.length) flush();
			}
		}
	}
	function flush() {
		if (!used) return;
		// Hash byte fragments independently, but archive parts MUST retain the original exact 1 MB boundaries.
		const piece = chunk.subarray(0, used);
		digest.update(piece);
		bytes += used;
		if (onChunk) onChunk(piece, parts);
		parts++;
		chunk = new Uint8Array(1_000_000);
		used = 0;
	}
	for (const token of canonicalTokens(value)) {
		pending += token;
		if (pending.length >= 16_384) {
			emit(pending);
			pending = "";
		}
	}
	if (pending) emit(pending);
	flush();
	return { hash: digest.digest("hex"), bytes, parts };
}

/** Pull parser for exact canonical tagged JSON. Containers can be visited without collecting their items. */
export class CanonicalReader {
	private readonly input: Iterator<Uint8Array>;
	private readonly decoder = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	});
	private text = "";
	private at = 0;
	private ended = false;
	constructor(chunks: Iterable<Uint8Array>) {
		this.input = chunks[Symbol.iterator]();
	}
	private peek(): string {
		while (this.at === this.text.length && !this.ended) {
			const next = this.input.next();
			this.at = 0;
			try {
				this.text = next.done
					? this.decoder.decode()
					: this.decoder.decode(next.value, { stream: true });
			} catch {
				fail("invalid snapshot UTF8");
			}
			if (next.done) this.ended = true;
		}
		return this.text[this.at] ?? "";
	}
	private take(): string {
		const char = this.peek();
		if (!char) fail("invalid persisted encoding");
		this.at++;
		return char;
	}
	private expect(char: string) {
		if (this.take() !== char) fail("noncanonical source payload");
	}
	private scalar(): unknown {
		let token = "";
		if (this.peek() === '"') {
			const pieces: string[] = [];
			let start = this.at;
			this.take();
			let escaped = false;
			for (;;) {
				if (this.at === this.text.length) {
					pieces.push(this.text.slice(start));
					this.peek();
					start = this.at;
				}
				const char = this.take();
				if (char === '"' && !escaped) {
					pieces.push(this.text.slice(start, this.at));
					token = pieces.join("");
					break;
				}
				escaped = char === "\\" && !escaped;
			}
		} else
			while (this.peek() && ![",", "]"].includes(this.peek()))
				token += this.take();
		let value: unknown;
		try {
			value = JSON.parse(token);
		} catch {
			fail("invalid persisted encoding");
		}
		if (JSON.stringify(value) !== token) fail("noncanonical source payload");
		return value;
	}
	private start(tag: string) {
		this.expect("[");
		if (this.scalar() !== tag) fail("invalid persisted encoding");
		this.expect(",");
	}
	array(visit: (index: number) => void): number {
		this.start("array");
		this.expect("[");
		let count = 0;
		if (this.peek() !== "]")
			for (;;) {
				visit(count++);
				if (this.peek() !== ",") break;
				this.take();
			}
		this.expect("]");
		this.expect("]");
		return count;
	}
	object(visit: (key: string) => void, expected?: string[]): void {
		this.start("object");
		if (this.scalar() !== "plain") fail("invalid source object type");
		this.expect(",");
		this.expect("[");
		let previous: string | null = null,
			index = 0;
		if (this.peek() !== "]")
			for (;;) {
				this.expect("[");
				const key = this.scalar();
				if (
					typeof key !== "string" ||
					(previous !== null && key <= previous) ||
					(expected && key !== expected[index])
				)
					fail("invalid source fields");
				previous = key;
				index++;
				this.expect(",");
				visit(key);
				this.expect("]");
				if (this.peek() !== ",") break;
				this.take();
			}
		this.expect("]");
		this.expect("]");
		if (expected && index !== expected.length) fail("invalid source fields");
	}
	value(allowGraph = false): unknown {
		return this.readValue(allowGraph);
	}
	private readValue(
		allowGraph: boolean,
		graph?: GraphRead,
		definition = false,
	): unknown {
		this.expect("[");
		const tag = this.scalar();
		if (definition && tag !== "object" && tag !== "array")
			fail("invalid graph definition");
		if (tag === "null") {
			this.expect("]");
			return null;
		}
		this.expect(",");
		if (tag === "graph") {
			if (!allowGraph || graph || this.scalar() !== 1)
				fail("invalid graph scope");
			this.expect(",");
			const scope: GraphRead = {
				nodes: [],
				completed: new Set(),
				references: 0,
				binaryDefinitions: new Set(),
				activeDefinitions: [],
			};
			const value = this.readValue(false, scope);
			this.expect("]");
			if (!scope.references || !scope.nodes.length || value !== scope.nodes[0])
				fail("unnecessary graph encoding");
			return value;
		}
		if (tag === "ref") {
			const id = this.scalar();
			this.expect("]");
			if (
				!graph ||
				!Number.isSafeInteger(id) ||
				!graph.completed.has(id as number) ||
				graph.binaryDefinitions.has(id as number)
			)
				fail("invalid graph reference");
			graph.references++;
			return graph.nodes[id as number];
		}
		if (tag === "def") {
			const id = this.scalar();
			if (!graph || id !== graph.nodes.length || !Number.isSafeInteger(id))
				fail("invalid graph definition");
			graph.nodes.push(undefined);
			graph.activeDefinitions.push(id as number);
			this.expect(",");
			const value = this.readValue(false, graph, true);
			this.expect("]");
			if (
				!value ||
				typeof value !== "object" ||
				value instanceof ArrayBuffer ||
				ArrayBuffer.isView(value)
			)
				fail("invalid graph definition");
			graph.nodes[id as number] = value;
			graph.completed.add(id as number);
			graph.activeDefinitions.pop();
			if (
				graph.binaryDefinitions.has(id as number) &&
				graph.activeDefinitions.length
			)
				graph.binaryDefinitions.add(
					graph.activeDefinitions[graph.activeDefinitions.length - 1]!,
				);
			return value;
		}
		if (graph && (tag === "object" || tag === "array") && !definition)
			fail("noncanonical graph node");
		if (tag === "string" || tag === "boolean" || tag === "number") {
			const value = this.scalar();
			this.expect("]");
			if (tag === "number" && value === "-0") return -0;
			if (
				typeof value !== tag ||
				(tag === "number" && (!Number.isFinite(value) || Object.is(value, -0)))
			)
				fail("invalid persisted encoding");
			return value;
		}
		if (tag === "array") {
			this.expect("[");
			const values: unknown[] = [];
			if (this.peek() !== "]")
				for (;;) {
					values.push(this.readValue(false, graph));
					if (this.peek() !== ",") break;
					this.take();
				}
			this.expect("]");
			this.expect("]");
			return values;
		}
		if (tag === "object") {
			const prototype = this.scalar();
			if (prototype !== "plain" && prototype !== "null")
				fail("invalid persisted encoding");
			this.expect(",");
			this.expect("[");
			const value: Record<string, unknown> =
				prototype === "null" ? Object.create(null) : {};
			let previous: string | null = null;
			if (this.peek() !== "]")
				for (;;) {
					this.expect("[");
					const key = this.scalar();
					if (typeof key !== "string" || (previous !== null && key <= previous))
						fail("noncanonical source payload");
					previous = key;
					this.expect(",");
					Object.defineProperty(value, key, {
						value: this.readValue(false, graph),
						enumerable: true,
						writable: true,
						configurable: true,
					});
					this.expect("]");
					if (this.peek() !== ",") break;
					this.take();
				}
			this.expect("]");
			this.expect("]");
			return value;
		}
		if (tag === "buffer" || tag === "view") {
			if (graph && graph.activeDefinitions.length)
				graph.binaryDefinitions.add(
					graph.activeDefinitions[graph.activeDefinitions.length - 1]!,
				);
			let type: unknown;
			if (tag === "view") {
				type = this.scalar();
				this.expect(",");
			}
			this.expect("[");
			const bytes: number[] = [];
			if (this.peek() !== "]")
				for (;;) {
					const byte = this.scalar();
					if (
						!Number.isInteger(byte) ||
						(byte as number) < 0 ||
						(byte as number) > 255
					)
						fail("invalid binary byte");
					bytes.push(byte as number);
					if (this.peek() !== ",") break;
					this.take();
				}
			this.expect("]");
			const buffer = Uint8Array.from(bytes).buffer;
			if (tag === "buffer") {
				this.expect("]");
				return buffer;
			}
			this.expect(",");
			const offset = this.scalar();
			this.expect(",");
			const length = this.scalar();
			this.expect("]");
			if (
				!Number.isSafeInteger(offset) ||
				!Number.isSafeInteger(length) ||
				(offset as number) < 0 ||
				(length as number) < 0 ||
				(offset as number) + (length as number) > buffer.byteLength
			)
				fail("invalid binary view bounds");
			if (type === "DataView")
				return new DataView(buffer, offset as number, length as number);
			if (typeof type !== "string" || !Object.hasOwn(views, type))
				fail("unsupported binary type");
			const View = views[type as keyof typeof views];
			if (
				(offset as number) % View.BYTES_PER_ELEMENT ||
				(length as number) % View.BYTES_PER_ELEMENT
			)
				fail("invalid binary view bounds");
			try {
				return new View(
					buffer,
					offset as number,
					(length as number) / View.BYTES_PER_ELEMENT,
				);
			} catch {
				fail("invalid binary view bounds");
			}
		}
		fail("invalid persisted encoding");
	}
	finish() {
		if (this.peek()) fail("extra source payload");
	}
}
