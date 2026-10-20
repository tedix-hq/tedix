import type { TediSetup } from "@tedix/api-contract/contracts/tedis";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export interface SetupConfig {
	tediId: string;
	tools: {
		id: string;
		appId: string;
		toolId: string;
		title: string;
		enabled: boolean | null;
		config: unknown;
	}[];
	assignedAppIds: string[];
	connectionSources?: {
		id: string;
		appId: string;
		title: string;
		config: unknown;
	}[];
	skills: {
		id: string;
		title: string;
		slug: string | null;
		toolIds: string[];
		requires: string[];
	}[];
	accounts: {
		providerId: string;
		scope: "tenant" | "user";
		instanceId: string | null;
		state: "present" | "missing" | "expired" | "restricted" | "unknown";
		connected: boolean;
		scopes: string[];
	}[];
	assignmentsComplete: boolean;
}

/** Configuration readiness only: neither permission to execute nor provider health. */
export function deriveTediSetup(config: SetupConfig): TediSetup {
	const items = new Map<string, TediSetup["items"][number]>();
	const add = (item: TediSetup["items"][number]) => {
		items.set(item.id, item);
	};
	const required = new Set(config.skills.flatMap((s) => s.toolIds));
	const tools = config.tools.filter(
		(t) => required.has(t.id) || config.assignedAppIds.includes(t.appId),
	);
	for (const skill of config.skills) {
		for (const id of skill.toolIds) {
			if (config.tools.some((t) => t.id === id)) continue;
			add({
				id: `build:${skill.id}:${id}`,
				kind: "build",
				state: "missing",
				label: `Build still owed: ${id}`,
				detail: `Required by ${skill.title}; no tool is registered in this organization.`,
				href: `/skills/${encodeURIComponent(skill.id)}`,
			});
		}
		for (const requirement of skill.requires) {
			const present = config.skills.some((s) => s.slug === requirement);
			add({
				id: `human:${skill.id}:${requirement}`,
				kind: "human",
				state: present ? "ready" : "needs_you",
				label: requirement,
				detail: present
					? `Required skill is available for ${skill.title}.`
					: `Prerequisite declared by ${skill.title}; review and confirm it.`,
				href: `/skills/${encodeURIComponent(skill.id)}`,
			});
		}
	}
	for (const tool of tools) {
		add({
			id: `tool:${tool.id}`,
			kind: "tool",
			state: tool.enabled ? "ready" : "missing",
			label: tool.title,
			detail: tool.enabled
				? "Tool is registered and enabled; execution permissions still apply."
				: "Configured tool is disabled.",
			href: `/apps/${encodeURIComponent(tool.appId)}/tools`,
		});
	}
	for (const tool of [...tools, ...(config.connectionSources ?? [])]) {
		const auth =
			isRecord(tool.config) && isRecord(tool.config.auth)
				? tool.config.auth
				: null;
		if (!auth) continue;
		if (
			auth.type === "connection" &&
			typeof auth.connectionId === "string" &&
			auth.connectionId
		) {
			const providerId = auth.connectionId;
			const scope = auth.credentialScope ?? auth.scope ?? "tenant";
			const instanceId =
				typeof auth.connectionInstanceId === "string"
					? auth.connectionInstanceId
					: null;
			const scopes = Array.isArray(auth.scopes)
				? auth.scopes.filter((x): x is string => typeof x === "string")
				: [];
			const candidates = config.accounts.filter(
				(a) =>
					a.providerId === providerId &&
					(a.instanceId === instanceId ||
						(a.instanceId === "*" && a.state === "unknown")) &&
					(scope === "hybrid" ||
						a.scope === (scope === "user" ? "user" : "tenant")),
			);
			const ready = candidates.some(
				(a) =>
					a.state === "present" &&
					a.connected &&
					scopes.every((s) => a.scopes.includes(s)),
			);
			const missing =
				candidates.length === 0 ||
				candidates.every((a) => a.state === "missing");
			// Personal credentials belong to the tedi owner; never borrow the viewing user's tokens.
			const state =
				scope !== "tenant"
					? "needs_you"
					: ready
						? "ready"
						: missing
							? "missing"
							: "needs_you";
			add({
				id: `connection:${providerId}:${scope}:${instanceId ?? "default"}:${[...scopes].sort().join(",")}`,
				kind: "connection",
				state,
				label: providerId,
				detail:
					scope !== "tenant"
						? "Review the tedi owner's personal account and credential selection. Organization credentials do not verify this requirement."
						: ready
							? "Required credential and scopes are present; provider health is not tested."
							: missing
								? "Connect the required account or API key."
								: "Verify the account, renew consent, or grant the required scopes.",
				href: `/admin/connections?connect=${encodeURIComponent(providerId)}`,
			});
		} else if (auth.type) {
			add({
				id: `auth:${tool.id}`,
				kind: "human",
				state: "needs_you",
				label: `Review credentials for ${tool.title}`,
				detail:
					"This tool uses credential configuration outside the Connections inventory.",
				href: `/apps/${encodeURIComponent(tool.appId)}/tools`,
			});
		}
	}
	if (!config.assignmentsComplete)
		add({
			id: "assignments",
			kind: "human",
			state: "needs_you",
			label: "Verify app assignments",
			detail:
				"The assignment inventory could not be fully verified; additional requirements may be missing from this checklist.",
			href: `/team/${encodeURIComponent(config.tediId)}/settings`,
		});
	return {
		tediId: config.tediId,
		observedAt: new Date().toISOString(),
		items: [...items.values()].sort(
			(a, b) =>
				a.state.localeCompare(b.state) || a.label.localeCompare(b.label),
		),
	};
}
