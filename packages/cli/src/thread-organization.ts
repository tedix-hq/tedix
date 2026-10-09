import { normalizeCodeResult } from "./code-result";
import { looksLikeUuid } from "./shared";

/**
 * Saved conversation names (`--thread`, `tedix threads`) are fenced per
 * organization, so the organization id must come from the gateway the command
 * is actually talking to, never from a saved workspace or a slug.
 *
 * `codemode.__runtime()` is async. Reading `.organizationId` off the pending
 * promise yields `undefined`, which is what made every `--thread` command fail
 * with "Could not verify the organization" while the same command without a
 * thread worked. The check stays strict: anything but a UUID organization id
 * throws.
 */
export async function resolveThreadOrganizationId(client: {
	runCode(source: string): Promise<unknown>;
}): Promise<string> {
	const runtime = normalizeCodeResult(
		await client.runCode(
			"async () => { const runtime = await codemode.__runtime(); return { organizationId: runtime.organizationId }; }",
		),
	).value;
	if (
		!runtime ||
		typeof runtime !== "object" ||
		!("organizationId" in runtime) ||
		typeof runtime.organizationId !== "string" ||
		!looksLikeUuid(runtime.organizationId)
	)
		throw new Error(
			"Could not verify the organization for saved conversation names.",
		);
	return runtime.organizationId;
}
