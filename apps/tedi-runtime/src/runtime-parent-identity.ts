import { isDeepStrictEqual } from "node:util";
import { resolveCanonicalRuntimeParentIdentity } from "@tedix/db/queries/tedi-runtime-bootstrap";

type StoredFact = { present: boolean; value: unknown };
interface ParentIdentityFacts {
	objectId: string;
	name: string;
	nativeName: string | undefined;
	parentPath: unknown;
	selfPath: unknown;
	storedName: StoredFact;
	isFacet: StoredFact;
	facetName: StoredFact;
	storedParentPath: StoredFact;
	local: {
		tediId: string;
		orgId: string;
		slug: string;
		identityLoaded: boolean;
		configGeneration: number;
	};
}
const uuid = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);

/** Preserve exact presence, including a present undefined value. No storage writes. */
function parentIdentityStoredFact(kv: SyncKvStorage, key: string): StoredFact {
	const entry = [...kv.list({ start: key, end: `${key}\0`, limit: 1 })][0];
	return entry?.[0] === key
		? { present: true, value: entry[1] }
		: { present: false, value: undefined };
}

/** Read only the actual local facts used by cold parent discovery. */
export function captureRuntimeParentIdentity(input: {
	ctx: Pick<DurableObjectState, "id" | "storage">;
	agent: { name: string; parentPath: unknown; selfPath: unknown };
	state: Omit<ParentIdentityFacts["local"], "configGeneration">;
	configGeneration: number;
}): ParentIdentityFacts {
	return {
		objectId: input.ctx.id.toString(),
		name: input.agent.name,
		nativeName: input.ctx.id.name,
		parentPath: input.agent.parentPath,
		selfPath: input.agent.selfPath,
		storedName: parentIdentityStoredFact(input.ctx.storage.kv, "__ps_name"),
		isFacet: parentIdentityStoredFact(
			input.ctx.storage.kv,
			"cf_agents_is_facet",
		),
		facetName: parentIdentityStoredFact(
			input.ctx.storage.kv,
			"cf_agents_facet_name",
		),
		storedParentPath: parentIdentityStoredFact(
			input.ctx.storage.kv,
			"cf_agents_parent_path",
		),
		local: {
			tediId: input.state.tediId,
			orgId: input.state.orgId,
			slug: input.state.slug,
			identityLoaded: input.state.identityLoaded,
			configGeneration: input.configGeneration,
		},
	};
}

function rootFacts(f: ParentIdentityFacts): boolean {
	return (
		typeof f.name === "string" &&
		f.name.length > 0 &&
		(f.nativeName === undefined || f.nativeName === f.name) &&
		(!f.storedName.present || f.storedName.value === f.name) &&
		(!f.isFacet.present || f.isFacet.value === false) &&
		(!f.facetName.present || f.facetName.value === null) &&
		(!f.storedParentPath.present ||
			(Array.isArray(f.storedParentPath.value) &&
				f.storedParentPath.value.length === 0)) &&
		Array.isArray(f.parentPath) &&
		f.parentPath.length === 0 &&
		isDeepStrictEqual(f.selfPath, [
			{ className: "AgentTediDO", name: f.name },
		]) &&
		typeof f.local.tediId === "string" &&
		typeof f.local.orgId === "string" &&
		typeof f.local.slug === "string" &&
		typeof f.local.identityLoaded === "boolean" &&
		Number.isSafeInteger(f.local.configGeneration) &&
		f.local.configGeneration >= 0
	);
}

/** Cold discovery only: local pins fence this D1 read window, not later effects. */
export async function resolveRuntimeParentIdentity(input: {
	db: Parameters<typeof resolveCanonicalRuntimeParentIdentity>[0];
	capture: () => ParentIdentityFacts;
	physicalIdForName: (name: string) => string;
}): Promise<{ tediId: string; orgId: string; slug: string } | null> {
	let original: ParentIdentityFacts;
	try {
		original = structuredClone(input.capture());
		if (!rootFacts(original)) return null;
	} catch {
		return null;
	}
	const row = await resolveCanonicalRuntimeParentIdentity(
		input.db,
		original.name,
	);
	try {
		if (
			!isDeepStrictEqual(original, input.capture()) ||
			!row ||
			!uuid(row.id) ||
			!uuid(row.orgId) ||
			row.runtimeKind !== "agent" ||
			typeof row.slug !== "string" ||
			!row.slug
		)
			return null;
		const effectiveName = row.isolateAgentId ?? row.slug;
		if (
			typeof effectiveName !== "string" ||
			effectiveName !== original.name ||
			input.physicalIdForName(effectiveName) !== original.objectId
		)
			return null;
		if (
			(original.local.tediId && original.local.tediId !== row.id) ||
			(original.local.orgId && original.local.orgId !== row.orgId) ||
			(original.local.slug && original.local.slug !== row.slug)
		)
			return null;
		return { tediId: row.id, orgId: row.orgId, slug: row.slug };
	} catch {
		return null;
	}
}
