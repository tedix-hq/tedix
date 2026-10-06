/**
 * SSO Section — enables and configures Descope SSO Setup Suite (S4).
 *
 * Self-service flow for enterprise customers:
 *  1. Org admin clicks "Enable SSO" → toggles ssoSetupSuiteSettings.enabled
 *  2. "Configure SSO Provider" generates a one-time S4 portal URL the IT
 *     admin uses to wire up SAML/OIDC against their IdP
 *  3. Optional toggles disable specific S4 features (SCIM, SAML, etc.)
 *
 * Backed by `organizations.{getSsoStatus,configureSso,generateSsoSetupLink}`,
 * which proxy to Descope tenant management. Reads and invalidations use the
 * generated key namespace.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowSquareOut, Lock, ShieldCheck } from "@phosphor-icons/react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Label } from "@/components/kumo/label";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	organizationSsoStatusQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

interface SsoSectionProps {
	organizationId: string;
	descopeTenantId: string | null | undefined;
}

const FEATURE_TOGGLES: Array<{
	key: "saml" | "oidc" | "scim" | "ssoDomains" | "groupMapping";
	label: string;
	hint: string;
}> = [
	{
		key: "saml",
		label: "SAML",
		hint: "Allow SAML 2.0 IdP configuration in the setup portal",
	},
	{
		key: "oidc",
		label: "OIDC",
		hint: "Allow OIDC IdP configuration in the setup portal",
	},
	{
		key: "scim",
		label: "SCIM provisioning",
		hint: "Auto-provision/deprovision users from the IdP",
	},
	{
		key: "ssoDomains",
		label: "Domain claiming",
		hint: "Let the customer claim email domains for SSO routing",
	},
	{
		key: "groupMapping",
		label: "Group → role mapping",
		hint: "Map IdP groups (e.g. Engineering) to Tedix roles",
	},
];

function mutationErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function SsoCard({ children }: { children: React.ReactNode }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Lock className="h-5 w-5" />
					Single sign-on
				</CardTitle>
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

export function SsoSection({
	organizationId,
	descopeTenantId,
}: SsoSectionProps) {
	const queryClient = useQueryClient();
	const [actionFailure, setActionFailure] = useState<string | null>(null);

	const statusQuery = useQuery({
		...organizationSsoStatusQueryOptions(organizationId),
		enabled: !!descopeTenantId,
		staleTime: 60_000,
	});

	const configureMutation = useMutation({
		mutationFn: (
			input: NonNullable<
				Parameters<typeof osApi.organizations.configureSso>[0]
			>,
		) => osApi.organizations.configureSso(input),
		onSuccess: () => {
			setActionFailure(null);
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationSsoStatus(),
			});
		},
		onError: (error) =>
			setActionFailure(mutationErrorMessage(error, "Failed to update SSO")),
	});

	const setupLinkMutation = useMutation({
		mutationFn: (input: { email?: string }) =>
			osApi.organizations.generateSsoSetupLink({
				organizationId,
				expireDuration: 3600,
				email: input.email,
			}),
		onSuccess: ({ url }) => {
			setActionFailure(null);
			window.open(url, "_blank", "noopener,noreferrer");
		},
		onError: (error) =>
			setActionFailure(
				mutationErrorMessage(error, "Failed to generate SSO setup link"),
			),
	});

	if (!descopeTenantId) {
		return (
			<SsoCard>
				<Text tone="secondary">
					SSO is not available for this organization. Contact support if it
					should be enabled.
				</Text>
			</SsoCard>
		);
	}

	if (statusQuery.isPending) {
		return (
			<SsoCard>
				<Skeleton className="h-24 w-full" />
			</SsoCard>
		);
	}

	if (statusQuery.isError || !statusQuery.data) {
		return (
			<SsoCard>
				<Alert variant="destructive">
					<AlertTitle>Could not load SSO status</AlertTitle>
					<AlertDescription className="space-y-2">
						<p>
							{mutationErrorMessage(
								statusQuery.error,
								"The SSO status read failed.",
							)}
						</p>
						<Button
							size="sm"
							variant="outline"
							onClick={() => void statusQuery.refetch()}
						>
							Retry
						</Button>
					</AlertDescription>
				</Alert>
			</SsoCard>
		);
	}

	const status = statusQuery.data;
	const disabled = status.disabledFeatures ?? {};

	const setEnabled = (next: boolean) => {
		configureMutation.mutate({
			organizationId,
			settings: { enabled: next },
		});
	};

	const setFeatureDisabled = (
		key: (typeof FEATURE_TOGGLES)[number]["key"],
		next: boolean,
	) => {
		configureMutation.mutate({
			organizationId,
			settings: {
				disabledFeatures: { ...disabled, [key]: next },
			},
		});
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center justify-between gap-2">
					<span className="flex items-center gap-2">
						<Lock className="h-5 w-5" />
						Single sign-on
					</span>
					{status.authType && status.authType !== "none" ? (
						<Badge variant="success" className="gap-1">
							<ShieldCheck className="h-3 w-3" />
							{status.authType.toUpperCase()} configured
						</Badge>
					) : status.enabled ? (
						<Badge variant="secondary">Enabled, setup pending</Badge>
					) : (
						<Badge variant="outline">Not configured</Badge>
					)}
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-6">
				{actionFailure ? (
					<Alert variant="destructive">
						<AlertTitle>The last SSO action failed</AlertTitle>
						<AlertDescription>{actionFailure}</AlertDescription>
					</Alert>
				) : null}

				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<Label htmlFor="sso-enabled">Enable SSO setup</Label>
						<Text tone="secondary">
							Lets your IT administrator configure SAML or OIDC for your
							corporate identity provider.
						</Text>
					</div>
					<Switch
						id="sso-enabled"
						checked={status.enabled}
						disabled={configureMutation.isPending}
						onCheckedChange={setEnabled}
					/>
				</div>

				{status.enabled && (
					<>
						<Surface className="p-4">
							<div className="flex items-start justify-between gap-4">
								<div className="space-y-1">
									<Text weight="medium">Configure your identity provider</Text>
									<Text tone="secondary">
										Opens a one-time link (valid 1 hour) where your IT admin can
										configure SAML or OIDC, user provisioning, and group
										mappings.
									</Text>
								</div>
								<Button
									variant="default"
									size="sm"
									disabled={setupLinkMutation.isPending}
									onClick={() => setupLinkMutation.mutate({})}
								>
									<ArrowSquareOut className="mr-2 h-4 w-4" />
									{setupLinkMutation.isPending
										? "Generating…"
										: "Open setup portal"}
								</Button>
							</div>
						</Surface>

						<div className="space-y-3">
							<div>
								<Label>Available features</Label>
								<Text tone="secondary">
									Disable features you don't want exposed in the setup portal —
									useful for staged rollouts.
								</Text>
							</div>
							<div className="grid gap-3 sm:grid-cols-2">
								{FEATURE_TOGGLES.map((feature) => (
									<Surface
										key={feature.key}
										className="flex items-start justify-between gap-3 p-3"
									>
										<div className="space-y-0.5">
											<Label htmlFor={`feature-${feature.key}`}>
												{feature.label}
											</Label>
											{/* leading-snug would be defeated by the role's
											!important line-height, so this stays a raw utility. */}
											<p className="text-kumo-subtle text-xs leading-snug">
												{feature.hint}
											</p>
										</div>
										<Switch
											id={`feature-${feature.key}`}
											checked={!disabled[feature.key]}
											disabled={configureMutation.isPending}
											onCheckedChange={(checked) =>
												setFeatureDisabled(feature.key, !checked)
											}
										/>
									</Surface>
								))}
							</div>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
