import { defineConfig } from "tsdown";

export default defineConfig([
  {
    clean: true,
    entry: { cli: "src/cli.ts" },
    fixedExtension: false,
    format: ["esm"],
    hash: false,
    sourcemap: true,
    target: "node22",
  },
  {
    dts: true,
    entry: { index: "src/index.ts" },
    fixedExtension: false,
    format: ["esm"],
    hash: false,
    sourcemap: true,
    target: "node22",
  },
]);
