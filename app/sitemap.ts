import type { MetadataRoute } from "next";
import { publicSiteUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const site = publicSiteUrl();
  return site ? [{ url: site.href, changeFrequency: "monthly", priority: 1 }] : [];
}
