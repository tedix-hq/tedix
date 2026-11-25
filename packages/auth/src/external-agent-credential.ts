/** Local credentials own no Descope client and must never be sent to its delete API. */
export function isLocalExternalAgentCredential(id: string): boolean {
	return id.startsWith("wif:") || id.startsWith("session:");
}
