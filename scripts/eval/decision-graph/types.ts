export type Rule = "already_decided" | "duplicate" | "stale";
export type Candidate = {
	cardId: string;
	rule: Rule;
	linkedId: string;
	evidence: string | null;
};
export type GroundTruth = {
	cardId: string;
	rule: Rule;
	correct: boolean;
	evidenceRef: string;
	sourceType: string;
	observedAt: string;
	note: string;
};
export type PrecisionResult = {
	eligible: number;
	sampled: number;
	shortfall: number;
	checked: number;
	correct: number;
	contradicted: number;
	unknown: number;
	precision: number | null;
	labelCoverage: number | null;
	examples: (Candidate & { label: GroundTruth | null })[];
};
export type CohortResult = {
	cards: number;
	contextRead: number;
	protected: number;
	graph: Record<Rule, number>;
	graphUniqueRemovals: number;
	incrementalRemovals: number;
	baseline: {
		actions: number;
		proposals: number;
		byReason: Record<string, number>;
	};
	ranking: {
		pairs: number;
		discordant: number;
		kendallTauDistance: number;
		topK: number;
		topOverlap: number;
		moved: number;
		before: string[];
		after: string[];
		blocked: Record<string, number | null>;
	};
	candidates: Candidate[];
};
export type Measurement = {
	observedAt: string;
	cutoff: string;
	mode: string;
	deployment?: unknown;
	coverage: unknown;
	baselineConfigSource: string;
	currentUnmapped: string[];
	cohorts: Record<"current" | "last30Days", CohortResult>;
	precision: Record<Rule, PrecisionResult>;
	caveats: string[];
};
