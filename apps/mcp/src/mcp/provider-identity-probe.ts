import { deriveHkdfHmacKey, hmacSha256 } from "@tedix/worker-kit/crypto";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** The caller must load this from an independently reviewed immutable profile.
 * Tool metadata, caller input and upstream readOnlyHint do not confer trust. */
export interface ProviderIdentityProbeProfile {
	version: 1;
	operation: string;
	selectors: string[][];
}

export function validProviderIdentityProbeProfile(
	profile: ProviderIdentityProbeProfile,
): boolean {
	if (
		!isRecord(profile) ||
		Object.keys(profile).some(
			(key) => !["version", "operation", "selectors"].includes(key),
		) ||
		profile.version !== 1 ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(profile.operation) ||
		!Array.isArray(profile.selectors) ||
		profile.selectors.length < 1 ||
		profile.selectors.length > 4
	)
		return false;
	const seen = new Set<string>();
	return profile.selectors.every((path) => {
		if (
			!Array.isArray(path) ||
			path.length < 1 ||
			path.length > 4 ||
			path.some(
				(segment) =>
					typeof segment !== "string" ||
					!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(segment) ||
					segment === "constructor" ||
					segment === "prototype",
			)
		)
			return false;
		const id = JSON.stringify(path);
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

/** Return only an opaque, purpose-separated digest; do not log identity fields. */
export async function providerIdentityDigest(input: {
	profile: ProviderIdentityProbeProfile;
	result: unknown;
	binding: string;
	secret: string;
	assertions?: Array<{ path: string[]; value: string }>;
}): Promise<string | null> {
	const { profile, result, binding, secret } = input;
	if (
		!validProviderIdentityProbeProfile(profile) ||
		!binding ||
		!secret ||
		!isRecord(result) ||
		result.isError === true
	)
		return null;
	let content: unknown = result.structuredContent;
	if (
		content === undefined &&
		Array.isArray(result.content) &&
		result.content.length === 1
	) {
		const block = result.content[0];
		if (
			!isRecord(block) ||
			block.type !== "text" ||
			typeof block.text !== "string" ||
			block.text.length > 16384
		)
			return null;
		try {
			content = JSON.parse(block.text);
		} catch {
			return null;
		}
	}
	const values: string[] = [];
	for (const path of profile.selectors) {
		let value: unknown = content;
		for (const segment of path) {
			if (!isRecord(value) || !Object.hasOwn(value, segment)) return null;
			value = value[segment];
		}
		if (typeof value !== "string" || !value || value.length > 1024) return null;
		values.push(value);
	}
	if (input.assertions) {
		if (
			!Array.isArray(input.assertions) ||
			input.assertions.length > profile.selectors.length
		)
			return null;
		const seen = new Set<string>();
		for (const assertion of input.assertions) {
			if (
				!assertion ||
				!Array.isArray(assertion.path) ||
				typeof assertion.value !== "string" ||
				!assertion.value
			)
				return null;
			const key = JSON.stringify(assertion.path);
			const index = profile.selectors.findIndex(
				(path) => JSON.stringify(path) === key,
			);
			if (index < 0 || seen.has(key) || values[index] !== assertion.value)
				return null;
			seen.add(key);
		}
	}
	const key = await deriveHkdfHmacKey(
		secret,
		"tedix:provider-identity-probe:v1",
	);
	const bytes = await hmacSha256(
		key,
		JSON.stringify([
			binding,
			profile.version,
			profile.operation,
			profile.selectors,
			values,
		]),
	);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
