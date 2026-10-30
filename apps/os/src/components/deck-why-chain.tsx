import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { DecisionRailContext } from "@/components/decision-context-rail";
import type {
	DecisionGraphChainStep,
	DecisionGraphNode,
} from "@tedix/api-contract/schemas/decision-graph";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";

const stepLabels = {
	card_from_work: "From Work",
	card_answers: "Your answer",
	decided_by: "Your earlier decision",
	supersedes: "Replaces",
	same_as: "Same as",
	blocks: "Waiting on this",
	involves: "Involves",
	evidence: "Evidence",
	about: "About",
	depends_on: "Builds on",
};

function recordHref(node: DecisionGraphNode): string | undefined {
	const id = encodeURIComponent(node.id);
	if (node.kind === "work_item") return `/work/items/${id}`;
	if (node.kind === "output") return `/outputs/${id}`;
	if (node.kind === "deck_card") return `/work/interactions/${id}`;
	return undefined;
}

function stepHref(step: DecisionGraphChainStep, cardId: string): string {
	const target = recordHref(step.node);
	if (target) return target;
	// Instructions and credential metadata have no detail route. Open the
	// supporting record, never turn an arbitrary evidence URI into navigation.
	const ref = step.edge.evidenceRef;
	if (
		ref &&
		/^\/(?:work\/(?:items|interactions)|outputs)\/[^/?#]+(?:[?#].*)?$/.test(ref)
	)
		return ref;
	return (
		recordHref(step.edge.from) ??
		`/work/interactions/${encodeURIComponent(cardId)}`
	);
}

export function DeckWhyChain({ cardId }: { cardId: string }) {
	const rail = useContext(DecisionRailContext);
	const query = useQuery({
		...osQuery.decisionGraph.getContext.queryOptions({
			input: { cardId, maxHops: 4 },
		}),
		...(rail && !rail.open ? { enabled: false } : {}),
	});
	if (!query.data)
		return (
			<div className="grid min-w-0 gap-1">
				<Text role="label" tone="secondary" aria-live="polite">
					{query.isError
						? "Couldn’t load linked decisions."
						: "Loading linked decisions…"}
				</Text>
				{query.isError && (
					<Button
						variant="ghost"
						size="sm"
						className="w-fit"
						onClick={() => void query.refetch()}
					>
						Try again
					</Button>
				)}
			</div>
		);
	const { context, explanation } = query.data;
	if (context.chain.length === 0)
		return (
			<Text role="label" tone="secondary">
				{explanation}
			</Text>
		);
	return (
		<Collapsible key={cardId} className="min-w-0">
			<CollapsibleDefaultTrigger className="max-w-full whitespace-normal break-words px-0 type-tedix-label">
				{explanation}
			</CollapsibleDefaultTrigger>
			<CollapsibleDefaultContent>
				<ol
					aria-label="Decision chain"
					className="grid min-w-0 gap-2 py-2 pl-4"
				>
					{context.chain.map((step) => (
						<li
							key={`${step.node.kind}:${step.node.id}`}
							className="min-w-0 break-words"
						>
							<Link
								href={stepHref(step, cardId)}
								className="inline-flex min-h-11 items-center whitespace-normal break-words"
							>
								{stepLabels[step.edge.kind]}:{" "}
								{step.edge.note ?? "Open supporting record"}
							</Link>
						</li>
					))}
				</ol>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}
