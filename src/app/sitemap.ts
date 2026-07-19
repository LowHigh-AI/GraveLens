import type { MetadataRoute } from "next";

const SITE = "https://www.gravelens.com";

// Public, indexable routes only. Authenticated/transactional pages (billing,
// plan, topup, queue, result, auth) are intentionally excluded and disallowed
// in robots.ts.
export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ["", "/explorer", "/map"];
  return routes.map((path) => ({
    url: `${SITE}${path}`,
    changeFrequency: "weekly",
    priority: path === "" ? 1 : 0.7,
  }));
}
