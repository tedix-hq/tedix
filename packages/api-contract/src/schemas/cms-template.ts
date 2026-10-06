/** Installed scaffolds; selection initializes a site and never switches a live theme. */
export const CMS_TEMPLATE_SLUGS = [
	"tedix",
	"marketing",
	"starter",
	"blog",
	"portfolio",
	"native-marketing",
] as const;
export type CmsTemplateSlug = (typeof CMS_TEMPLATE_SLUGS)[number];
