import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { publicSiteUrl } from "../lib/seo";
import robots from "../app/robots";
import sitemap from "../app/sitemap";

test("local deployments do not advertise indexable workspace URLs", () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    assert.equal(publicSiteUrl(), undefined);
    assert.deepEqual(robots().rules, { userAgent: "*", disallow: "/" });
    assert.deepEqual(sitemap(), []);
    process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3000";
    assert.equal(publicSiteUrl(), undefined);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = original;
  }
});

test("a public origin does not expose workspace routes through robots or sitemap", () => {
  const original = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    process.env.NEXT_PUBLIC_SITE_URL = "https://mxpage.example.com/some-path";
    assert.equal(publicSiteUrl()?.origin, "https://mxpage.example.com");
    assert.deepEqual(sitemap(), []);
    assert.deepEqual(robots().rules, { userAgent: "*", allow: "/llms.txt", disallow: "/" });
    process.env.NEXT_PUBLIC_SITE_URL = "https://user:password@example.com";
    assert.equal(publicSiteUrl(), undefined);
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = original;
  }
});

test("public AI index matches the repository source", () => {
  assert.equal(fs.readFileSync(new URL("../llms.txt", import.meta.url), "utf8"), fs.readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8"));
});
