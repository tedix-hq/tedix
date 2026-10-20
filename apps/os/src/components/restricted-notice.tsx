import { ShieldCheck } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/kumo/card";
import { Text } from "@/components/kumo/text";

export function RestrictedNotice({
	title,
	description,
	icon = <ShieldCheck className="size-5 shrink-0" aria-hidden />,
}: {
	title: ReactNode;
	description: ReactNode;
	icon?: ReactNode;
}) {
	return (
		<Card size="sm">
			<CardContent className="flex items-center gap-3">
				{icon}
				<div>
					<Text role="body" weight="medium">
						{title}
					</Text>
					<Text tone="secondary">{description}</Text>
				</div>
			</CardContent>
		</Card>
	);
}
