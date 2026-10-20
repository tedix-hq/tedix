import type { TediSetup } from "@tedix/api-contract/contracts/tedis";
import type { TediType } from "@tedix/api-contract/schemas/tedi";

/**
 * Pure rendering of "what is this tedi wired to" from its stored configuration.
 * Nothing here is per-tenant: every line comes from the tedi row and its setup
 * checklist, so the same output can later feed a Workspace Output.
 */

export interface TediWiringSection {
	id: "purpose" | "model" | "tools" | "skills" | "schedules" | "setup";
	title: string;
	lines: string[];
}

export interface TediWiring {
	title: string;
	sections: TediWiringSection[];
	markdown: string;
}

export type TediWiringInput = Pick<
	TediType,
	| "name"
	| "displayName"
	| "personality"
	| "installedSkills"
	| "installedPlugins"
	| "toolPolicy"
	| "cronJobs"
	| "runtimeOverrides"
>;

const NONE = "None configured.";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function modelConfig(overrides: TediWiringInput["runtimeOverrides"]) {
	const model = asRecord(
		asRecord(asRecord(overrides?.agents)?.defaults)?.model,
	);
	const primary = typeof model?.primary === "string" ? model.primary : null;
	const fallbacks = Array.isArray(model?.fallbacks)
		? model.fallbacks.filter((m): m is string => typeof m === "string")
		: [];
	return { primary, fallbacks };
}

const APPROVAL_LABEL: Record<string, string> = {
	"always-allow": "runs without asking",
	"approve-first-then-allow": "asks once, then runs",
	"always-approve": "always asks a person first",
};

function setupStateLabel(state: "ready" | "missing" | "needs_you") {
	return state === "ready"
		? "ready"
		: state === "missing"
			? "missing"
			: "needs a person";
}

export function renderTediWiring(
	tedi: TediWiringInput,
	setup?: TediSetup | null,
): TediWiring {
	const name = tedi.displayName ?? tedi.name;
	const sections: TediWiringSection[] = [];

	sections.push({
		id: "purpose",
		title: "Purpose",
		lines: [tedi.personality?.trim() || "No purpose has been written yet."],
	});

	const { primary, fallbacks } = modelConfig(tedi.runtimeOverrides);
	sections.push({
		id: "model",
		title: "Model and fallback",
		lines: primary
			? [
					`Main model: ${primary}`,
					fallbacks.length
						? `Falls back to: ${fallbacks.join(", ")}`
						: "No fallback model is set.",
				]
			: ["No model is set on this tedi; the organization default applies."],
	});

	const toolLines: string[] = [];
	const connectionItems = (setup?.items ?? []).filter(
		(item) => item.kind === "tool" || item.kind === "connection",
	);
	for (const item of connectionItems) {
		toolLines.push(`${item.label} (${setupStateLabel(item.state)})`);
		for (const capability of item.capabilities ?? []) {
			toolLines.push(`  - ${capability.label}`);
		}
	}
	const policy = tedi.toolPolicy;
	if (policy?.runtimeTools?.length) {
		toolLines.push(`Built-in tools allowed: ${policy.runtimeTools.join(", ")}`);
	}
	if (policy) {
		toolLines.push(
			`Shell commands: ${APPROVAL_LABEL[policy.bash] ?? policy.bash}`,
			`Deploys: ${APPROVAL_LABEL[policy.deploy] ?? policy.deploy}`,
		);
	}
	sections.push({
		id: "tools",
		title: "Tools by connection",
		lines: toolLines.length ? toolLines : [NONE],
	});

	const skills = [
		...(tedi.installedSkills ?? []),
		...(tedi.installedPlugins ?? []).map((p) => `${p} (plugin)`),
	];
	sections.push({
		id: "skills",
		title: "Skills",
		lines: skills.length ? skills : [NONE],
	});

	sections.push({
		id: "schedules",
		title: "Schedules",
		lines: tedi.cronJobs?.length
			? tedi.cronJobs.map(
					(job) =>
						`${job.name}: ${job.schedule}${job.enabled ? "" : " (paused)"}`,
				)
			: ["Nothing is scheduled."],
	});

	const outstanding = (setup?.items ?? []).filter((i) => i.state !== "ready");
	sections.push({
		id: "setup",
		title: "What needs setup",
		lines: !setup
			? ["Setup status is not available yet."]
			: outstanding.length
				? outstanding.map(
						(item) =>
							`${item.label} (${setupStateLabel(item.state)}): ${item.detail}`,
					)
				: ["Nothing. Every declared requirement is ready."],
	});

	const markdown = [
		"<!-- generated: tedi-wiring; regenerated from configuration, do not hand edit -->",
		`# ${name}: wiring`,
		...sections.map(
			(s) =>
				`\n## ${s.title}\n\n${s.lines
					.map((l) => (l.startsWith("  - ") ? l : `- ${l}`))
					.join("\n")}`,
		),
		"",
	].join("\n");

	return { title: `${name}: wiring`, sections, markdown };
}
