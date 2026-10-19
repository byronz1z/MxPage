import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  // The root is a personal workspace, not a public product landing page.
  return [];
}
