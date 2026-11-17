/**
 * `metadata.purposeContext` values that mark Work as internal to tedi
 * operations rather than customer work. They are permanent: every Home
 * delegation and tedi-created task filed without an objective carries one, and
 * customer-visible Work reads hide exactly these values. The `transitional_`
 * spelling is the identifier stored on existing rows, not a retirement plan.
 */
export const HOME_DELEGATION_PURPOSE_CONTEXT = "transitional_home_exception";
export const TEDI_TASK_PURPOSE_CONTEXT = "transitional_task_intent_exception";

export const INTERNAL_WORK_PURPOSE_CONTEXTS = [
	HOME_DELEGATION_PURPOSE_CONTEXT,
	TEDI_TASK_PURPOSE_CONTEXT,
] as const;

export type InternalWorkPurposeContext =
	(typeof INTERNAL_WORK_PURPOSE_CONTEXTS)[number];

export function isInternalWorkPurposeContext(
	value: unknown,
): value is InternalWorkPurposeContext {
	return (INTERNAL_WORK_PURPOSE_CONTEXTS as readonly unknown[]).includes(value);
}
