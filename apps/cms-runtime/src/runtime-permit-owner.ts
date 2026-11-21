declare const __CMS_RUNTIME_PERMIT_OWNER__: string;

export function runtimePermitOwnerId(): string {
	return typeof __CMS_RUNTIME_PERMIT_OWNER__ === "string"
		? __CMS_RUNTIME_PERMIT_OWNER__
		: "unknown";
}

export function runtimePermitId(): string {
	const ownerId = runtimePermitOwnerId();
	return /^[0-9a-f]{40}$/.test(ownerId)
		? `runtime:${ownerId}:${crypto.randomUUID()}`
		: crypto.randomUUID();
}
