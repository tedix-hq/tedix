/**
 * One address path for every Durable Object namespace.
 *
 * A Durable Object only stays inside a jurisdiction when the code asks for it:
 * `namespace.jurisdiction("eu").idFromName(name)` and the unrestricted
 * `namespace.idFromName(name)` resolve DIFFERENT objects. Feeding an id from
 * one side into the other's `get` misroutes or rejects, so every
 * `idFromName`/`idFromString`/`newUniqueId`/`getByName` call must go through
 * `durableObjectNamespace` first — never mix a bare binding with a
 * jurisdiction-selected id.
 *
 * The jurisdiction comes from `env.DO_JURISDICTION`, an optional deployment
 * var the private ops overlay sets per account (`eu` on the EU installation,
 * unset elsewhere so existing object ids stay stable). An unrecognized
 * non-empty value fails closed: silent global placement would breach the
 * residency the flag exists to enforce.
 *
 * `scripts/lint-do-jurisdiction.ts` bans the addressing methods outside this
 * module, so a new namespace cannot bypass this path.
 */

// Local spellings of the Cloudflare types — consumers compile this source
// without @cloudflare/workers-types, so the globals cannot be named here.
type DurableObjectJurisdiction = "eu" | "fedramp" | "fedramp-high" | "us";
interface DurableObjectNamespaceNewUniqueIdOptions {
	jurisdiction?: DurableObjectJurisdiction;
}

const DURABLE_OBJECT_JURISDICTIONS: ReadonlySet<string> = new Set([
	"eu",
	"fedramp",
	"fedramp-high",
	"us",
]);

/**
 * The configured DO jurisdiction, or undefined when unset/misconfigured-as-empty.
 * Throws on a set-but-invalid value so a typo cannot silently place objects
 * outside the intended jurisdiction.
 */
export function readDurableObjectJurisdiction(
	env: unknown,
): DurableObjectJurisdiction | undefined {
	const raw = (env as { DO_JURISDICTION?: unknown } | null | undefined)
		?.DO_JURISDICTION;
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw === "string" && DURABLE_OBJECT_JURISDICTIONS.has(raw))
		return raw as DurableObjectJurisdiction;
	throw new Error(
		`Invalid DO_JURISDICTION ${JSON.stringify(raw)}; expected one of: eu, fedramp, fedramp-high, us`,
	);
}

/**
 * The namespace restricted to the configured jurisdiction, or the namespace
 * itself when `DO_JURISDICTION` is unset. Pass the returned object — not the
 * original binding — to every `get`, RPC caller, retry and self-identity
 * check so name and jurisdiction stay consistent.
 */
export function durableObjectNamespace<NS>(namespace: NS, env: unknown): NS {
	const jurisdiction = readDurableObjectJurisdiction(env);
	if (!jurisdiction) return namespace;
	const select = (
		namespace as { jurisdiction?: (value: string) => NS } | null | undefined
	)?.jurisdiction;
	if (typeof select !== "function")
		throw new Error(
			`DO_JURISDICTION=${jurisdiction} is set but this binding does not support jurisdiction()`,
		);
	return select.call(namespace, jurisdiction);
}

/** `idFromName` on the jurisdiction-selected namespace (self-identity checks, stored ids). */
export function durableObjectIdFromName<ID>(
	namespace: { idFromName(name: string): ID },
	env: unknown,
	name: string,
): ID {
	return durableObjectNamespace(namespace, env).idFromName(name);
}

/** `get(idFromName(name))` on the jurisdiction-selected namespace — exactly `getByName(name)`. */
export function durableObjectStubByName<ID, S>(
	namespace: { idFromName(name: string): ID; get(id: ID): S },
	env: unknown,
	name: string,
): S {
	const scoped = durableObjectNamespace(namespace, env);
	return scoped.get(scoped.idFromName(name));
}

/** `newUniqueId` on the jurisdiction-selected namespace. */
export function durableObjectNewUniqueId<ID>(
	namespace: {
		newUniqueId(options?: DurableObjectNamespaceNewUniqueIdOptions): ID;
	},
	env: unknown,
	options?: DurableObjectNamespaceNewUniqueIdOptions,
): ID {
	return durableObjectNamespace(namespace, env).newUniqueId(options);
}

/** `idFromString` on the jurisdiction-selected namespace. */
export function durableObjectIdFromString<ID>(
	namespace: { idFromString(id: string): ID },
	env: unknown,
	id: string,
): ID {
	return durableObjectNamespace(namespace, env).idFromString(id);
}
