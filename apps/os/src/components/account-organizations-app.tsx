import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { OrganizationLogoUpload } from "@/components/organization-profile-form";
import { EntityAvatar } from "@/shared/entity-avatar";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import {
	SectionHeader,
	SectionTitle,
	SectionDescription,
} from "@/components/kumo/page";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

export function AccountOrganizationsApp() {
	const [offset, setOffset] = useState(0);
	const cache = useQueryClient();
	const organizations = useQuery(
		osQuery.organizations.listAllMine.queryOptions({
			input: { activeOnly: true, limit: 50, offset },
		}),
	);
	const refresh = () => {
		for (const queryKey of [
			osQueryKeys.organizationsAllMine(),
			osQueryKeys.organizationsOsMine(),
			osQueryKeys.organizationDetail(),
			osQueryKeys.operationalContext(),
			osQuery.directory.key(),
		])
			void cache.invalidateQueries({ queryKey });
	};
	return (
		<div className="space-y-4">
			<SectionHeader>
				<SectionTitle>Your organizations</SectionTitle>
				<SectionDescription>
					Set a logo for any organization you own or administer, even if it has
					no Tedix OS.
				</SectionDescription>
			</SectionHeader>
			{organizations.isPending && <p>Loading organizations…</p>}
			{organizations.isError && (
				<p role="alert">
					Could not load your organizations.{" "}
					<Button
						variant="outline"
						size="sm"
						onClick={() => void organizations.refetch()}
					>
						Try again
					</Button>
				</p>
			)}
			{organizations.data?.data.map((organization) => (
				<div
					key={organization.organizationId}
					className="space-y-2 border-b border-kumo-line pb-4"
				>
					<Text as="p" className="font-medium">
						{organization.organizationName}
					</Text>
					{organization.member.status === "active" &&
					["owner", "admin"].includes(organization.member.role) ? (
						<OrganizationLogoUpload
							organizationId={organization.organizationId}
							currentImageUrl={organization.organizationLogoUrl}
							fallbackText={organization.organizationName}
							onChanged={refresh}
						/>
					) : (
						<div className="flex items-center gap-3">
							<EntityAvatar
								id={organization.organizationId}
								name={organization.organizationName}
								image={organization.organizationLogoUrl}
								kind="workspace"
							/>
							<Text as="p" tone="secondary">
								An owner or admin can change this logo.
							</Text>
						</div>
					)}
				</div>
			))}
			{organizations.data?.pagination.total === 0 && (
				<p>You have no active organization memberships.</p>
			)}
			{organizations.data && organizations.data.pagination.total > 50 && (
				<div className="flex gap-2">
					<Button
						disabled={offset === 0}
						onClick={() => setOffset(offset - 50)}
					>
						Previous
					</Button>
					<Button
						disabled={offset + 50 >= organizations.data.pagination.total}
						onClick={() => setOffset(offset + 50)}
					>
						Next
					</Button>
				</div>
			)}
		</div>
	);
}
