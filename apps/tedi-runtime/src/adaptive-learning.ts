export type AdaptiveLearningMode = "normal" | "disabled";

const COGNITIVE_SURFACE =
	/\b(?:brain|memory|memories|memory\s+facts?|rationale\s+records?|learning|learned|learn)\b/i;

const EXPLICIT_COGNITIVE_WRITE =
	/\b(?:tedix\.)?(?:learn_memory_graph|create_rationale_records|complete_rationale_records|delete_rationale_records|promote_memory_graph)\b/i;

// A bare "read-only" means no production changes, not "do not learn": Home's
// delegation brief always carries it, so it silently disabled learning for every
// delegated turn that mentioned memory. Only explicit cognitive opt-outs count.
const DISABLE_LEARNING_DIRECTIVES = [
	/\bdo\s+not\s+(?:create|write|update|delete|promote|mutate|learn)\b[\s\S]{0,180}\b(?:brain|memory|memories|memory\s+facts?|rationale\s+records?|learning)\b/i,
	/\bwithout\s+(?:creating|writing|updating|deleting|promoting|mutating|learning)\b[\s\S]{0,180}\b(?:memory\s+facts?|rationale\s+records?|brain|memory|learning)\b/i,
	/\bno\s+(?:new\s+)?(?:memory\s+facts?|rationale\s+records?|brain\s+writes?|learning\s+writes?)\b/i,
	/\bskip\s+(?:adaptive\s+)?(?:learning|brain|memory|rationale)\b/i,
	/\bdisable\s+(?:adaptive\s+)?(?:learning|brain|memory|rationale)\b/i,
	/\bsuppress\s+(?:adaptive\s+)?(?:learning|brain|memory|rationale|memory\s+writes?)\b/i,
];

const EXPLICIT_WRITE_CONTROL = [
	/\bwrite\s+exactly\s+one\b[\s\S]{0,180}\b(?:memory\s+fact|evidence\s+memory)\b/i,
	/\bcreate\s+and\s+close\s+exactly\s+one\b[\s\S]{0,180}\brationale\b/i,
	/\bdo\s+not\s+create\s+or\s+promote\s+org[-\s]*wide\s+facts?\b/i,
	/\bno\s+explicit\s+tediId\b/i,
];

export function shouldDisableAdaptiveLearningForTurn(input: {
	assistantText?: string;
	userText: string;
}): boolean {
	const text = `${input.userText}\n${input.assistantText ?? ""}`.slice(
		0,
		24_000,
	);
	if (!COGNITIVE_SURFACE.test(text) && !EXPLICIT_COGNITIVE_WRITE.test(text)) {
		return false;
	}
	if (EXPLICIT_WRITE_CONTROL.some((pattern) => pattern.test(text))) return true;
	return DISABLE_LEARNING_DIRECTIVES.some((pattern) => pattern.test(text));
}

export function adaptiveLearningModeForTurn(input: {
	assistantText?: string;
	userText: string;
}): AdaptiveLearningMode {
	return shouldDisableAdaptiveLearningForTurn(input) ? "disabled" : "normal";
}
