/**
 * Declarative host route context.
 *
 * Every embedded host has to answer the same question on every navigation:
 * which page is the person on, and what does it refer to? Hosts used to answer
 * it in framework code — regular expressions over `location.pathname`, one
 * effect per router, rewritten for the next provider. The answer is data, so
 * the host declares it once as rules and the runtime evaluates them.
 *
 * Rules are host-authored and therefore untrusted: this module bounds them, and
 * `normalizeEmbeddedPageContext` bounds the context they produce before it
 * crosses the signed session seam. A route rule never grants authority.
 */

export interface HostRouteRule {
	/**
	 * Path pattern: literal segments, `:name` captures, and a trailing `*` that
	 * also matches its own index (`/settings/*` matches `/settings`).
	 */
	match: string;
	routeKey?: string;
	title?: string;
	entity?: { type: string; id: string; label?: string };
	/** Extra params merged over the captures; values may interpolate captures. */
	params?: Record<string, string>;
}

export interface HostRouteMatch {
	pathname: string;
	routeKey?: string;
	title?: string;
	params?: Record<string, string>;
	entity?: { type: string; id: string; label?: string };
}

const MAX_RULES = 64;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const TOKEN = /:([A-Za-z][A-Za-z0-9_]{0,31})/g;

interface CompiledRule {
	segments: string[];
	wildcard: boolean;
	rule: HostRouteRule;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function compileRule(value: unknown): CompiledRule | null {
	if (!isRecord(value)) return null;
	const match = value.match;
	if (typeof match !== "string" || !match.startsWith("/") || match.length > 500)
		return null;
	const raw = match.split("/").slice(1);
	const wildcard = raw.at(-1) === "*";
	const segments = wildcard ? raw.slice(0, -1) : raw;
	// A trailing "/" is written as an empty final segment; paths tolerate both.
	if (segments.at(-1) === "" && segments.length > 1) segments.pop();
	for (const segment of segments)
		if (segment.startsWith(":") && !PARAM_NAME.test(segment.slice(1)))
			return null;
	const rule: HostRouteRule = { match };
	if (typeof value.routeKey === "string") rule.routeKey = value.routeKey;
	if (typeof value.title === "string") rule.title = value.title;
	if (isRecord(value.entity)) {
		const { type, id, label } = value.entity;
		if (typeof type === "string" && type && typeof id === "string" && id)
			rule.entity = {
				type,
				id,
				...(typeof label === "string" && label ? { label } : {}),
			};
	}
	if (isRecord(value.params)) {
		const params: Record<string, string> = {};
		for (const [key, param] of Object.entries(value.params).slice(0, 24))
			if (PARAM_NAME.test(key) && typeof param === "string")
				params[key] = param;
		if (Object.keys(params).length) rule.params = params;
	}
	return { segments, wildcard, rule };
}

/** Interpolate `:name` tokens; an unresolved token drops the whole value. */
function fill(
	template: string,
	captures: Record<string, string>,
): string | null {
	let resolved = true;
	const value = template.replace(TOKEN, (token, name: string) => {
		const capture = captures[name];
		if (capture === undefined) {
			resolved = false;
			return token;
		}
		return capture;
	});
	return resolved ? value : null;
}

function matchRule(
	compiled: CompiledRule,
	segments: string[],
): Record<string, string> | null {
	if (
		compiled.wildcard
			? segments.length < compiled.segments.length
			: segments.length !== compiled.segments.length
	)
		return null;
	const captures: Record<string, string> = {};
	for (const [index, expected] of compiled.segments.entries()) {
		const actual = segments[index] as string;
		if (expected.startsWith(":")) {
			if (!actual) return null;
			captures[expected.slice(1)] = decodeURIComponent(actual);
			continue;
		}
		if (expected !== actual) return null;
	}
	return captures;
}

/**
 * Compile host route rules into a matcher. Returns `null` when the host
 * declared nothing usable, so callers can skip navigation binding entirely.
 */
export function compileHostRouteMap(
	value: unknown,
): ((pathname: string) => HostRouteMatch) | null {
	if (!Array.isArray(value) || !value.length) return null;
	const compiled: CompiledRule[] = [];
	for (const entry of value.slice(0, MAX_RULES)) {
		const rule = compileRule(entry);
		if (rule) compiled.push(rule);
	}
	if (!compiled.length) return null;
	return (pathname: string) => {
		const path = typeof pathname === "string" ? pathname : "/";
		const segments = path.split("/").slice(1);
		if (segments.at(-1) === "" && segments.length > 1) segments.pop();
		for (const candidate of compiled) {
			const captures = matchRule(candidate, segments);
			if (!captures) continue;
			const { rule } = candidate;
			const context: HostRouteMatch = { pathname: path };
			if (rule.routeKey) context.routeKey = rule.routeKey;
			if (rule.title) {
				const title = fill(rule.title, captures);
				if (title) context.title = title;
			}
			const params: Record<string, string> = { ...captures };
			for (const [key, template] of Object.entries(rule.params ?? {})) {
				const filled = fill(template, captures);
				if (filled) params[key] = filled;
			}
			if (Object.keys(params).length) context.params = params;
			if (rule.entity) {
				const id = fill(rule.entity.id, captures);
				const label = rule.entity.label
					? fill(rule.entity.label, captures)
					: null;
				if (id)
					context.entity = {
						type: rule.entity.type,
						id,
						...(label ? { label } : {}),
					};
			}
			return context;
		}
		return { pathname: path };
	};
}

/** Parse the `data-tedix-routes` attribute; malformed JSON declares nothing. */
export function parseHostRouteRules(value: unknown): unknown {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

/**
 * The slice of `window` this module needs. The widget builds against Workers
 * types, so the DOM lib is unavailable here and the shape is declared
 * structurally rather than borrowed from `Window`.
 */
export interface HostNavigationTarget {
	location: { pathname: string };
	history: Record<string, unknown>;
	addEventListener(name: string, listener: () => void): void;
	removeEventListener(name: string, listener: () => void): void;
}

type HistoryMethod = (...args: unknown[]) => unknown;

/**
 * Call `onNavigate` whenever the SPA changes location. History methods are
 * patched once and restored on dispose, so a host that mounts and unmounts the
 * widget (an account switch) leaves no listener or patch behind.
 */
export function bindHostNavigation(
	target: HostNavigationTarget,
	onNavigate: (pathname: string) => void,
): () => void {
	const history = target.history;
	const originals = new Map<string, HistoryMethod>();
	let disposed = false;
	const announce = () => {
		if (!disposed) onNavigate(target.location.pathname);
	};
	for (const method of ["pushState", "replaceState"]) {
		const original = history[method];
		if (typeof original !== "function") continue;
		const native = original as HistoryMethod;
		originals.set(method, native);
		history[method] = function patchedHistoryMethod(
			this: unknown,
			...args: unknown[]
		) {
			const result = native.apply(this, args);
			announce();
			return result;
		};
	}
	target.addEventListener("popstate", announce);
	return () => {
		disposed = true;
		for (const [method, original] of originals) history[method] = original;
		target.removeEventListener("popstate", announce);
	};
}
