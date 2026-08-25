import { defineConfig } from "tsdown";

export default defineConfig([
  {
    clean: true,
    // a bin-only package: no library entry, so no declarations to ship
    dts: false,
    entry: { cli: "src/cli.ts" },
    fixedExtension: false,
    format: ["esm"],
    hash: false,
    sourcemap: true,
    target: "node22",
  },
]);
