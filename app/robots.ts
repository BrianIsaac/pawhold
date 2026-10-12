import type { MetadataRoute } from "next";

/**
 * `robots.txt`: the landing page may be indexed; the doors, the owners'
 * links and the API may not, so a crawler following them never starts judge
 * sessions or reads an owner's estimate.
 *
 * @returns The rules.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/try/", "/e/", "/api/"] },
  };
}
