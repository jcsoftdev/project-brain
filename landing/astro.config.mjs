// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://brain.jcsoftdev.com",
  output: "static",
  build: { inlineStylesheets: "auto" },
  integrations: [
    sitemap({
      // robots.txt already advertises /sitemap-index.xml. The 404 page is a
      // real route in the build output, so it has to be filtered out — a
      // sitemap that lists an error page teaches a crawler to index it.
      filter: (page) => !page.includes("/404"),
    }),
  ],
});
