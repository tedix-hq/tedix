import { useContext } from "react";
import type {
	WorkActorReference,
	WorkContributionSource,
} from "@tedix/api-contract/schemas/os-work-actor";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { resolveWorkActor, resolveWorkContributor } from "@/lib/work-actor";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime } from "@/lib/time";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";

export function WorkSourceProvenance({
	actor,
	name,
	source,
	details = false,
}: {
	actor?: WorkActorReference;
	name: string;
	source?: WorkContributionSource;
	details?: boolean;
}) {
	useOsFormattingPreferences();
	const directory = useContext(WorkActorDirectoryContext);
	const resolved = resolveWorkActor(
		actor,
		actor?.type === "system"
			? "Intake service"
			: actor?.type === "user"
				? "User account"
				: name,
		directory,
	);
	const contributor = resolveWorkContributor(actor, name, directory);
	const evidence = actor?.source ?? source;
	const kind =
		actor?.type === "external_agent"
			? "External agent"
			: actor?.type === "tedi"
				? "Organization tedi"
				: actor?.type === "user"
					? "User account"
					: actor?.type === "system"
						? "System"
						: "Actor";
	return (
		<div
			className="grid min-w-0 gap-2 break-words"
			aria-label="Source provenance"
		>
			{evidence && (
				<Text role="label" tone="secondary">
					{evidence.channel} · Captured{" "}
					<time dateTime={evidence.capturedAt}>
						{absoluteTime(evidence.capturedAt)}
					</time>
					{" · "}
					<Link
						href={evidence.evidenceUrl}
						variant="record"
						className="tap-target-y"
					>
						Evidence
					</Link>
				</Text>
			)}
			<Text role="label" tone="secondary">
				{actor?.id
					? `Submitted by ${resolved.name} · ${kind}`
					: "Submitting actor not recorded"}
			</Text>
			{details && (
				<>
					{contributor.represented && (
						<Text role="label">
							Represented user: {contributor.represented.name}
						</Text>
					)}
					{actor?.id && (
						<Text role="label">
							Authenticated actor: {actor.type}:{actor.id}
						</Text>
					)}
					{actor?.contributor && (
						<Text role="label">
							Authenticated contributor: personal_agent:{actor.contributor.id}
						</Text>
					)}
					{evidence?.externalFindingId && (
						<Text role="label">Finding: {evidence.externalFindingId}</Text>
					)}
					{actor?.type === "user" && !actor.contributor && (
						<Text role="label" tone="secondary">
							This record identifies the submitting user account. It does not
							verify a personal agent mentioned in the text.
						</Text>
					)}
				</>
			)}
		</div>
	);
}
