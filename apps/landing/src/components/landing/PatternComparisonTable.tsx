import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

const rows = [
	["Klarna", "Weeks of protocol development", "Live in days"],
	[
		"SRE Mexican Embassy in Germany",
		"365-day development estimate",
		"Platform live in days",
	],
	[
		"Digital Twins",
		"Knowledge locked in people",
		"Expertise scaled across the org",
	],
] as const;

export function PatternComparisonTable() {
	return (
		<div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Company</TableHead>
						<TableHead>Without Tedix</TableHead>
						<TableHead>With Tedix</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map(([company, before, after]) => (
						<TableRow key={company}>
							<TableCell className="font-medium">{company}</TableCell>
							<TableCell className="whitespace-normal text-kumo-subtle">
								{before}
							</TableCell>
							<TableCell className="whitespace-normal font-medium text-kumo-success">
								{after}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
