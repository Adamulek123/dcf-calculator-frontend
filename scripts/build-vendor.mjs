import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("js/vendor", { recursive: true });
await build({
    entryPoints: ["scripts/firebase-vendor-entry.js"],
    outfile: "js/vendor/firebase-client.js",
    bundle: true,
    format: "esm",
    legalComments: "eof",
    minify: true,
    sourcemap: false,
    target: ["es2020"],
});
await copyFile(
    "node_modules/chart.js/dist/chart.umd.js",
    "js/vendor/chart.umd.min.js",
);
await writeFile(
    "js/vendor/THIRD_PARTY_NOTICES.md",
    [
        "# Third-party runtime notices",
        "",
        "- Firebase JavaScript SDK 11.6.1 — Apache License 2.0.",
        "- Chart.js 4.4.7 — MIT License.",
        "",
        "The generated runtime files retain their upstream license comments.",
        "",
    ].join("\n"),
);
