import {
	QueryClient,
	QueryClientProvider,
	useMutation,
} from "@tanstack/react-query";
import type { Member } from "@tedix/api-contract/schemas/organization";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { TypedConfirmDialog } from "../src/components/typed-confirm-dialog";
import { ConfirmDialog } from "../src/components/confirm-dialog";
import { CreateDocumentDialog } from "../src/components/create-document-dialog";
import { Button } from "../src/components/kumo/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "../src/components/kumo/sheet";
import { MemberIdentityDialog } from "../src/components/member-identity-dialog";
import { SupportGetHelp } from "../src/components/support-get-help";
import { installViewportMetrics } from "../src/lib/viewport-metrics";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const member: Member = {
	id: "11111111-1111-4111-8111-000000000001",
	organizationId: "11111111-1111-4111-8111-000000000002",
	descopeUserId: "U-example",
	userId: "user-example",
	email: "luz@example.com",
	name: "Luz Moreno",
	avatarUrl: null,
	role: "member",
	kind: "human",
	customPermissions: null,
};

function ConfirmFixture() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>Remove member</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Remove team member?"
				description="Luz Moreno loses access to this organization. Their work stays where it is."
				confirmLabel="Remove member"
				pendingLabel="Removing…"
				destructive
				isPending={false}
				onConfirm={() => setOpen(false)}
			/>
		</>
	);
}

function TypedConfirmFixture() {
	const [open, setOpen] = useState(false);
	const mutation = useMutation({
		mutationFn: async () => {
			const response = await fetch("/browser-tests/typed-confirm-result");
			if (!response.ok)
				throw new Error("Organization could not be retired. Please retry.");
		},
		onSuccess: () => setOpen(false),
	});
	return (
		<>
			<Button
				onClick={() => {
					mutation.reset();
					setOpen(true);
				}}
			>
				Retire organization
			</Button>
			<TypedConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Retire organization?"
				description="This removes tenant access, disables its apps, and retires its tedis. Their durable memory is retained."
				expectedName="Example team"
				nameLabel="Organization name"
				confirmLabel="Retire organization"
				pendingLabel="Retiring…"
				destructive
				isPending={mutation.isPending}
				error={mutation.error}
				onConfirm={() => mutation.mutate()}
			/>
		</>
	);
}

function FormFixture() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>New document</Button>
			{open && (
				<CreateDocumentDialog
					workspaceId="11111111-1111-4111-8111-000000000003"
					onCreated={() => {}}
					onClose={() => setOpen(false)}
				/>
			)}
		</>
	);
}

function IdentityFixture() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>Edit identity</Button>
			{open && (
				<MemberIdentityDialog member={member} onClose={() => setOpen(false)} />
			)}
		</>
	);
}

function SheetFixture() {
	const [sheetOpen, setSheetOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	return (
		<>
			<Button onClick={() => setSheetOpen(true)}>Open details</Button>
			<Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
				<SheetContent size="md">
					<SheetHeader>
						<SheetTitle>Source details</SheetTitle>
						<SheetDescription>
							The connected source this workspace reads from.
						</SheetDescription>
					</SheetHeader>
					<div className="grid gap-3 px-4 sm:px-6">
						<Button variant="outline" onClick={() => setConfirmOpen(true)}>
							Remove source
						</Button>
					</div>
					<ConfirmDialog
						open={confirmOpen}
						onOpenChange={setConfirmOpen}
						title="Remove this source?"
						description="The workspace stops reading from it. You can add it again later."
						confirmLabel="Remove source"
						pendingLabel="Removing…"
						destructive
						isPending={false}
						onConfirm={() => setConfirmOpen(false)}
					/>
				</SheetContent>
			</Sheet>
		</>
	);
}

const views = {
	typed: TypedConfirmFixture,
	confirm: ConfirmFixture,
	form: FormFixture,
	identity: IdentityFixture,
	sheet: SheetFixture,
} as const;
const view = params.get("view");
const View = view && view in views ? views[view as keyof typeof views] : null;

installViewportMetrics();
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider
		client={
			// Gallery views render without an API; the support view keeps its
			// original default client.
			View
				? new QueryClient({
						defaultOptions: { queries: { enabled: false, retry: false } },
					})
				: new QueryClient()
		}
	>
		<main style={{ height: "200vh", padding: 24 }}>
			{View ? <View /> : <SupportGetHelp organization="Example team" />}
		</main>
	</QueryClientProvider>,
);
