import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type FlatConfig = Record<string, string>;

function envPart(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function flattenTomlConfig(parsed: Record<string, unknown>): FlatConfig {
  const env: FlatConfig = {};
  for (const [section, raw] of Object.entries(parsed)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const prefix = envPart(section);
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value == null || typeof value === "object") continue;
      env[`${prefix}_${envPart(key)}`] = String(value);
    }
  }
  return env;
}

export async function readTomlEnvironment(
  projectRoot: string,
  relativePath: string,
  options: { required?: boolean } = {},
): Promise<FlatConfig> {
  const absolutePath = resolve(projectRoot, relativePath);
  if (!existsSync(absolutePath)) {
    if (options.required) throw new Error(`Missing ${relativePath}`);
    return {};
  }
  const parsed = Bun.TOML.parse(await Bun.file(absolutePath).text()) as Record<
    string,
    unknown
  >;
  return flattenTomlConfig(parsed);
}

export async function loadTomlEnvironment(
  projectRoot: string,
  relativePath: string,
  options: { required?: boolean; overwrite?: boolean } = {},
) {
  const values = await readTomlEnvironment(projectRoot, relativePath, options);
  for (const [key, value] of Object.entries(values)) {
    if (!options.overwrite && process.env[key] != null) continue;
    process.env[key] = value;
  }
  return values;
}
