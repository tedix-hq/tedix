export type ConsentPermission = {
	name: string;
	description: string;
	group: string;
	authority: string | null;
	admin: boolean;
	required: boolean;
};

export type ConsentPermissionGroup = {
	name: string;
	permissions: ConsentPermission[];
	highRisk: boolean;
};

export type ConsentScopeGroupDefinition = {
	label: string;
	description?: string;
	scopes: readonly string[];
};

const PLATFORM_SCOPE_DESCRIPTIONS: Record<string, string> = {
	"platform:admin": "Administer the Tedix platform across organizations",
	"connections.read": "Read verified connected app data",
	"connections.execute": "Run connected app actions, including writes",
	"connections.admin": "Run destructive connected app actions",
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function scopeName(value: unknown): string | null {
	if (typeof value === "string") return value.trim() || null;
	const valueRecord = record(value);
	for (const key of ["name", "scope", "id"]) {
		const candidate = valueRecord?.[key];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return null;
}

function titleCase(value: string): string {
	return value
		.split(/[._:/-]+/)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}

function scopeDescription(value: unknown, fallback: string): string {
	const valueRecord = record(value);
	for (const key of ["desc", "description", "displayName", "label"]) {
		const candidate = valueRecord?.[key];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return fallback;
}

function definedGroup(
	name: string,
	definitions: readonly ConsentScopeGroupDefinition[],
): string | null {
	return (
		definitions.find((definition) => definition.scopes.includes(name))?.label ??
		null
	);
}

/**
 * Canonical presentation model for every permission list Tedix owns. Exact
 * scope strings remain untouched; only their human-facing grouping is derived.
 */
export function normalizeConsentPermissions(
	value: unknown,
	definitions: readonly ConsentScopeGroupDefinition[] = [],
): ConsentPermission[] {
	const values = Array.isArray(value)
		? value
		: record(value)
			? Object.values(value as Record<string, unknown>)
			: [];
	const seen = new Set<string>();
	const permissions: ConsentPermission[] = [];
	for (const raw of values) {
		const name = scopeName(raw);
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const colonParts = name.split(":");
		const capability =
			colonParts.length > 1 ? colonParts.slice(1).join(":") : name;
		const capabilityParts = capability.split(".");
		const authority =
			capabilityParts.length > 1 ? capabilityParts.at(-1)! : null;
		const group =
			definedGroup(name, definitions) ??
			(name.startsWith("connections.") ? "Connected apps" : null) ??
			(name === "platform:admin"
				? "Platform administration"
				: capabilityParts.length > 1
					? titleCase(capabilityParts.slice(0, -1).join("."))
					: titleCase(capability));
		permissions.push({
			name,
			description:
				PLATFORM_SCOPE_DESCRIPTIONS[name] ??
				scopeDescription(raw, titleCase(capability)),
			group: group || "Other",
			authority,
			admin: name === "platform:admin" || authority === "admin",
			required:
				record(raw)?.required === true || record(raw)?.optional === false,
		});
	}
	return permissions.sort(
		(left, right) =>
			left.group.localeCompare(right.group) ||
			left.name.localeCompare(right.name),
	);
}

export function groupConsentPermissions(
	permissions: readonly ConsentPermission[],
): ConsentPermissionGroup[] {
	const grouped = new Map<string, ConsentPermission[]>();
	for (const permission of permissions) {
		const list = grouped.get(permission.group) ?? [];
		list.push(permission);
		grouped.set(permission.group, list);
	}
	return [...grouped.entries()].map(([name, groupedPermissions]) => ({
		name,
		permissions: groupedPermissions,
		highRisk: groupedPermissions.some((permission) => permission.admin),
	}));
}
