import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";

export function assertNativeResearchCheckout(
	plan: DelegationCapabilityPlan | undefined,
	environment: { ready: boolean; preparation: string } | undefined,
): void {
	if (!plan?.requiredCapabilities.includes("repository.read")) return;
	if (!environment?.ready || environment.preparation !== "repository")
		throw new Error(
			"Delegation preflight failed: empty or unready native repository checkout. Source research cannot run here; return to Home for a prepared checkout or bounded source selection (large repositories may be too_large_for_native). No clone or workstation setup was attempted",
		);
}

/** Read metadata with the child's own credential; discovery never grants access. */
export async function preflightDelegationTools(
	plan: DelegationCapabilityPlan | undefined,
	execute: (code: string) => Promise<unknown>,
): Promise<string[]> {
	if (!plan)
		throw new Error(
			"Delegation preflight failed: native research requires exact source/tool mappings; return to Home before inference or setup",
		);
	if (plan.missingCapabilities.length)
		throw new Error(
			`Delegation preflight failed: missing capabilities ${plan.missingCapabilities.join(", ")}; return to Home without inference or setup`,
		);
	const callables = [
		...new Set(plan.allowedToolIds.filter((id) => id.includes("."))),
	];
	if (!callables.length) return [];
	if (
		callables.length > 16 ||
		callables.some((id) => !/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(id))
	)
		throw new Error(
			"Delegation preflight failed: invalid or excessive required callables",
		);
	const rows = await execute(
		`async () => await Promise.all(${JSON.stringify(callables)}.map(async (callable) => await discover.describe(callable)))`,
	);
	if (!Array.isArray(rows))
		throw new Error(
			"Delegation preflight failed: tool authority could not be verified; return to Home",
		);
	return callables.map((callable) => {
		const row = rows.find(
			(value) =>
				value && typeof value === "object" && value.callable === callable,
		);
		if (
			!row ||
			row.authorized !== true ||
			!row.parameters ||
			typeof row.parameters !== "object"
		)
			throw new Error(
				`Delegation preflight failed: ${callable} is unavailable or unauthorized; missing scopes: ${Array.isArray(row?.missingScopes) ? row.missingScopes.join(", ") : "unverified"}. No scopes were added; return to Home`,
			);
		const schema = JSON.stringify({ callable, parameters: row.parameters });
		if (schema.length > 16000)
			throw new Error(
				`Delegation preflight failed: schema too large for ${callable}`,
			);
		return schema;
	});
}
