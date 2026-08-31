import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute repository root, derived from this source file rather than cwd. */
export const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Resolve PumpTV-owned relative paths against the repository root. */
export function resolveProjectPath(value: string): string {
  return isAbsolute(value) ? value : resolve(PROJECT_ROOT, value);
}

export const CONFIG_PATH = resolveProjectPath(".config.toml");
