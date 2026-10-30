import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
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
				<Collapsible className="min-w-0">
					<CollapsibleDefaultTrigger>
						Recording details
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent>
						<ul className="m-0 grid list-disc gap-2 px-4 py-3 pl-7 wrap-anywhere">
							{warnings.map((warning, index) => (
								<li key={`${index}:${warning}`}>{warning}</li>
							))}
						</ul>
					</CollapsibleDefaultContent>
				</Collapsible>
			</AlertDescription>
		</Alert>
	);
}
