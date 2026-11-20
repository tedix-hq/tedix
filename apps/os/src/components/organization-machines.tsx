import { useQuery } from "@tanstack/react-query";
import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";
import type { Machine } from "@tedix/api-contract/schemas/machines";
import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import { SectionTitle } from "@/components/kumo/page";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { osQuery } from "@/lib/os-query-options";
import { absoluteTime } from "@/lib/time";
import {
	namedWorkPrincipal,
	useWorkPrincipalNames,
} from "./work-operations-shared";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkReadFailure,
} from "./work-surface-primitives";

function LiveRuns({
	machine,
	reports,
}: {
	machine: Machine;
	reports: DispatcherHealthReport[];
}) {
	const activities = reports.flatMap((report) =>
		report.machineName?.toLowerCase() === machine.machineName.toLowerCase() &&
		report.duty?.activity
			? [report.duty.activity]
			: [],
	);
	if (activities.length === 0) return "Activity unavailable";

	const runs = activities.flatMap((activity) => activity.current);
	const more = activities.reduce(
		(total, activity) =>
			total + Math.max(0, activity.currentCount - activity.current.length),
		0,
	);
	if (runs.length === 0 && more === 0) return "No live runs reported";
	return (
		<ul className="grid gap-1">
			{[...new Map(runs.map((run) => [run.id, run])).values()].map((run) => (
				<li key={run.id}>
					<Link href={`/work/items/${run.id}`} variant="record">
						<Text as="span" className="break-words whitespace-normal">
							{run.title ?? "Open task"}
						</Text>
					</Link>
				</li>
			))}
			{more > 0 ? <li>{more} more reported</li> : null}
		</ul>
	);
}

export function OrganizationMachines({
	organizationId,
	reports,
}: {
	organizationId: string;
	reports: DispatcherHealthReport[];
}) {
	const machines = useQuery({
		...osQuery.machines.list.queryOptions({}),
		refetchInterval: 30_000,
	});
	const calls = useQuery({
		...osQuery.machines.listToolCalls.queryOptions({
			input: { order: "newest", writesOnly: false, limit: 10 },
		}),
		refetchInterval: 30_000,
	});
	const names = useWorkPrincipalNames(organizationId);

	return (
		<section aria-label="Machines" className="grid min-w-0 gap-3">
			<SectionTitle>Machines</SectionTitle>
			{machines.isError ? (
				<WorkReadFailure
					title="Machines unavailable"
					error={machines.error}
					onRetry={() => machines.refetch()}
					retrying={machines.isFetching}
				/>
			) : machines.isPending ? (
				<WorkListSkeleton label="Loading machines" />
			) : machines.data.machines.length === 0 ? (
				<WorkEmpty
					title="No machines"
					description="Machines appear here when their runners report to this organization."
				/>
			) : (
				<Table
					aria-label="Machine inventory"
					mobileLayout="stacked"
					className="w-full table-fixed"
				>
					<TableHeader>
						<TableRow>
							{[
								"Machine",
								"Status",
								"CLI version",
								"Tedis can edit files",
								"Tedis can run commands",
								"Live agent runs",
							].map((label) => (
								<TableHead
									key={label}
									scope="col"
									className="whitespace-normal"
								>
									{label}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{machines.data.machines.map((machine) => (
							<TableRow key={machine.machineName}>
								<TableCell
									label="Machine"
									className="break-all whitespace-normal"
								>
									{machine.machineName}
								</TableCell>
								<TableCell label="Status">
									<Badge variant={machine.online ? "success" : "secondary"}>
										{machine.online ? "Online" : "Offline"}
									</Badge>
								</TableCell>
								<TableCell
									label="CLI version"
									className="break-all whitespace-normal"
								>
									{machine.cliVersion ?? "Unknown"}
								</TableCell>
								<TableCell label="Tedis can edit files">
									{machine.machineTools.includes("edit_file") ||
									machine.machineTools.includes("write_file")
										? "Yes"
										: "No"}
								</TableCell>
								<TableCell label="Tedis can run commands">
									{machine.machineTools.includes("run_command") ? "Yes" : "No"}
								</TableCell>
								<TableCell
									label="Live agent runs"
									className="whitespace-normal"
								>
									<LiveRuns machine={machine} reports={reports} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}

			<div className="grid min-w-0 gap-2">
				<Text as="h3" role="section" weight="semibold" tone="strong">
					Latest machine tool calls
				</Text>
				<Text tone="secondary">Up to 10 calls from the last 24 hours.</Text>
				{calls.isError ? (
					<WorkReadFailure
						title="Machine tool calls unavailable"
						error={calls.error}
						onRetry={() => calls.refetch()}
						retrying={calls.isFetching}
					/>
				) : calls.isPending ? (
					<WorkListSkeleton label="Loading machine tool calls" />
				) : calls.data.calls.length === 0 ? (
					<WorkEmpty
						title="No recent machine tool calls"
						description="There were no calls in the last 24 hours."
					/>
				) : (
					<Table
						aria-label="Latest machine tool calls"
						mobileLayout="stacked"
						className="w-full table-fixed"
					>
						<TableHeader>
							<TableRow>
								{[
									"Machine",
									"Tool",
									"Requested by",
									"Requested at",
									"Input",
								].map((label) => (
									<TableHead
										key={label}
										scope="col"
										className="whitespace-normal"
									>
										{label}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{calls.data.calls.map((call) => (
								<TableRow key={call.callId}>
									<TableCell
										label="Machine"
										className="break-all whitespace-normal"
									>
										{call.machine}
									</TableCell>
									<TableCell
										label="Tool"
										className="break-all whitespace-normal"
									>
										{call.tool}
									</TableCell>
									<TableCell
										label="Requested by"
										className="break-words whitespace-normal"
									>
										{namedWorkPrincipal(
											call.requestedBy.type,
											call.requestedBy.id,
											names,
										)}
									</TableCell>
									<TableCell label="Requested at" className="whitespace-normal">
										<time dateTime={call.createdAt}>
											{absoluteTime(call.createdAt)}
										</time>
									</TableCell>
									<TableCell label="Input" className="whitespace-normal">
										<Collapsible className="min-w-0">
											<CollapsibleDefaultTrigger>
												View input
											</CollapsibleDefaultTrigger>
											<CollapsibleDefaultContent>
												<pre className="max-h-64 overflow-auto break-all whitespace-pre-wrap text-xs">
													{JSON.stringify(call.input, null, 2)}
												</pre>
											</CollapsibleDefaultContent>
										</Collapsible>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</section>
	);
}
