/**
 * Canonical governed-learning schedules.
 *
 * These names are shared by the skill scheduler, tedi inference admission, and
 * flywheel health. Keep the identity in one contract-layer module so a new
 * learning loop cannot accidentally receive health tracking without the
 * protected budget class (or vice versa).
 */
export const GOVERNED_LEARNING_SCHEDULES = [
	{ name: "brain-reflection", intervalHours: 8 },
	{ name: "objective-review", intervalHours: 4 },
	{ name: "app-operations", intervalHours: 6 },
	{ name: "skill-development", intervalHours: 24 },
	{ name: "knowledge-freshness", intervalHours: 24 },
	{ name: "grounding-review", intervalHours: 6 },
] as const;

export type GovernedLearningScheduleName =
	(typeof GOVERNED_LEARNING_SCHEDULES)[number]["name"];

export const GOVERNED_LEARNING_SKILL_SLUGS = GOVERNED_LEARNING_SCHEDULES.map(
	(schedule) => `platform-${schedule.name}-dogfood`,
) as readonly `platform-${GovernedLearningScheduleName}-dogfood`[];

const GOVERNED_LEARNING_SKILL_SLUG_SET = new Set<string>(
	GOVERNED_LEARNING_SKILL_SLUGS,
);

export function isGovernedLearningSkillSlug(
	slug: string | null | undefined,
): boolean {
	return Boolean(slug && GOVERNED_LEARNING_SKILL_SLUG_SET.has(slug));
}

const GOVERNED_LEARNING_SCHEDULE_NAME_SET = new Set<string>(
	GOVERNED_LEARNING_SCHEDULES.map((schedule) => schedule.name),
);

function objectValue(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			return objectValue(JSON.parse(value));
		} catch {
			return null;
		}
	}
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function cronPolicy(value: unknown): Record<string, unknown> | null {
	return objectValue(objectValue(value)?.cronPolicy);
}

function isSchedulableGovernedTemplate(value: unknown): value is {
	name: GovernedLearningScheduleName;
	schedule: string;
	message: string;
} {
	const row = objectValue(value);
	if (!row || typeof row.name !== "string") return false;
	if (!GOVERNED_LEARNING_SCHEDULE_NAME_SET.has(row.name)) return false;
	if (typeof row.schedule !== "string" || typeof row.message !== "string") {
		return false;
	}
	const fields = row.schedule.trim().split(/\s+/).length;
	return row.message.trim().length > 0 && (fields === 5 || fields === 6);
}

function applyCronPolicy(
	enabled: Set<string>,
	policy: Record<string, unknown> | null,
): void {
	if (!policy) return;
	if (policy.disableCognitiveDefaults === true) enabled.clear();
	else if (Array.isArray(policy.disabledCognitiveCronNames)) {
		for (const name of policy.disabledCognitiveCronNames) {
			if (typeof name === "string") enabled.delete(name);
		}
	}
	if (Array.isArray(policy.cronTemplates)) {
		for (const template of policy.cronTemplates) {
			if (isSchedulableGovernedTemplate(template)) enabled.add(template.name);
		}
	}
}

/**
 * Resolve the cognitive schedules that are actually governed for one tedi.
 * Mirrors the runtime's pack defaults -> pack policy -> tedi override order,
 * then unions enabled skill-native schedules from D1. Health and alerting must
 * use this set so an explicit opt-out is shown as disabled rather than dark.
 */
export function resolveEnabledGovernedLearningCronNames(input: {
	policyPackDefinition?: unknown;
	runtimeOverrides?: unknown;
	scheduledCronNames?: Iterable<string>;
}): Set<GovernedLearningScheduleName> {
	const enabled = new Set<string>(
		GOVERNED_LEARNING_SCHEDULES.map((schedule) => schedule.name),
	);
	applyCronPolicy(enabled, cronPolicy(input.policyPackDefinition));
	applyCronPolicy(enabled, cronPolicy(input.runtimeOverrides));
	for (const name of input.scheduledCronNames ?? []) {
		if (GOVERNED_LEARNING_SCHEDULE_NAME_SET.has(name)) enabled.add(name);
	}
	return new Set(
		[...enabled].filter((name): name is GovernedLearningScheduleName =>
			GOVERNED_LEARNING_SCHEDULE_NAME_SET.has(name),
		),
	);
}
