import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // Don't wipe dist/ on every watch rebuild: the backend dev server imports
  // it and would briefly see missing files.
  clean: !options.watch,
  sourcemap: true,
}));
