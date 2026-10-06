/** Node-free shape shared by the production test and offline judge runners. */
export interface GoldItem {
	id: string;
	source: "production_derived" | "control" | "diagnostic_public";
	url?: string;
	claim: string;
	passage: string;
	goldLabel: "attributable" | "extrapolatory" | "contradictory";
	why: string;
}
