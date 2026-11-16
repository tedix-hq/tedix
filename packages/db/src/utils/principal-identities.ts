export class PrincipalIdentityConflictError extends Error {
	readonly code = "PRINCIPAL_IDENTITY_CONFLICT";

	constructor(message: string) {
		super(message);
		this.name = "PrincipalIdentityConflictError";
	}
}
