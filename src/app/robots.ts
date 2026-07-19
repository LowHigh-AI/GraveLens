import type { MetadataRoute } from "next";

const SITE = "https://www.gravelens.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Authenticated / transactional surfaces that should not be indexed.
      disallow: ["/api/", "/auth/", "/billing/", "/plan", "/topup", "/queue", "/result/"],
    },
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
