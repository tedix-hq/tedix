import { DecisionFilterChip } from "@/components/decision-context-rail";
import { ALL_CARD_SOURCES } from "@/lib/card-source-filter";
import { decisionText } from "@/shared/os-copy";

/** One compact chip narrowing Deck or Feed cards to Work, a factory or a workspace. */
export function CardSourceFilter({
	value,
	options,
	onValueChange,
}: {
	value: string;
	options: readonly { value: string; label: string }[];
	onValueChange: (value: string) => void;
}) {
	if (options.length === 0) return null;
	const translated = options.map((option) => ({
		value: option.value,
		label: decisionText(option.label),
	}));
	return (
		<DecisionFilterChip
			label={
				value === ALL_CARD_SOURCES
					? decisionText("Source")
					: (translated.find((option) => option.value === value)?.label ??
						decisionText("Source"))
			}
			ariaLabel={decisionText("Card source")}
			value={value}
			onValueChange={onValueChange}
			options={translated}
		/>
	);
}
