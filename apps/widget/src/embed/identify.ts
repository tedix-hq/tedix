/** Identity comes only from the host's authenticated same-origin endpoint. */
export interface WidgetIdentity {
	installationId: string;
	user: {
		hostUserId: string;
		externalTenantId: string;
		name: string | null;
		email: string | null;
		role: string | null;
		customAttributes: Record<string, string | number | boolean | null>;
		firstSeenAt: string;
		lastSeenAt: string;
	};
	company: {
		externalTenantId: string;
		name: string | null;
		customAttributes: Record<string, string | number | boolean | null>;
	};
}

export function createWidgetIdentify(options: {
	endpoint: string;
	origin: string;
	fetch: typeof fetch;
	onIdentity: (identity: WidgetIdentity, changed: boolean) => void;
}) {
	const url = new URL(options.endpoint, options.origin);
	if (
		url.origin !== options.origin ||
		url.username ||
		url.password ||
		!/^https?:$/.test(url.protocol)
	)
		throw new Error("Widget identify endpoint must be same-origin");
	let identity: WidgetIdentity | null = null;
	let generation = 0;
	let pending: AbortController | null = null;
	let stopped = false;
	return {
		async identify(): Promise<WidgetIdentity> {
			if (stopped) throw new Error("Widget was shut down");
			const current = ++generation;
			pending?.abort();
			const controller = new AbortController();
			pending = controller;
			const request: RequestInit & { credentials: "same-origin" } = {
				method: "POST",
				credentials: "same-origin",
				redirect: "error",
				headers: { Accept: "application/json" },
				signal: controller.signal,
			};
			const response = await options.fetch(url.href, request);
			if (!response.ok) throw new Error("Widget identification failed");
			const next = (await response.json()) as WidgetIdentity;
			if (stopped || current !== generation)
				throw Object.assign(new Error("Widget identification superseded"), {
					code: "identify_superseded",
				});
			if (
				!next ||
				typeof next.installationId !== "string" ||
				!next.installationId ||
				typeof next.user?.hostUserId !== "string" ||
				!next.user.hostUserId ||
				typeof next.user.externalTenantId !== "string" ||
				next.company?.externalTenantId !== next.user.externalTenantId
			)
				throw new Error("Invalid widget identity");
			const changed =
				identity !== null &&
				(identity.installationId !== next.installationId ||
					identity.user.hostUserId !== next.user.hostUserId ||
					identity.user.externalTenantId !== next.user.externalTenantId);
			identity = next;
			options.onIdentity(next, changed);
			return next;
		},
		shutdown() {
			stopped = true;
			generation++;
			pending?.abort();
			identity = null;
		},
	};
}
