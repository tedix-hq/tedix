import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	PortfolioBucketsSchema,
	type PortfolioBucket,
} from "@tedix/api-contract/schemas/organization";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	SettingsSection,
	SettingsSectionContent,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";

export function OrganizationPortfolioForm({
	organizationId,
	initialBuckets,
}: {
	organizationId: string;
	initialBuckets: readonly PortfolioBucket[];
}) {
	const [buckets, setBuckets] = useState(() =>
		initialBuckets.map((bucket) => ({ ...bucket })),
	);
	const queryClient = useQueryClient();
	const id = useId();
	const validation = PortfolioBucketsSchema.safeParse(buckets);
	const save = useMutation({
		mutationFn: (next: PortfolioBucket[]) =>
			osApi.organizations.update({
				organizationId,
				metadata: { portfolioBuckets: next },
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationDetail(),
			});
		},
	});
	function patch(index: number, update: Partial<PortfolioBucket>) {
		save.reset();
		setBuckets((current) =>
			current.map((bucket, i) =>
				i === index ? { ...bucket, ...update } : bucket,
			),
		);
	}
	function move(index: number, direction: number) {
		save.reset();
		setBuckets((current) => {
			const next = [...current];
			const target = index + direction;
			const bucket = next[index];
			const neighbor = next[target];
			if (bucket && neighbor) {
				next[index] = neighbor;
				next[target] = bucket;
			}
			return next;
		});
	}
	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Portfolio sections</SectionTitle>
					<SectionDescription>
						Choose your project board sections. Renaming keeps their projects.
						Removing a section puts its projects in Unsorted until you move
						them.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SettingsSectionContent className="space-y-3">
				{buckets.map((bucket, index) => (
					<div
						key={index}
						className="space-y-2 rounded border border-kumo-line p-3"
					>
						<Label htmlFor={`${id}-${index}-label`}>
							<span id={`${id}-${index}-label-label`}>Section name</span>
						</Label>
						<Input
							id={`${id}-${index}-label`}
							aria-labelledby={`${id}-${index}-label-label`}
							value={bucket.label}
							disabled={save.isPending}
							onChange={(event) => patch(index, { label: event.target.value })}
						/>
						<Label htmlFor={`${id}-${index}-key`}>
							<span id={`${id}-${index}-key-label`}>Section key</span>
						</Label>
						<Input
							id={`${id}-${index}-key`}
							aria-labelledby={`${id}-${index}-key-label`}
							value={bucket.key}
							disabled={save.isPending}
							onChange={(event) => patch(index, { key: event.target.value })}
						/>
						<p className="type-tedix-caption text-kumo-subtle">
							Keep this key when renaming. Projects refer to it; changing it
							moves them to Unsorted.
						</p>
						<Label htmlFor={`${id}-${index}-description`}>
							<span id={`${id}-${index}-description-label`}>
								Description (optional)
							</span>
						</Label>
						<Input
							id={`${id}-${index}-description`}
							aria-labelledby={`${id}-${index}-description-label`}
							value={bucket.description ?? ""}
							disabled={save.isPending}
							onChange={(event) =>
								patch(index, { description: event.target.value })
							}
						/>
						<div className="flex gap-2">
							<Button
								variant="secondary"
								disabled={save.isPending || index === 0}
								onClick={() => move(index, -1)}
							>
								Move up
							</Button>
							<Button
								variant="secondary"
								disabled={save.isPending || index === buckets.length - 1}
								onClick={() => move(index, 1)}
							>
								Move down
							</Button>
							<Button
								variant="ghost"
								disabled={save.isPending}
								onClick={() => {
									save.reset();
									setBuckets((current) =>
										current.filter((_, i) => i !== index),
									);
								}}
							>
								Remove
							</Button>
						</div>
					</div>
				))}
				<div className="flex gap-2">
					<Button
						variant="secondary"
						disabled={save.isPending || buckets.length >= 50}
						onClick={() => {
							save.reset();
							setBuckets((current) => [
								...current,
								{
									key: `section-${crypto.randomUUID().slice(0, 8)}`,
									label: "New section",
								},
							]);
						}}
					>
						Add section
					</Button>
					<Button
						disabled={!validation.success || save.isPending}
						onClick={() => {
							if (validation.success) save.mutate(validation.data);
						}}
					>
						Save sections
					</Button>
				</div>
				{!validation.success && (
					<Text as="p" role="label" tone="error" aria-live="polite">
						{validation.error.issues[0]?.message}
					</Text>
				)}
				{save.isError && (
					<Alert variant="destructive">
						<AlertDescription>
							{errorMessage(save.error, "Sections could not be saved.")}
						</AlertDescription>
					</Alert>
				)}
				{save.isSuccess && (
					<Text as="p" role="label" tone="secondary" aria-live="polite">
						Sections saved.
					</Text>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
