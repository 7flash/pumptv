import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readTomlEnvironment } from "../../../../src/server/config-file.ts";
import { measuredRoute } from "../../../../src/server/observability.ts";
import { PROJECT_ROOT } from "../../../../src/server/project-paths.ts";
import { getManagedWorkerStatus } from "../../../../src/server/worker-manager.ts";

function adminToken(request: Request) {
  const direct = request.headers.get("x-pumptv-admin-token")?.trim();
  if (direct) return direct;
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function authorize(request: Request): Response | null {
  const expected = (process.env.PUMPTV_ADMIN_TOKEN || "").trim();
  if (!expected)
    return Response.json(
      { error: "PUMPTV_ADMIN_TOKEN is not configured." },
      { status: 503 },
    );
  if (adminToken(request) !== expected)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function bool(value: string | undefined) {
  return value === "1" || value?.toLowerCase() === "true";
}

function resolvedDb(value: string | undefined) {
  return resolve(PROJECT_ROOT, value || ".data/pumptv.sqlite");
}

function hostOnly(value: string | undefined) {
  const text = (value || "").trim();
  if (!text) return null;
  try {
    return new URL(text).host;
  } catch {
    return "invalid-url";
  }
}

function changed(runtime: string | undefined, file: string | undefined) {
  return String(runtime ?? "") !== String(file ?? "");
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;

    const webConfigPath = resolve(PROJECT_ROOT, ".config.toml");
    const workerConfigPath = resolve(PROJECT_ROOT, ".worker.toml");
    const webFile = await readTomlEnvironment(PROJECT_ROOT, ".config.toml");
    const workerFile = await readTomlEnvironment(PROJECT_ROOT, ".worker.toml");
    const issues: string[] = [];

    if (!existsSync(webConfigPath)) issues.push("Missing .config.toml");
    if (!existsSync(workerConfigPath)) issues.push("Missing .worker.toml");

    const runtimeRoom = process.env.PUMPTV_ROOM || "main";
    const fileRoom = webFile.PUMPTV_ROOM || "main";
    const workerRoom = workerFile.PUMPTV_ROOM || "main";
    const runtimeDb = resolvedDb(process.env.PUMPTV_DB_PATH);
    const fileDb = resolvedDb(webFile.PUMPTV_DB_PATH);
    const workerDb = resolvedDb(workerFile.PUMPTV_DB_PATH);
    const runtimeMint = (process.env.PUMPTV_TOKEN_MINT || "").trim();
    const fileMint = (webFile.PUMPTV_TOKEN_MINT || "").trim();

    if (runtimeRoom !== fileRoom)
      issues.push(
        `Running web room '${runtimeRoom}' differs from .config.toml '${fileRoom}'; restart PumpTV.`,
      );
    if (runtimeDb !== fileDb)
      issues.push(
        `Running web DB '${runtimeDb}' differs from .config.toml '${fileDb}'; restart PumpTV.`,
      );
    if (runtimeMint !== fileMint)
      issues.push(
        "Running web token mint differs from .config.toml; restart PumpTV.",
      );
    if (!runtimeMint)
      issues.push(
        "PUMPTV_TOKEN_MINT is not configured in the running web process.",
      );
    if (workerRoom !== runtimeRoom)
      issues.push(
        `.worker.toml room '${workerRoom}' differs from web room '${runtimeRoom}'.`,
      );
    if (workerDb !== runtimeDb)
      issues.push(
        `.worker.toml DB '${workerDb}' differs from web DB '${runtimeDb}'.`,
      );
    if (!(process.env.PUMPTV_ADMIN_TOKEN || "").trim())
      issues.push(
        "PUMPTV_ADMIN_TOKEN is not configured in the running web process.",
      );
    if (!(process.env.PUMPTV_MODERATION_SECRET || "").trim())
      issues.push(
        "PUMPTV_MODERATION_SECRET is not configured; IP moderation cannot hash origins safely.",
      );
    if (!workerFile.FAL_KEY)
      issues.push("FAL_KEY is missing from .worker.toml.");

    const staleKeys = [
      "PUMPTV_ROOM",
      "PUMPTV_DB_PATH",
      "PUMPTV_TOKEN_MINT",
      "PUMPTV_MODERATION_DB_PATH",
      "PUMPTV_MODERATION_SECRET",
      "PUMPTV_TRUST_PROXY_HEADERS",
    ].filter((key) => changed(process.env[key], webFile[key]));

    return Response.json({
      ok: issues.length === 0,
      serverNowMs: Date.now(),
      web: {
        pid: process.pid,
        configExists: existsSync(webConfigPath),
        configStale: staleKeys.length > 0,
        staleKeys,
        room: runtimeRoom,
        dbPath: runtimeDb,
        tokenMint: runtimeMint || null,
        tokenMintOnDisk: fileMint || null,
        solanaRpcHost: hostOnly(
          process.env.PUMPTV_SOLANA_RPC_URL ||
            "https://api.mainnet-beta.solana.com",
        ),
        adminTokenConfigured: Boolean(
          (process.env.PUMPTV_ADMIN_TOKEN || "").trim(),
        ),
        moderation: {
          configured: Boolean(
            (process.env.PUMPTV_MODERATION_SECRET || "").trim(),
          ),
          dbPath: resolve(
            PROJECT_ROOT,
            process.env.PUMPTV_MODERATION_DB_PATH ||
              ".data/pumptv-moderation.sqlite",
          ),
          trustProxyHeaders: bool(process.env.PUMPTV_TRUST_PROXY_HEADERS),
        },
      },
      worker: {
        configExists: existsSync(workerConfigPath),
        room: workerRoom,
        dbPath: workerDb,
        falConfigured: Boolean(workerFile.FAL_KEY),
        exaConfigured: Boolean(workerFile.EXA_API_KEY),
        jsxModel: workerFile.JSX_AI_MODEL || "default",
        process: getManagedWorkerStatus(),
      },
      issues,
    });
  });
}
