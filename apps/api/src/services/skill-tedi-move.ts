/**
 * Checks for moving a skill (and its schedule) to another tedi.
 *
 * A scheduled run executes as the skill's owner: the scheduler dispatches only
 * when the schedule's tedi matches the owner, the skill runtime routes the
 * manifest's `tedi` namespace to the owner's entry in the organization
 * gateway's `aggregateTedis`, and owner consent for personal resources is
 * recorded per (tedi, skill). Each check below names one of those
 * dependencies, so a dry run says exactly what would break under the target.
 */

import type { SkillMoveCheck } from "@tedix/api-contract/schemas/cognitive";
import type { SkillSchedule } from "@tedix/api-contract/schemas/cognitive";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import type { App } from "@tedix/db/schema/apps";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import type { Tedi } from "@tedix/db/schema/tedis";

/** Namespaces served by the gateway itself, never by a separate app. */
const GATEWAY_NAMESPACES = new Set(["home", "kernel", "tedi"]);

function record(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			return record(JSON.parse(value));
		} catch {
			return null;
		}
	}
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function mcpConfigOf(app: Pick<App, "metadata">): Record<string, unknown> {
	return record(record(app.metadata)?.mcpConfig) ?? {};
}

/**
 * The organization's Code Mode gateway, chosen exactly as the skill runtime
 * chooses it (`resolveSkillWorkflowMcpGateway`): an authenticated Code Mode
 * app with aggregated apps, preferring the `-unified` one.
 */
export function skillRunGateway<T extends Pick<App, "slug" | "metadata">>(
	apps: readonly T[],
): T | null {
	const candidates = apps.filter((app) => {
		const config = mcpConfigOf(app);
		return (
			Array.isArray(config.aggregateApps) &&
			config.aggregateApps.length > 0 &&
			config.authMode === "authenticated" &&
			config.codeMode === true
		);
	});
	return (
		candidates.find((app) => app.slug.endsWith("-unified")) ??
		candidates[0] ??
		null
	);
}

/** The gateway's `aggregateTedis` entry for a tedi, when it has a full one. */
export function gatewayTediBridge(
	gateway: Pick<App, "metadata">,
	tediSlug: string,
): { namespace: string } | null {
	const entries = mcpConfigOf(gateway).aggregateTedis;
	if (!Array.isArray(entries)) return null;
	for (const value of entries) {
		const entry = record(value);
		if (!entry || entry.slug !== tediSlug) continue;
		if (entry.surface === "collaboration") return null;
		const raw =
			typeof entry.namespace === "string" && entry.namespace.trim()
				? entry.namespace
				: tediSlug;
		return { namespace: raw.replace(/[^a-zA-Z0-9_]/g, "_") };
	}
	return null;
}

export function skillManifestNamespaces(content: string): string[] {
	return Object.keys(parseCapabilityManifest(content).mcp ?? {}).sort();
}

/** The `tedi` namespace resolves to the runner's gateway bridge or fails. */
export function tediNamespaceCheck(input: {
	namespaces: readonly string[];
	gateway: Pick<App, "slug" | "metadata"> | null;
	target: Pick<Tedi, "slug">;
}): SkillMoveCheck {
	if (!input.namespaces.includes("tedi"))
		return {
			id: "tedi_namespace",
			status: "pass",
			detail: "The skill does not call the `tedi` namespace.",
		};
	if (!input.gateway)
		return {
			id: "tedi_namespace",
			status: "fail",
			detail:
				"The skill calls the `tedi` namespace, but the organization has no Code Mode gateway to route it.",
		};
	const bridge = gatewayTediBridge(input.gateway, input.target.slug);
	return bridge
		? {
				id: "tedi_namespace",
				status: "pass",
				detail: `\`tedi\` calls will run as ${input.target.slug} through ${input.gateway.slug} (namespace ${bridge.namespace}).`,
			}
		: {
				id: "tedi_namespace",
				status: "fail",
				detail: `The skill calls the \`tedi\` namespace, and ${input.gateway.slug} has no full aggregateTedis entry for ${input.target.slug}, so every \`tedi\` call would fail with MCP_TARGET_UNRESOLVED. Add {slug: "${input.target.slug}", surface: "full"} to its aggregateTedis first.`,
			};
}

/**
 * The org apps a skill's declared namespaces reach directly (not through the
 * gateway): a stored app binding first, then the runtime's slug candidates.
 */
export function skillNamespaceApps<T extends Pick<App, "id" | "slug">>(input: {
	namespaces: readonly string[];
	bindings: Record<string, string> | null | undefined;
	orgApps: readonly T[];
}): Array<{ namespace: string; app: T }> {
	const byId = new Map(input.orgApps.map((app) => [app.id, app]));
	const bySlug = new Map(input.orgApps.map((app) => [app.slug, app]));
	const out: Array<{ namespace: string; app: T }> = [];
	for (const namespace of input.namespaces) {
		if (GATEWAY_NAMESPACES.has(namespace)) continue;
		const bound = input.bindings?.[namespace];
		const app =
			(bound ? byId.get(bound) : undefined) ??
			bySlug.get(namespace) ??
			bySlug.get(`${namespace}-tedix`) ??
			bySlug.get(namespace.replace(/_/g, "-"));
		if (app) out.push({ namespace, app });
	}
	return out;
}

/**
 * App assignments the source holds and the target lacks. A gap is reported,
 * not enforced: scheduled runs reach these apps over the internal service
 * binding as the owning tedi, which does not consult the assignment.
 */
export function appAccessCheck(input: {
	reached: ReadonlyArray<{ namespace: string; app: Pick<App, "id" | "slug"> }>;
	sourceRoles: Record<string, string> | null;
	targetRoles: Record<string, string> | null;
	unavailable?: string;
}): SkillMoveCheck {
	if (input.reached.length === 0)
		return {
			id: "app_access",
			status: "pass",
			detail: "The skill reaches no organization app outside the gateway.",
		};
	if (input.unavailable || !input.sourceRoles || !input.targetRoles)
		return {
			id: "app_access",
			status: "warn",
			detail: `App assignments were not compared (${input.unavailable ?? "assignment lookup unavailable"}).`,
		};
	const gaps = input.reached.filter(
		({ app }) => input.sourceRoles?.[app.id] && !input.targetRoles?.[app.id],
	);
	return gaps.length === 0
		? {
				id: "app_access",
				status: "pass",
				detail: `The target holds every app assignment the current owner uses for ${input.reached.map(({ app }) => app.slug).join(", ")}.`,
			}
		: {
				id: "app_access",
				status: "warn",
				detail: `The current owner has an assignment the target lacks on ${gaps.map(({ app, namespace }) => `${app.slug} (namespace ${namespace})`).join(", ")}. Scheduled runs reach these apps as the owning tedi over the service binding, which does not check the assignment; assign the target if it should also use them directly.`,
			};
}

/** Ids of the current owner written into the skill's own source. */
export function sourceReferencesCheck(input: {
	skill: Pick<SkillEntry, "content" | "files">;
	source: Pick<Tedi, "id" | "slug"> | null;
	targetName: string;
}): SkillMoveCheck {
	if (!input.source)
		return {
			id: "source_references",
			status: "pass",
			detail: "The skill had no owner to reference.",
		};
	const texts = [
		input.skill.content ?? "",
		...Object.values(
			(input.skill.files as Record<string, string> | null) ?? {},
		),
	];
	const count = texts.reduce(
		(sum, text) => sum + text.split(input.source!.id).length - 1,
		0,
	);
	return count === 0
		? {
				id: "source_references",
				status: "pass",
				detail: "The skill's source does not name the current owner's id.",
			}
		: {
				id: "source_references",
				status: "warn",
				detail: `The skill's source names the current owner's id (${input.source.id}) ${count} time(s). Those calls keep addressing the current owner (for example its mailbox) after the move; check that ${input.targetName} may use them, or edit the skill.`,
			};
}

export function scheduleCheck(input: {
	schedule: SkillSchedule | null;
	ownerTediId: string | null;
}): SkillMoveCheck {
	const { schedule } = input;
	if (!schedule)
		return {
			id: "schedule",
			status: "pass",
			detail: "The skill has no schedule; only its owner changes.",
		};
	const timing = `${schedule.cron}, ${schedule.enabled ? "enabled" : "paused"}, next ${schedule.nextFireAt}`;
	return schedule.tediId === input.ownerTediId
		? {
				id: "schedule",
				status: "pass",
				detail: `The schedule (${timing}) moves with the skill unchanged.`,
			}
		: {
				id: "schedule",
				status: "warn",
				detail: `The schedule (${timing}) names tedi ${schedule.tediId}, not the skill's owner, so the scheduler refuses it today; the move aligns it with the new owner.`,
			};
}

export function targetTediCheck(input: {
	target: Pick<Tedi, "id" | "name" | "status" | "retiredAt">;
	ownerTediId: string | null;
}): SkillMoveCheck {
	const { target } = input;
	if (target.id === input.ownerTediId)
		return {
			id: "target_tedi",
			status: "fail",
			detail: `${target.name} already owns this skill.`,
		};
	if (target.retiredAt)
		return {
			id: "target_tedi",
			status: "fail",
			detail: `${target.name} is retired.`,
		};
	if (target.status !== "active")
		return {
			id: "target_tedi",
			status: "fail",
			detail: `${target.name} is ${target.status ?? "not active"}; only an active tedi can run the skill.`,
		};
	return {
		id: "target_tedi",
		status: "pass",
		detail: `${target.name} is active in this organization.`,
	};
}

export function runsInFlightCheck(
	runs: ReadonlyArray<{ id: string; status: string }>,
): SkillMoveCheck {
	return runs.length === 0
		? {
				id: "runs_in_flight",
				status: "pass",
				detail: "No run of the skill is queued, running or paused.",
			}
		: {
				id: "runs_in_flight",
				status: "fail",
				detail: `${runs.length} run(s) still execute under the current owner: ${runs.map((run) => `${run.id} (${run.status})`).join(", ")}. Let them finish or cancel them first.`,
			};
}

export function personalResourcesCheck(
	delegations: ReadonlyArray<{ id: string }>,
): SkillMoveCheck {
	return delegations.length === 0
		? {
				id: "personal_resources",
				status: "pass",
				detail: "No owner consent for personal resources is tied to the skill.",
			}
		: {
				id: "personal_resources",
				status: "fail",
				detail: `${delegations.length} personal-resource consent(s) were granted to the current owner for this skill and do not carry over. Grant them to the target first, or revoke them.`,
			};
}
