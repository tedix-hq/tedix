/** Keep the browser's existing room identity when API agents join its stream. */
export function appDraftRoomName(scope: {
	tenantSlug: string;
	workspaceId: string;
	gadgetId: string;
	proposalId: string;
	baseRevisionId: string;
}): string {
	return `${scope.tenantSlug}:${scope.workspaceId}:app-draft:${scope.gadgetId}:${scope.proposalId}:${scope.baseRevisionId}`;
}
