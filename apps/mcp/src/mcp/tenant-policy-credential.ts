import { SelectedConnectionCredentialSchema } from "@tedix/api-contract/schemas/connections";

/** Compare a service-resolved selection and an independently verified account revision. */
export function matchesTenantPolicyCredential(
	expected: unknown,
	actual: unknown,
	expectedAccountRevision: string,
): boolean {
	const reviewed = SelectedConnectionCredentialSchema.safeParse(expected);
	const selected = SelectedConnectionCredentialSchema.safeParse(actual);
	if (!reviewed.success || !selected.success) return false;
	if (
		!/^[a-f0-9]{64}$/.test(expectedAccountRevision) ||
		expectedAccountRevision !== selected.data.accountRevisionDigest
	)
		return false;
	const left = reviewed.data;
	const right = selected.data;
	// A default vault credential has no proven stable external-account binding.
	if (!left.connectionInstanceId || !right.connectionInstanceId) return false;
	return (
		left.organizationId === right.organizationId &&
		left.providerId === right.providerId &&
		left.scope === right.scope &&
		left.connectionInstanceId === right.connectionInstanceId &&
		(left.scope !== "user" ||
			(right.scope === "user" && left.userId === right.userId))
	);
}
