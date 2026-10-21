import type { ReactNode } from "react";
import {
	SectionActions,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";

export function BillingSectionHeader({
	title,
	description,
	actions,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}) {
	return (
		<SectionHeader className={className}>
			<SectionHeading>
				<SectionTitle>{title}</SectionTitle>
				{description && <SectionDescription>{description}</SectionDescription>}
			</SectionHeading>
			{actions && <SectionActions>{actions}</SectionActions>}
		</SectionHeader>
	);
}
