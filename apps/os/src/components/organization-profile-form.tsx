/**
 * Organization profile CRUD (`organizations.update`).
 *
 * Invalidating only the membership list after an update would leave
 * `organizations.get` — the read rendering the very page that edited it —
 * stale until a hard reload. Every
 * write here invalidates the detail read, both membership list projections,
 * and the credential-resolved operational context (the shell renders the org
 * name/slug from it), all through generated keys.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageSquare, Trash, UploadSimple } from "@phosphor-icons/react";
import { useCallback, useRef, useState } from "react";
import * as z from "zod";
import {
	DispatcherHealthSettingsSchema,
	resolveDispatcherHealthSettings,
	type DispatcherHealthSettings,
} from "@tedix/api-contract/schemas/dispatcher-health";
import { FormInput } from "@/components/forms/form-input";
import { FormTextarea } from "@/components/forms/form-textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import { Button } from "@/components/kumo/button";
import { FormField } from "@/components/kumo/forms/form-field";
import {
	SectionHeader,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { Loader } from "@/components/kumo/loader";
import { Separator } from "@/components/kumo/separator";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

const HEALTH_FIELDS = [
	[
		"staleAfterMinutes",
		"Dispatcher quiet time (minutes)",
		"Alert when Work waits and either dispatcher signal is older than this. Default: 45.",
	],
	[
		"reportStaleAfterSeconds",
		"Runner heartbeat grace (seconds)",
		"Mark runner and lane health unknown after this long without a fresh report. Default: 300.",
	],
	[
		"alarmIntervalMinutes",
		"Alarm check interval (minutes)",
		"Check at most this often, in multiples of two minutes. Recovery is checked on the same interval. Default: 2.",
	],
] as const;

const healthInput = (key: (typeof HEALTH_FIELDS)[number][0]) =>
	z
		.string()
		.refine(
			(value) =>
				value.trim() !== "" &&
				DispatcherHealthSettingsSchema.shape[key].safeParse(Number(value))
					.success,
			"Enter a whole number in the allowed range; intervals must be multiples of two.",
		);

const OrganizationProfileSchema = z.object({
	staleAfterMinutes: healthInput("staleAfterMinutes"),
	reportStaleAfterSeconds: healthInput("reportStaleAfterSeconds"),
	alarmIntervalMinutes: healthInput("alarmIntervalMinutes"),
	name: z.string().min(1, "Name is required").max(100),
	slug: z
		.string()
		.min(1, "Slug is required")
		.max(100)
		.regex(
			/^[a-z0-9-]+$/,
			"Slug must be lowercase letters, numbers, and hyphens only",
		),
	description: z
		.string()
		.max(500, "Description must be 500 characters or less")
		.optional()
		.or(z.literal("")),
	website: z.string().url("Must be a valid URL").optional().or(z.literal("")),
	contactEmail: z
		.string()
		.email("Must be a valid email")
		.optional()
		.or(z.literal("")),
});

interface OrganizationProfileFormProps {
	organizationId: string;
	defaultValues: {
		name: string;
		slug: string;
		logoUrl?: string | null;
		description?: string | null;
		website?: string | null;
		contactEmail?: string | null;
		dispatcherHealth?: DispatcherHealthSettings;
	};
}

const emptyToUndefined = (value?: string | null) =>
	value?.trim() ? value.trim() : undefined;

const normalizeSlug = (value: string) => value.trim().toLowerCase();

function mutationErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function OrganizationProfileForm({
	organizationId,
	defaultValues,
}: OrganizationProfileFormProps) {
	const queryClient = useQueryClient();
	const [saved, setSaved] = useState(false);

	/**
	 * The invalidation fix: detail + list projections + operational context.
	 * `router.invalidate()` is deliberately absent — the loader reads the same
	 * generated keys these invalidations refetch.
	 */
	const invalidateOrganization = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: osQuery.directory.key() }),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationDetail(),
			}),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationsOsMine(),
			}),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.organizationsAllMine(),
			}),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.operationalContext(),
			}),
		]);

	const updateOrganization = useMutation({
		mutationFn: (input: {
			organizationId: string;
			name: string;
			slug: string;
			description: string | null;
			metadata?: {
				website?: string;
				contactEmail?: string;
				dispatcherHealth?: DispatcherHealthSettings;
			};
		}) => osApi.organizations.update(input),
		onSuccess: async () => {
			await invalidateOrganization();
			setSaved(true);
		},
		onMutate: () => setSaved(false),
	});

	const health = resolveDispatcherHealthSettings(
		defaultValues.dispatcherHealth,
	);
	const form = useZodForm({
		schema: OrganizationProfileSchema,
		validateOn: "blur",
		defaultValues: {
			name: defaultValues.name ?? "",
			slug: defaultValues.slug ?? "",
			description: defaultValues.description ?? "",
			website: defaultValues.website ?? "",
			contactEmail: defaultValues.contactEmail ?? "",
			staleAfterMinutes: String(health.staleAfterMinutes),
			reportStaleAfterSeconds: String(health.reportStaleAfterSeconds),
			alarmIntervalMinutes: String(health.alarmIntervalMinutes),
		},
		onSubmit: async ({ value }) => {
			updateOrganization.mutate({
				organizationId,
				name: value.name.trim(),
				slug: normalizeSlug(value.slug),
				description: emptyToUndefined(value.description) ?? null,
				metadata: {
					website: emptyToUndefined(value.website),
					contactEmail: emptyToUndefined(value.contactEmail),
					dispatcherHealth: {
						...defaultValues.dispatcherHealth,
						staleAfterMinutes: Number(value.staleAfterMinutes),
						reportStaleAfterSeconds: Number(value.reportStaleAfterSeconds),
						alarmIntervalMinutes: Number(value.alarmIntervalMinutes),
					},
				},
			});
		},
	});

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionTitle>Organization profile</SectionTitle>
			</SectionHeader>
			<SettingsSectionContent>
				<form
					className="w-full max-w-2xl"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						form.handleSubmit();
					}}
				>
					<div className="grid min-w-0 gap-5">
						<FormField
							form={form}
							name="name"
							label="Organization name"
							description="The display name for your organization."
						>
							{(field, meta) => (
								<FormInput
									field={field}
									id={meta.id}
									placeholder="Acme Inc."
									descriptionId={meta.descriptionId}
									errorId={meta.errorId}
								/>
							)}
						</FormField>

						<FormField
							form={form}
							name="slug"
							label="Slug"
							description="URL-friendly identifier for your organization. Changing it moves this workspace's *.os.tedix.dev origin."
						>
							{(field, meta) => (
								<FormInput
									field={field}
									id={meta.id}
									placeholder="acme-inc"
									descriptionId={meta.descriptionId}
									errorId={meta.errorId}
								/>
							)}
						</FormField>

						<div className="grid min-w-0 gap-2">
							<Text weight="medium">Logo</Text>
							<OrganizationLogoUpload
								organizationId={organizationId}
								currentImageUrl={defaultValues.logoUrl}
								fallbackText={defaultValues.name}
								onChanged={() => void invalidateOrganization()}
							/>
						</div>

						<Separator />

						<FormField
							form={form}
							name="description"
							label="Description (optional)"
							description="A brief description of your organization (max 500 characters)."
						>
							{(field, meta) => (
								<FormTextarea
									field={field}
									id={meta.id}
									placeholder="Describe your organization..."
									descriptionId={meta.descriptionId}
									errorId={meta.errorId}
								/>
							)}
						</FormField>

						<FormField
							form={form}
							name="website"
							label="Website (optional)"
							description="Your organization's website."
						>
							{(field, meta) => (
								<FormInput
									field={field}
									id={meta.id}
									placeholder="https://example.com"
									descriptionId={meta.descriptionId}
									errorId={meta.errorId}
								/>
							)}
						</FormField>

						<FormField
							form={form}
							name="contactEmail"
							label="Contact email (optional)"
							description="Primary contact email for your organization."
						>
							{(field, meta) => (
								<FormInput
									field={field}
									id={meta.id}
									type="email"
									placeholder="contact@example.com"
									descriptionId={meta.descriptionId}
									errorId={meta.errorId}
								/>
							)}
						</FormField>

						<Separator />
						<Text>Runner health alarms</Text>
						{HEALTH_FIELDS.map(([name, label, description]) => (
							<FormField
								key={name}
								form={form}
								name={name}
								label={label}
								description={description}
							>
								{(field, meta) => (
									<FormInput
										field={field}
										id={meta.id}
										type="number"
										min={name === "alarmIntervalMinutes" ? 2 : 1}
										max={
											name === "staleAfterMinutes"
												? 10080
												: name === "reportStaleAfterSeconds"
													? 604800
													: 1440
										}
										step={name === "alarmIntervalMinutes" ? 2 : 1}
										descriptionId={meta.descriptionId}
										errorId={meta.errorId}
									/>
								)}
							</FormField>
						))}

						{updateOrganization.isError ? (
							<Alert variant="destructive">
								<AlertTitle>The profile was not saved</AlertTitle>
								<AlertDescription>
									{mutationErrorMessage(
										updateOrganization.error,
										"Failed to update organization",
									)}
								</AlertDescription>
							</Alert>
						) : null}

						<div className="flex flex-wrap items-center justify-end gap-2">
							{saved && !updateOrganization.isPending ? (
								<Text as="span" tone="secondary">
									Saved
								</Text>
							) : null}
							<Button
								loading={updateOrganization.isPending}
								type="submit"
								disabled={updateOrganization.isPending}
							>
								Save changes
							</Button>
						</div>
					</div>
				</form>
			</SettingsSectionContent>
		</SettingsSection>
	);
}

// ---------------------------------------------------------------------------
// Logo upload (Cloudflare Images Direct Creator Upload)
// ---------------------------------------------------------------------------

const ACCEPTED_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/svg+xml",
	"image/gif",
];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Mint a one-time upload URL, POST the file straight to Cloudflare (bypassing
 * Worker body limits), then confirm so the server binds the delivery URL to
 * the organization.
 */
async function directCreatorUpload(
	organizationId: string,
	file: File,
): Promise<{ url: string }> {
	const { imageId, uploadURL } = await osApi.images.requestUpload({
		entityType: "organization",
		entityId: organizationId,
	});

	const form = new FormData();
	form.append("file", file);
	const res = await fetch(uploadURL, { method: "POST", body: form });
	if (!res.ok) {
		throw new Error(`Upload failed (${res.status})`);
	}

	return osApi.images.confirmUpload({
		entityType: "organization",
		entityId: organizationId,
		imageId,
	});
}

export function OrganizationLogoUpload({
	organizationId,
	currentImageUrl,
	fallbackText,
	onChanged,
}: {
	organizationId: string;
	currentImageUrl?: string | null;
	fallbackText?: string;
	onChanged: () => void;
}) {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	const displayUrl = previewUrl || currentImageUrl;
	const initials = fallbackText
		?.split(" ")
		.map((w) => w[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();

	const uploadMutation = useMutation({
		mutationFn: (file: File) => directCreatorUpload(organizationId, file),
		onSuccess: (data) => {
			setPreviewUrl(data.url);
			setFailure(null);
			onChanged();
		},
		onError: (error) =>
			setFailure(mutationErrorMessage(error, "Upload failed")),
	});

	const deleteMutation = useMutation({
		mutationFn: () =>
			osApi.images.delete({
				entityType: "organization",
				entityId: organizationId,
			}),
		onSuccess: () => {
			setPreviewUrl(null);
			setFailure(null);
			onChanged();
		},
		onError: (error) =>
			setFailure(mutationErrorMessage(error, "Delete failed")),
	});

	const handleFile = useCallback(
		(file: File) => {
			if (!ACCEPTED_TYPES.includes(file.type)) {
				setFailure("Please upload a PNG, JPEG, WebP, SVG, or GIF image");
				return;
			}
			if (file.size > MAX_SIZE) {
				setFailure("Image must be under 5MB");
				return;
			}
			setFailure(null);
			uploadMutation.mutate(file);
		},
		[uploadMutation],
	);

	const isPending = uploadMutation.isPending || deleteMutation.isPending;

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-3">
				<Avatar
					className={
						isPending ? "size-16 shrink-0 opacity-60" : "size-16 shrink-0"
					}
				>
					{displayUrl ? (
						<AvatarImage src={displayUrl} alt={fallbackText || "Logo"} />
					) : null}
					<AvatarFallback>
						{isPending ? (
							<Loader size={20} />
						) : initials ? (
							initials
						) : (
							<ImageSquare className="h-5 w-5" />
						)}
					</AvatarFallback>
				</Avatar>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={isPending}
						onClick={() => fileInputRef.current?.click()}
					>
						<UploadSimple className="mr-1.5 h-3.5 w-3.5" />
						Upload
					</Button>
					{displayUrl ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={isPending}
							onClick={() => deleteMutation.mutate()}
						>
							<Trash className="mr-1.5 h-3.5 w-3.5" />
							Remove
						</Button>
					) : null}
					<input
						ref={fileInputRef}
						type="file"
						aria-label={`Upload ${fallbackText || "organization"} logo`}
						accept={ACCEPTED_TYPES.join(",")}
						className="hidden"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file) handleFile(file);
							event.target.value = "";
						}}
					/>
				</div>
			</div>
			{failure ? (
				<Text aria-atomic="true" aria-live="assertive" tone="error">
					{failure}
				</Text>
			) : null}
		</div>
	);
}
