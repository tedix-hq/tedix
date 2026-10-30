import { CaretRight } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { Text } from "@/components/kumo/text";
import { recordingNote } from "@/lib/run-step-content";

export function RunRecordingNotes({ warnings }: { warnings: string[] }) {
	if (!warnings.length) return null;
	return (
		<Alert>
			<AlertTitle>Some saved details are unavailable</AlertTitle>
			<AlertDescription className="grid min-w-0 gap-3">
				{[...new Set(warnings.map(recordingNote))].map((note) => (
					<Text as="p" className="m-0" key={note}>
						{note}
					</Text>
				))}
				<Text as="p" tone="secondary" className="m-0">
					This notice is about the saved records. The run’s status is shown
					above.
				</Text>
				<Collapsible className="min-w-0 rounded-lg border border-kumo-line bg-kumo-base p-2">
					<CollapsibleTrigger className="group w-full">
						<CaretRight
							aria-hidden
							size={16}
							className="transition-transform group-data-[panel-open]:rotate-90"
						/>
						Recording details
					</CollapsibleTrigger>
					<CollapsibleContent>
						<ul className="m-0 grid list-disc gap-2 px-4 py-3 pl-7 wrap-anywhere">
							{warnings.map((warning, index) => (
								<li key={`${index}:${warning}`}>{warning}</li>
							))}
						</ul>
					</CollapsibleContent>
				</Collapsible>
			</AlertDescription>
		</Alert>
	);
}
