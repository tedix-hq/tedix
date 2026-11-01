import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import {
	CONSENT_EVENT,
	createConsent,
	readConsent,
	writeConsent,
} from "@/lib/consent";
import { cn } from "@/lib/utils";

export interface ConsentContent {
	ariaLabel: string;
	title: string;
	description: string;
	policy: string;
	reject: string;
	manage: string;
	accept: string;
	dialogTitle: string;
	dialogDescription: string;
	necessary: string;
	necessaryDescription: string;
	analytics: string;
	analyticsDescription: string;
	cancel: string;
	saveNecessary: string;
	save: string;
}

interface ConsentBannerIslandProps {
	content: ConsentContent;
	variant?: "default" | "compact";
	compactLabel?: { accept: string; reject: string };
}

function browserStorage(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

export default function ConsentBannerIsland({
	content,
	variant = "default",
	compactLabel,
}: ConsentBannerIslandProps) {
	const isCompact = variant === "compact";
	const [bannerVisible, setBannerVisible] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [analytics, setAnalytics] = useState(false);

	const publishConsent = (consent: unknown) => {
		window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: consent }));
	};

	const persistConsent = (analyticsChoice: boolean) => {
		const consent = createConsent(analyticsChoice);
		writeConsent(browserStorage(), consent);
		setBannerVisible(false);
		setDialogOpen(false);
		publishConsent(consent);
	};

	const openDialog = () => {
		setAnalytics(readConsent(browserStorage())?.analytics === true);
		setDialogOpen(true);
	};

	useEffect(() => {
		const saved = readConsent(browserStorage());
		if (saved) {
			publishConsent(saved);
		} else {
			setBannerVisible(true);
		}
		const onClick = (event: MouseEvent) => {
			const trigger =
				event.target instanceof Element
					? event.target.closest("[data-consent-settings]")
					: null;
			if (trigger instanceof HTMLElement) openDialog();
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, []);

	useEffect(() => {
		if (dialogOpen) {
			document.documentElement.dataset.consentDialog = "open";
		} else {
			delete document.documentElement.dataset.consentDialog;
		}
		return () => {
			delete document.documentElement.dataset.consentDialog;
		};
	}, [dialogOpen]);

	return (
		<>
			{bannerVisible && (
				<aside
					id="consent-banner"
					className={
						isCompact
							? "fixed right-3 bottom-3 left-3 z-50 sm:left-auto sm:w-[min(24rem,calc(100vw-1.5rem))]"
							: "fixed inset-x-0 bottom-0 z-50 px-4 pb-4 sm:px-6"
					}
					role="complementary"
					aria-label={content.ariaLabel}
					data-consent-banner
					data-catalog-consent={isCompact ? "compact" : undefined}
					data-crawler-ignore
					data-nosnippet
				>
					<div
						className={
							isCompact
								? "rounded-md border border-border/70 bg-background/95 p-3 shadow-lg backdrop-blur"
								: "mx-auto flex max-w-5xl flex-col gap-4 rounded-md border border-border bg-background p-4 shadow-2xl sm:flex-row sm:items-center sm:justify-between"
						}
					>
						<div className={isCompact ? "space-y-2" : "max-w-3xl space-y-1"}>
							<h2
								className={
									isCompact
										? "font-semibold text-sm"
										: "font-semibold text-base"
								}
							>
								{content.title}
							</h2>
							{isCompact ? (
								<a
									href="/cookies"
									className="inline-flex text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
								>
									{content.policy}
								</a>
							) : (
								<p className="text-muted-foreground text-sm">
									{content.description}{" "}
									<a
										href="/cookies"
										className="font-medium text-foreground underline underline-offset-4"
									>
										{content.policy}
									</a>
								</p>
							)}
						</div>
						<div
							className={
								isCompact
									? "mt-3 grid grid-cols-3 gap-2"
									: "flex flex-col gap-2 sm:flex-row sm:items-center"
							}
						>
							<Button
								variant="outline"
								size={isCompact ? "sm" : "default"}
								className={cn(isCompact && "min-w-0 truncate px-2 text-xs")}
								aria-label={isCompact ? content.reject : undefined}
								data-consent-action="reject"
								onClick={() => persistConsent(false)}
							>
								{isCompact ? compactLabel?.reject : content.reject}
							</Button>
							<Button
								variant="outline"
								size={isCompact ? "sm" : "default"}
								className={cn(isCompact && "px-2 text-xs")}
								data-consent-action="manage"
								onClick={openDialog}
							>
								{content.manage}
							</Button>
							<Button
								size={isCompact ? "sm" : "default"}
								className={cn(isCompact && "min-w-0 truncate px-2 text-xs")}
								aria-label={isCompact ? content.accept : undefined}
								data-consent-action="accept"
								onClick={() => persistConsent(true)}
							>
								{isCompact ? compactLabel?.accept : content.accept}
							</Button>
						</div>
					</div>
				</aside>
			)}
			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog
					size="lg"
					className="max-h-[calc(100dvh-4rem)] overflow-y-auto p-5"
				>
					<Dialog.Title className="font-semibold text-lg">
						{content.dialogTitle}
					</Dialog.Title>
					<Dialog.Description className="mt-2 text-muted-foreground text-sm">
						{content.dialogDescription}
					</Dialog.Description>
					<div className="mt-5 space-y-4">
						<Checkbox.Item
							appearance="card"
							checked
							disabled
							label={content.necessary}
							description={content.necessaryDescription}
						/>
						<Checkbox.Item
							appearance="card"
							checked={analytics}
							onCheckedChange={(checked) => setAnalytics(checked === true)}
							label={content.analytics}
							description={content.analyticsDescription}
						/>
					</div>
					<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<Dialog.Close
							render={(props) => (
								<Button variant="outline" {...props}>
									{content.cancel}
								</Button>
							)}
						/>
						<Button
							variant="outline"
							data-consent-action="save-necessary"
							onClick={() => persistConsent(false)}
						>
							{content.saveNecessary}
						</Button>
						<Button
							data-consent-action="save"
							onClick={() => persistConsent(analytics)}
						>
							{content.save}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</>
	);
}
