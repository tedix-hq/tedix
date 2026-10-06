export class OAuthError extends Error {
	readonly errorCode: string;
	readonly errorDescription: string;

	constructor(errorCode: string, errorDescription: string) {
		super(`OAuth error: ${errorCode} - ${errorDescription}`);
		this.name = "OAuthError";
		this.errorCode = errorCode;
		this.errorDescription = errorDescription;
	}
}
