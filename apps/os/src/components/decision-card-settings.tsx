import type { DecisionCardPreferences } from "@tedix/api-contract/schemas/user-settings";
import {
	decideForMeMode,
	type DecideForMeMode,
} from "@tedix/api-contract/utils/decision-card-preferences";
import { useOsPreferences } from "@/lib/use-os-preferences";
import { useMediaQuery } from "@/lib/use-media-query";
import { decisionText } from "@/shared/os-copy";
import { SegmentedControl } from "./kumo/segmented-control";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "./kumo/sheet";
import { Text } from "./kumo/text";

const LANGUAGES = [
	{ value: "en", label: "English" },
	{ value: "es", label: "Español" },
	{ value: "de", label: "Deutsch" },
	{ value: "fr", label: "Français" },
] as const;

/** One small sheet for how this person reads decision cards; display only. */
export function DecisionCardSettings({
	open,
	onOpenChange,
	cardType,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	cardType: string;
}) {
	const mobile = useMediaQuery("(max-width: 639px)");
	const { query, save } = useOsPreferences();
	const preferences = query.data?.preferences;
	const cards: DecisionCardPreferences = preferences?.decisionCards ?? {};
	const update = (next: DecisionCardPreferences) => {
		if (preferences) save.mutate({ ...preferences, decisionCards: next });
	};
	const language = cards.language ?? "en";
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={mobile ? "bottom" : "right"}
				size="sm"
				className={mobile ? "max-h-[85dvh] rounded-t-xl" : "sm:w-full"}
			>
				<SheetHeader>
					<SheetTitle>{decisionText("Card settings")}</SheetTitle>
					<SheetDescription>
						{decisionText(
							"How your decision cards look. This never answers a card for you unless you choose Auto.",
						)}
					</SheetDescription>
				</SheetHeader>
				<div
					className="grid gap-5 px-4 pb-6 sm:px-6"
					aria-busy={save.isPending}
				>
					<section className="grid gap-2">
						<Text weight="semibold">{decisionText("Layout")}</Text>
						<SegmentedControl
							ariaLabel={decisionText("Layout")}
							value={cards.density ?? "full"}
							onValueChange={(density) => update({ ...cards, density })}
							options={[
								{ value: "full", label: decisionText("Full") },
								{
									value: "compact",
									label: decisionText("Question and buttons"),
								},
							]}
						/>
					</section>
					<section className="grid gap-2">
						<Text weight="semibold">{decisionText("Decide for me")}</Text>
						<SegmentedControl<DecideForMeMode>
							ariaLabel={decisionText("Decide for me")}
							value={decideForMeMode(cards, cardType)}
							onValueChange={(mode) =>
								update({
									...cards,
									decideForMe: { ...cards.decideForMe, [cardType]: mode },
								})
							}
							options={[
								{ value: "ask", label: decisionText("Always ask") },
								{ value: "suggest", label: decisionText("Suggest") },
								{ value: "auto", label: decisionText("Auto when sure") },
							]}
						/>
						<Text tone="secondary">
							{decisionText(
								"Auto picks the recommended answer of an easy-to-undo card after 5 seconds, while you can still stop it.",
							)}
						</Text>
					</section>
					<section className="grid gap-2">
						<Text weight="semibold">{decisionText("Summary language")}</Text>
						<SegmentedControl
							ariaLabel={decisionText("Summary language")}
							value={language}
							onValueChange={(value) =>
								update({
									...cards,
									language: value === "en" ? null : value,
								})
							}
							options={LANGUAGES}
						/>
						<Text tone="secondary">
							{decisionText("New and changed cards use it.")}
						</Text>
					</section>
				</div>
			</SheetContent>
		</Sheet>
	);
}
