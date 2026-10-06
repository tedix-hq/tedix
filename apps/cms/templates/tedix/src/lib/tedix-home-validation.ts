import dashboardCopyKeys from "./tedix-home-copy-keys.json";

export interface HomepagePolicy {
	collection: string;
	slugs: string[];
	dependencies: Array<{ when: string; requires: string[] }>;
}

export const DEFAULT_HOMEPAGE_POLICY: HomepagePolicy = {
	collection: "pages",
	slugs: ["home"],
	dependencies: [
		{ when: "tedix_use_cases", requires: ["tedix_commerce_demo"] },
		{ when: "tedix_timeline", requires: ["tedix_dashboard_demo"] },
	],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export function readHomepagePolicy(value: unknown): HomepagePolicy {
	if (value === null || value === undefined) return DEFAULT_HOMEPAGE_POLICY;
	if (
		!isObject(value) ||
		typeof value.collection !== "string" ||
		!value.collection ||
		!Array.isArray(value.slugs) ||
		!value.slugs.every((slug) => typeof slug === "string" && slug.length > 0) ||
		!Array.isArray(value.dependencies) ||
		!value.dependencies.every(
			(rule) =>
				isObject(rule) &&
				typeof rule.when === "string" &&
				rule.when.length > 0 &&
				Array.isArray(rule.requires) &&
				rule.requires.every(
					(type) => typeof type === "string" && type.length > 0,
				),
		)
	) {
		throw new Error("Homepage publication policy settings are invalid.");
	}
	return value as unknown as HomepagePolicy;
}

export function isTedixHomepageEntry(
	collection: string,
	content: Record<string, unknown>,
	policy: HomepagePolicy,
): boolean {
	return (
		collection === policy.collection &&
		typeof content.slug === "string" &&
		policy.slugs.includes(content.slug)
	);
}

/** Native block schemas validate fields and versions when writing content.
 * This hook owns only dependencies imposed by the theme renderer.
 */
export function validateHomepagePublishContent(
	content: unknown,
	policy: HomepagePolicy,
): string | null {
	if (!Array.isArray(content)) return "Homepage content must be a block list.";
	const blocks = content.filter(isObject);
	if (blocks.length !== content.length)
		return "Each homepage block must be an object.";
	const types = new Set(blocks.map((block) => block._type));
	for (const dependency of policy.dependencies) {
		if (!types.has(dependency.when)) continue;
		for (const required of dependency.requires) {
			if (!types.has(required))
				return `${dependency.when} needs a ${required} block for its interactive demo.`;
		}
	}
	for (const block of blocks) {
		if (block._type !== "tedix_dashboard_demo") continue;
		const copy = block.copy;
		if (!Array.isArray(copy)) return "Tedix dashboard copy must be a list.";
		const keys = copy.filter(isObject).map((row) => row.key);
		if (
			new Set(keys).size !== keys.length ||
			dashboardCopyKeys.some((key) => !keys.includes(key))
		) {
			return "Tedix dashboard copy needs every unique interface key.";
		}
	}
	return null;
}
