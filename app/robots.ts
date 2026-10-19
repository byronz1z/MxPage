import type { MetadataRoute } from "next";
import { publicSiteUrl } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  const site = publicSiteUrl();
  return {
    rules: site
      ? { userAgent: "*", allow: "/llms.txt", disallow: "/" }
      : { userAgent: "*", disallow: "/" },
  };
}
