import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	ShieldCheck,
	Trash,
	UploadSimple,
} from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { osApi } from "@/lib/api";
import { userProfileQueryOptions } from "@/lib/os-query-options";
import { useOsIdentity } from "@/lib/use-os-identity";
import { resolveOsTenant } from "@/shared/os-tenant";
import { TedixBrandMark } from "@/shared/tedix-brand";
import { buildBrokerStartPath } from "@/shared/session-status";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/kumo/avatar";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import { Loader } from "@/components/kumo/loader";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";

const ACCEPTED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export function profileInitials(name: string, email: string): string {
	const source = name.trim() || email.split("@")[0] || "T";
	return source
		.split(/\s+/)
		.map((part) => part[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	return fallback;
}

export async function uploadUserAvatar(file: File) {
	const { imageId, uploadURL, uploadNonce } =
		await osApi.userProfile.requestAvatarUpload({});
	const form = new FormData();
	form.append("file", file);
	const response = await fetch(uploadURL, { method: "POST", body: form });
	if (!response.ok)
		throw new Error(`Avatar upload failed (${response.status})`);
	return osApi.userProfile.confirmAvatarUpload({ imageId, uploadNonce });
}

export function ProfilePage() {
	const queryClient = useQueryClient();
	const brokerIdentity = useOsIdentity();
	const localEvaluation =
		resolveOsTenant(window.location.hostname).kind === "local";
	const profile = useQuery({
		...userProfileQueryOptions(),
		enabled: !localEvaluation,
	});
	const [name, setName] = useState("");
	const [avatarFailure, setAvatarFailure] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const currentName = profile.data?.name ?? brokerIdentity.name;
	const currentEmail = profile.data?.email ?? brokerIdentity.email;
	const currentAvatar =
		profile.data?.avatarUrl ?? brokerIdentity.avatarUrl ?? null;

	useEffect(() => {
		setName(currentName);
	}, [currentName, profile.data?.revision]);

	const updateName = useMutation({
		mutationFn: (nextName: string) =>
			osApi.userProfile.updateMine({
				name: nextName,
				expectedRevision: profile.data?.revision ?? 0,
			}),
		onSuccess: (updated) => {
			queryClient.setQueryData(userProfileQueryOptions().queryKey, updated);
			setName(updated.name ?? "");
			toast.success("Profile updated");
		},
	});

	const uploadAvatar = useMutation({
		mutationFn: uploadUserAvatar,
		onSuccess: (result) => {
			queryClient.setQueryData(
				userProfileQueryOptions().queryKey,
				(previous: typeof profile.data) =>
					previous
						? { ...previous, avatarUrl: result.url, revision: result.revision }
						: previous,
			);
			setAvatarFailure(null);
			void queryClient.invalidateQueries({
				queryKey: userProfileQueryOptions().queryKey,
			});
			toast.success("Avatar updated");
		},
		onError: (error) =>
			setAvatarFailure(errorMessage(error, "Avatar upload failed")),
	});

	const deleteAvatar = useMutation({
		mutationFn: () =>
			osApi.userProfile.deleteAvatar({
				expectedRevision: profile.data?.revision ?? 0,
			}),
		onSuccess: (result) => {
			queryClient.setQueryData(
				userProfileQueryOptions().queryKey,
				(previous: typeof profile.data) =>
					previous
						? { ...previous, avatarUrl: null, revision: result.revision }
						: previous,
			);
			setAvatarFailure(null);
			void queryClient.invalidateQueries({
				queryKey: userProfileQueryOptions().queryKey,
			});
			toast.success("Avatar removed");
		},
		onError: (error) =>
			setAvatarFailure(errorMessage(error, "Avatar removal failed")),
	});

	const submitName = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || !profile.data || trimmed === currentName) return;
		updateName.mutate(trimmed);
	};

	const handleFile = (file: File) => {
		if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
			setAvatarFailure("Choose a PNG, JPEG, or WebP image.");
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setAvatarFailure("Choose an image smaller than 5 MB.");
			return;
		}
		setAvatarFailure(null);
		uploadAvatar.mutate(file);
	};

	if (!localEvaluation && profile.isLoading) {
		return (
			<main className="centered-state" aria-busy="true">
				<TedixBrandMark />
				<Loader size="base" />
				<p>Loading your profile…</p>
			</main>
		);
	}

	if (!localEvaluation && profile.isError) {
		return (
			<main className="org-launcher">
				<Surface tier="panel" className="grid w-full max-w-2xl gap-5 p-6">
					<TedixBrandMark />
					<Alert variant="destructive">
						<AlertTitle>Could not load your profile</AlertTitle>
						<AlertDescription>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => profile.refetch()}
							>
								Try again
							</Button>
						</AlertDescription>
					</Alert>
				</Surface>
			</main>
		);
	}

	const avatarPending = uploadAvatar.isPending || deleteAvatar.isPending;
	const normalizedName = name.trim();
	const canSaveName =
		!localEvaluation &&
		Boolean(profile.data) &&
		normalizedName.length > 0 &&
		normalizedName !== currentName &&
		!updateName.isPending &&
		!avatarPending;

	return (
		<main className="org-launcher">
			<Surface tier="panel" className="grid w-full max-w-2xl gap-6 p-5 sm:p-7">
				<header className="grid gap-5">
					<div className="flex items-center justify-between gap-4">
						<TedixBrandMark />
						<Button
							render={<a href="/account/organizations" />}
							size="sm"
							variant="ghost"
							icon={<ArrowLeft size={15} aria-hidden="true" />}
						>
							Workspaces
						</Button>
					</div>
					<div>
						<h1 className="font-semibold text-kumo-strong type-tedix-title">
							Your profile
						</h1>
						<Text role="body" tone="secondary">
							Your name and avatar follow you across Tedix workspaces.
						</Text>
					</div>
				</header>

				{localEvaluation ? (
					<Alert>
						<AlertTitle>Local evaluation profile</AlertTitle>
						<AlertDescription>
							This isolated session uses a fixed local identity and does not
							write an account profile.
						</AlertDescription>
					</Alert>
				) : null}

				<Card>
					<CardHeader>
						<CardTitle>Profile photo</CardTitle>
						<CardDescription>PNG, JPEG, or WebP. Maximum 5 MB.</CardDescription>
					</CardHeader>
					<CardContent className="grid gap-3">
						<div className="flex flex-wrap items-center gap-4">
							<Avatar className="size-20">
								{currentAvatar ? (
									<AvatarImage src={currentAvatar} alt="" />
								) : null}
								<AvatarFallback className="type-tedix-section font-semibold">
									{avatarPending ? (
										<Loader size="sm" />
									) : (
										profileInitials(currentName, currentEmail)
									)}
								</AvatarFallback>
							</Avatar>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={
										localEvaluation || avatarPending || updateName.isPending
									}
									onClick={() => fileInputRef.current?.click()}
								>
									<UploadSimple size={15} aria-hidden="true" />
									Upload photo
								</Button>
								{currentAvatar ? (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={
											localEvaluation || avatarPending || updateName.isPending
										}
										onClick={() => deleteAvatar.mutate()}
									>
										<Trash size={15} aria-hidden="true" />
										Remove
									</Button>
								) : null}
								<input
									ref={fileInputRef}
									type="file"
									accept={ACCEPTED_AVATAR_TYPES.join(",")}
									className="sr-only"
									aria-label="Choose profile photo"
									onChange={(event) => {
										const file = event.target.files?.[0];
										if (file) handleFile(file);
										event.target.value = "";
									}}
								/>
							</div>
						</div>
						{avatarFailure ? (
							<div role="alert">
								<Text role="control" tone="error">
									{avatarFailure}
								</Text>
							</div>
						) : null}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Personal details</CardTitle>
						<CardDescription>
							Your email is verified and managed by your identity provider.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form className="grid gap-4" onSubmit={submitName}>
							<div className="grid gap-1.5">
								<Label htmlFor="profile-name">Display name</Label>
								<Input
									id="profile-name"
									value={name}
									maxLength={100}
									disabled={localEvaluation}
									onChange={(event) => setName(event.target.value)}
								/>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor="profile-email">Email</Label>
								<Input
									id="profile-email"
									value={currentEmail}
									readOnly
									disabled
								/>
							</div>
							{updateName.isError ? (
								<Alert variant="destructive">
									<AlertTitle>Profile was not updated</AlertTitle>
									<AlertDescription>
										{errorMessage(updateName.error, "Try again.")}
									</AlertDescription>
								</Alert>
							) : null}
							<div className="flex justify-end">
								<Button type="submit" disabled={!canSaveName}>
									{updateName.isPending ? <Loader size="sm" /> : null}
									Save name
								</Button>
							</div>
						</form>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<ShieldCheck size={18} aria-hidden="true" /> Security
						</CardTitle>
						<CardDescription>
							Passwords, passkeys, multi-factor authentication, recovery, and
							active sessions are managed by Tedix Identity. Tedix never stores
							a separate profile password.
						</CardDescription>
					</CardHeader>
					{!localEvaluation ? (
						<CardContent className="grid gap-3">
							<Text>
								To complete sign-in setup, sign out and verify your email again.
								Choose Continue by email when offered. Tedix Identity determines
								which setup steps are available for your account.
							</Text>
							<Button
								variant="secondary"
								render={
									<a
										href={buildBrokerStartPath("/auth/session-broker", {
											operation: "logout",
											redirectTo: "/account/profile",
										})}
									/>
								}
							>
								Sign out for sign-in setup
							</Button>
						</CardContent>
					) : null}
				</Card>
			</Surface>
		</main>
	);
}
