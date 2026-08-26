// @ts-check
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://brain.jcsoftdev.com",
  output: "static",
  build: { inlineStylesheets: "auto" },
});
