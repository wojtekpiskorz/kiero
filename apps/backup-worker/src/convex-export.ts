/**
 * The pinned documented export mechanism (I5): `npx --yes convex@1.45.0
 * export --path <zip> --deployment <ref>` driven headless.
 *
 * The CLI reads its access token from `<HOME>/.convex/config.json` and
 * needs an app-shaped directory (package.json with a convex dependency +
 * convex.json). The exporter materializes BOTH in an isolated scratch HOME,
 * writes the injected `CONVEX_BACKUP_ADMIN_KEY` there (the value never
 * touches the repo, logs or results), runs the pinned command and returns
 * the zip bytes plus their sha256.
 *
 * NODE-ONLY module (container program): it is never imported by the Worker
 * runtime surface. Missing credentials answer the typed `export_not_
 * configured` refusal - honest pending, never a fabricated export.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DatabaseExporter } from "./ports.ts";

const execFileAsync = promisify(execFile);

export interface ExportEnv {
  readonly CONVEX_EXPORT_DEPLOYMENT?: string;
  readonly CONVEX_BACKUP_ADMIN_KEY?: string;
}

/** The headless scratch context (isolated HOME with the CLI auth file). */
async function scratchContext(env: ExportEnv): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "kiero-backup-export-"));
  await mkdir(join(home, ".convex"), { recursive: true });
  await writeFile(
    join(home, ".convex", "config.json"),
    JSON.stringify({ accessToken: env.CONVEX_BACKUP_ADMIN_KEY }),
  );
  const appDir = join(home, "app");
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, "package.json"),
    JSON.stringify({ name: "kiero-backup-export", private: true, dependencies: { convex: "1.45.0" } }),
  );
  await writeFile(
    join(appDir, "convex.json"),
    JSON.stringify({ team: "wojtek-piskorz-jr", project: "kiero-dev-core", functions: "convex/" }),
  );
  return home;
}

async function sha256BytesHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The exporter over the pinned CLI (headless via the injected key). */
export class ConvexCliExporter implements DatabaseExporter {
  constructor(private readonly env: ExportEnv) {}

  async export(): Promise<
    | { readonly ok: true; readonly bytes: Uint8Array; readonly sha256Hex: string }
    | { readonly ok: false; readonly code: "export_not_configured" | "export_failed"; readonly exitCode?: number }
  > {
    const deployment = this.env.CONVEX_EXPORT_DEPLOYMENT;
    const key = this.env.CONVEX_BACKUP_ADMIN_KEY;
    if (deployment === undefined || deployment === "" || key === undefined || key === "") {
      return { ok: false, code: "export_not_configured" };
    }
    const home = await scratchContext(this.env);
    try {
      const outZip = join(home, "snapshot.zip");
      try {
        await execFileAsync(
          "npx",
          ["--yes", "convex@1.45.0", "export", "--path", outZip, "--deployment", deployment],
          {
            cwd: join(home, "app"),
            env: { ...process.env, HOME: home },
            timeout: 10 * 60 * 1000,
          },
        );
      } catch (error) {
        const code =
          typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
        // Sanitized: exit status only; the CLI's stderr never crosses.
        return { ok: false, code: "export_failed", exitCode: code };
      }
      const bytes = new Uint8Array(await readFile(outZip));
      return { ok: true, bytes, sha256Hex: await sha256BytesHex(bytes) };
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => null);
    }
  }
}
