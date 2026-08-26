import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { join } from "node:path";

const parseEnvFile = (
  filePath: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (content === null) return {};
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      const isDoubleQuoted =
        value.length >= 2 &&
        value[0] === '"' &&
        value[value.length - 1] === '"';
      const isSingleQuoted =
        value.length >= 2 &&
        value[0] === "'" &&
        value[value.length - 1] === "'";
      if (isDoubleQuoted || isSingleQuoted) {
        value = value.slice(1, -1);
      }
      if (isDoubleQuoted) {
        value = value.replace(/\\([nrt\\])/g, (_, ch: string) => {
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
          };
          return escapes[ch] ?? ch;
        });
      }
      vars[key] = value;
    }
    return vars;
  });

/**
 * Resolve all env vars from .env files with process.env fallback.
 *
 * Precedence: .drover/.env > process.env
 * Only keys declared in .drover/.env are resolved from process.env.
 * Repo root .env is not part of the resolution chain.
 */
export const resolveEnv = (
  repoDir: string,
): Effect.Effect<Record<string, string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const droverEnv = yield* parseEnvFile(join(repoDir, ".drover", ".env"));

    const result: Record<string, string> = {};
    for (const key of Object.keys(droverEnv)) {
      const value = droverEnv[key] || process.env[key];
      if (value) {
        result[key] = value;
      }
    }

    return result;
  });
