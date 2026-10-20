import { CaretRight } from "@phosphor-icons/react";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
import { createContext } from "react";
import type { scoreLearning } from "@tedix/api-contract/utils/decision-learning";
import { Text } from "@/components/kumo/text";
import { OS_COPY } from "@/shared/os-copy";

type Explanation = ReturnType<typeof scoreLearning>;
export const DecisionLearningContext = createContext<Explanation | null>(null);

export function DecisionLearningWhy({
	explanation,
}: {
	explanation: Explanation;
}) {
	const copy = OS_COPY.learning;
	const evidence = [
		...new Set([
			...explanation.factors.flatMap((factor) => factor.evidenceIds),
			...explanation.lessonIds,
		]),
	];
	return (
		<div className="grid min-w-0 gap-2 pt-3">
			<Text weight="medium">{copy.signals}</Text>
			{explanation.factors.length ? (
				explanation.factors.map((factor, index) => (
					<Text key={`${factor.level}:${index}`}>{factor.reason}</Text>
				))
			) : (
				<Text>{copy.initial}</Text>
			)}
			{evidence.length > 0 && (
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure">
						<CaretRight
							size={14}
							aria-hidden
							className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
						/>
						{copy.evidence}
					</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						<Text role="label" className="break-all font-mono">
							{evidence.join(" · ")}
						</Text>
					</CollapsibleContent>
				</Collapsible>
			)}
		</div>
	);
}
