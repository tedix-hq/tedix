import {
	DecisionContextToolbar,
	DecisionFilterChip,
} from "./decision-context-rail";
import { CardSourceFilter } from "./card-source-filter";
import { Button } from "./kumo/button";
import { Input } from "./kumo/input";
import { DECK_ASK_KINDS } from "@tedix/api-contract/utils/deck-ask";
import { cardSourceOptions } from "@/lib/card-source-filter";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import type { DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
import type { useVisibleCardSources } from "@/lib/use-visible-card-sources";
import type { projectDecisionDeck } from "./decision-deck-projection";

type Props = {
	config: DecisionDeckConfig;
	mode: string;
	kind: string;
	source: string;
	project: string;
	urgency: string;
	search: string;
	setMode: (value: string) => void;
	setKind: (value: string) => void;
	setSource: (value: string) => void;
	setProject: (value: string) => void;
	setUrgency: (value: string) => void;
	setSearch: (value: string) => void;
	setIndex: (value: number) => void;
	projectLabel: (id: string) => string | undefined;
	rows: ReturnType<typeof projectDecisionDeck>["rows"];
	factories: ReturnType<
		typeof useVisibleCardSources<DecisionDeckConfig["factorySources"][number]>
	>;
};
export function DecisionDeckToolbar({
	config,
	mode,
	kind,
	source,
	project,
	urgency,
	search,
	setMode,
	setKind,
	setSource,
	setProject,
	setUrgency,
	setSearch,
	setIndex,
	projectLabel,
	rows,
	factories,
}: Props) {
	const KIND_LABELS = OS_COPY.decisionDeck.kinds;
	return (
		<DecisionContextToolbar
			children={
				<div
					className="fd-deck-toolbar"
					data-focus-ring="inset"
					aria-label={decisionText("Deck view")}
				>
					{[
						"decide",
						"waiting",
						"history",
						...(config.examples.length ? ["practice"] : []),
					].map((value) => (
						<Button
							key={value}
							aria-pressed={mode === value}
							variant="ghost"
							onClick={() => {
								setMode(value);
								setIndex(0);
							}}
						>
							{value === "decide"
								? decisionText("For you")
								: value === "waiting"
									? decisionText("Everything waiting")
									: value === "history"
										? decisionText("What you decided")
										: decisionText("Try examples")}
						</Button>
					))}
				</div>
			}
			filters={
				<div className="fd-deck-filters">
					<div className="flex flex-wrap gap-2">
						<DecisionFilterChip
							label={kind === "all" ? "Kind" : KIND_LABELS[kind]}
							ariaLabel={decisionText("Decision kind")}
							value={kind}
							onValueChange={(value) => {
								setKind(value);
								setIndex(0);
							}}
							options={["all", ...DECK_ASK_KINDS, "drafted_not_sent"].map(
								(value) => ({
									value,
									label: KIND_LABELS[value],
								}),
							)}
						/>
						<CardSourceFilter
							value={source}
							onValueChange={(value) => {
								setSource(value);
								setIndex(0);
							}}
							options={
								mode === "decide"
									? cardSourceOptions(
											factories.sources,
											factories.workspaceName,
										)
									: []
							}
						/>
						<DecisionFilterChip
							label={project === "all" ? "Project" : projectLabel(project)}
							ariaLabel={decisionText("Decision project")}
							searchable
							value={project}
							onValueChange={(value) => {
								setProject(value);
								setIndex(0);
							}}
							options={["all", ...new Set(rows.map((row) => row.project))].map(
								(value) => ({
									value,
									label:
										value === "all"
											? decisionText("All projects")
											: projectLabel(value),
								}),
							)}
						/>
						<DecisionFilterChip
							label={
								urgency === "all"
									? "Urgency"
									: urgency === "now"
										? "Needs you now"
										: "Can wait"
							}
							ariaLabel={decisionText("Decision urgency")}
							value={urgency}
							onValueChange={(value) => {
								setUrgency(value);
								setIndex(0);
							}}
							options={[
								{ value: "all", label: decisionText("Any urgency") },
								{ value: "now", label: decisionText("Needs you now") },
								{ value: "later", label: decisionText("Can wait") },
							]}
						/>

						<Input
							aria-label={decisionText("Find decisions")}
							placeholder={decisionText("Find a decision")}
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setIndex(0);
							}}
						/>
					</div>
				</div>
			}
		/>
	);
}
