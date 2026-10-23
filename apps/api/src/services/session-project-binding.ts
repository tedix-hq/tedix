import type { OrganizationMetadata } from "@tedix/api-contract/schemas/organization";

export function sessionProjectBinding(
	label: string,
	bindings: NonNullable<OrganizationMetadata["sessionProjectBindings"]>,
): string | undefined {
	const name = label.trim().toLocaleUpperCase("en-US");
	return bindings
		.filter(({ prefix }) => {
			const candidate = prefix.trim().toLocaleUpperCase("en-US");
			if (!candidate || !name.startsWith(candidate)) return false;
			const next = name.slice(candidate.length, candidate.length + 1);
			return !next || /[\s:·—–\-/]/u.test(next);
		})
		.sort((a, b) => b.prefix.trim().length - a.prefix.trim().length)[0]
		?.projectId;
}
