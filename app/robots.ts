import type { MetadataRoute } from "next";
import { publicSiteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  const site = publicSiteUrl();
  return {
    rules: site
      ? { userAgent: "*", allow: "/", disallow: ["/api/", "/projects/", "/settings", "/monitor/", "/history", "/tasks", "/translate", "/xiaohongshu", "/batch-create", "/test-reports/"] }
      : { userAgent: "*", disallow: "/" },
    sitemap: site ? new URL("/sitemap.xml", site).href : undefined,
  };
}
