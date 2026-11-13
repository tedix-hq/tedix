export interface AuditCursor {
	timestamp: string;
	id: string;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
	return btoa(encodeURIComponent(JSON.stringify(cursor)));
}

export function decodeAuditCursor(value: string): AuditCursor | undefined {
	try {
		const cursor: unknown = JSON.parse(decodeURIComponent(atob(value)));
		if (!cursor || typeof cursor !== "object") return undefined;
		const { timestamp, id } = cursor as Record<string, unknown>;
		if (
			typeof timestamp !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) ||
			!Number.isFinite(Date.parse(timestamp)) ||
			typeof id !== "string" ||
			id.length === 0 ||
			id.length > 255
		)
			return undefined;
		return { timestamp, id };
	} catch {
		return undefined;
	}
}
