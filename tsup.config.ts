import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    main: "src/main.ts",
    board: "src/board/index.ts",
    "board-cli": "src/board/cli.ts",
    "sandboxes/docker": "src/sandboxes/docker.ts",
    "sandboxes/podman": "src/sandboxes/podman.ts",
    "sandboxes/vercel": "src/sandboxes/vercel.ts",
    "sandboxes/daytona": "src/sandboxes/daytona.ts",
    "sandboxes/no-sandbox": "src/sandboxes/no-sandbox.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node18",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  treeshake: true,
  external: ["@vercel/sandbox", "@daytona/sdk"],
  // tsup's default `removeNodeProtocol: true` unconditionally strips the
  // "node:" prefix from every `node:x` import and marks it external as the
  // bare name — fine for `node:fs`/`node:path` (legacy bare aliases exist),
  // silently broken for `node:sqlite` (board/db.ts), which has never had one:
  // the bundled output ends up importing a nonexistent bare "sqlite"
  // package. Node has supported the "node:" prefix since well before this
  // package's node18 target, so there's no compatibility reason to strip it.
  removeNodeProtocol: false,
  define: {
    __DROVER_VERSION__: JSON.stringify(pkg.version),
  },
  // Some bundled CJS dependencies (notably `undici` via `@effect/platform-node`)
  // use `require()` of Node built-ins. ESM has no `require`, so we install one
  // via `createRequire` so the bundled CJS-shaped code keeps working.
  banner: {
    js: [
      "import { createRequire as __droverCreateRequire } from 'node:module';",
      "const require = __droverCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
