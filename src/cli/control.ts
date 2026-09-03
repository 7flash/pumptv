import { fileURLToPath } from "node:url";
import { loadTomlEnvironment } from "../server/config-file.ts";
import type { PromptRound, StreamState } from "../shared/contracts.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
await loadTomlEnvironment(PROJECT_ROOT, ".config.toml");

const command = process.argv[2] || "status";
const rawArgs = process.argv.slice(3);
const localOnly = rawArgs.includes("--local");
const args = rawArgs.filter((arg) => arg !== "--local");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ADMIN_URL = (process.env.PUMPTV_ADMIN_URL || "")
  .trim()
  .replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.PUMPTV_ADMIN_TOKEN || "").trim();

function remoteHeaders(json = false) {
  const headers: Record<string, string> = {};
  if (ADMIN_TOKEN) headers["x-pumptv-admin-token"] = ADMIN_TOKEN;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function remoteJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${ADMIN_URL}${path}`, init);
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok)
    throw new Error(
      payload?.error || `Remote PumpTV returned HTTP ${response.status}`,
    );
  return payload;
}

function triggerSelectionArgs(commandName: string, values: string[]) {
  if (commandName === "force") {
    const proposalId = Number((values[0] || "").replace(/^#/, ""));
    if (!Number.isSafeInteger(proposalId) || proposalId <= 0)
      throw new Error("force requires a proposal id");
    return { proposalId };
  }
  const proposalFlag = values.indexOf("--proposal");
  if (proposalFlag >= 0) {
    const proposalId = Number(
      (values[proposalFlag + 1] || "").replace(/^#/, ""),
    );
    if (!Number.isSafeInteger(proposalId) || proposalId <= 0)
      throw new Error("--proposal requires a positive proposal id");
    return { proposalId };
  }
  const textFlag = values.indexOf("--text");
  if (textFlag >= 0) {
    const text = values
      .slice(textFlag + 1)
      .join(" ")
      .trim();
    if (!text) throw new Error("--text requires an exact proposal text");
    return { text };
  }
  if (values.length === 1 && /^#?\d+$/.test(values[0]))
    return { proposalId: Number(values[0].replace(/^#/, "")) };
  return {};
}

function positiveArg(value: string | undefined, label: string) {
  const id = Number(String(value || "").replace(/^#/, ""));
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error(`${label} must be a positive integer`);
  return id;
}

function proposalArg(values: string[]) {
  const flag = values.indexOf("--proposal");
  if (flag >= 0) return positiveArg(values[flag + 1], "--proposal");
  const positional = values.find((value) => !value.startsWith("--"));
  return positiveArg(positional, "proposal id");
}

function reasonArg(values: string[]) {
  const flag = values.indexOf("--reason");
  if (flag < 0) return undefined;
  const parts: string[] = [];
  for (
    let i = flag + 1;
    i < values.length && !values[i].startsWith("--");
    i += 1
  )
    parts.push(values[i]);
  return parts.join(" ").trim() || undefined;
}

function printPromptArtifact(artifact: any) {
  const section = (title: string, value: unknown) => {
    console.log(`\n── ${title} ${"─".repeat(Math.max(2, 66 - title.length))}`);
    if (value == null || value === "") console.log("(none)");
    else if (typeof value === "string") console.log(value);
    else console.log(JSON.stringify(value, null, 2));
  };

  console.log(
    `EP ${artifact.episode} · clip #${artifact.clipId}` +
      `${artifact.directiveId == null ? "" : ` · directive #${artifact.directiveId}`}` +
      `${artifact.generation?.mode ? ` · ${artifact.generation.mode}` : ""}`,
  );
  section("SELECTED IDEA", artifact.proposal);
  section("RESOLVED REFERENCES", artifact.references);
  section("FACT OVERLAY", artifact.factOverlay ?? null);
  section("FACT END KEYFRAME", artifact.factKeyframe ?? null);
  section("SHOWRUNNER PLAN", artifact.showrunner?.plan);
  section("H3 INPUT PROMPT", artifact.h3?.prompt);
  section("FAL EXPANDED PROMPT", artifact.h3?.expandedPrompt);
  section("GENERATION META", {
    showrunnerModel: artifact.showrunner?.model ?? null,
    showrunnerInputTokens: artifact.showrunner?.inputTokens ?? null,
    showrunnerOutputTokens: artifact.showrunner?.outputTokens ?? null,
    showrunnerMs: artifact.showrunner?.ms ?? null,
    h3Ms: artifact.h3?.ms ?? null,
    inferenceSeconds: artifact.h3?.inferenceSeconds ?? null,
    totalMs: artifact.generation?.totalMs ?? null,
    resolution: artifact.h3?.resolution ?? null,
    requestId: artifact.generation?.requestId ?? null,
    videoUrl: artifact.generation?.videoUrl ?? null,
    anchorFrameUrl: artifact.generation?.anchorFrameUrl ?? null,
  });
}

async function handleRemoteCommand() {
  if (!ADMIN_URL || localOnly) return false;

  if (command === "doctor") {
    const payload = await remoteJson("/api/admin/doctor", {
      headers: remoteHeaders(),
    });
    console.log(`[doctor] target remote ${ADMIN_URL}`);
    console.log(
      `[doctor] web pid ${payload.web?.pid ?? "?"} · room ${payload.web?.room ?? "?"}`,
    );
    console.log(`[doctor] db ${payload.web?.dbPath ?? "?"}`);
    console.log(`[doctor] token mint ${payload.web?.tokenMint || "MISSING"}`);
    if (payload.web?.configStale)
      console.log(
        `[doctor] RESTART REQUIRED · stale: ${(payload.web.staleKeys || []).join(", ")}`,
      );
    console.log(
      `[doctor] worker ${payload.worker?.process?.state || "?"}${payload.worker?.process?.pid ? ` pid ${payload.worker.process.pid}` : ""} · FAL ${payload.worker?.falConfigured ? "ok" : "MISSING"} · Exa ${payload.worker?.exaConfigured ? "ok" : "off"}`,
    );
    console.log(
      `[doctor] moderation ${payload.web?.moderation?.configured ? "ok" : "MISSING SECRET"} · proxy headers ${payload.web?.moderation?.trustProxyHeaders ? "trusted" : "direct only"}`,
    );
    if ((payload.issues || []).length) {
      console.log("[doctor] issues:");
      for (const issue of payload.issues) console.log(`  - ${issue}`);
      process.exitCode = 2;
    } else {
      console.log("[doctor] OK");
    }
    return true;
  }
  if (command === "status") {
    const payload = await remoteJson("/api/status", {
      headers: remoteHeaders(),
    });
    console.log(`[control] remote ${ADMIN_URL}`);
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  if (command === "json") {
    const payload = await remoteJson("/api/state", {
      headers: remoteHeaders(),
    });
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  if (command === "board") {
    const payload = await remoteJson("/api/admin/trigger", {
      headers: remoteHeaders(),
    });
    for (const proposal of payload.proposals || [])
      console.log(`#${proposal.id}  ${proposal.score}  ${proposal.text}`);
    return true;
  }
  if (command === "trigger" || command === "close" || command === "force") {
    const body = triggerSelectionArgs(command, args);
    const payload = await remoteJson("/api/admin/trigger", {
      method: "POST",
      headers: remoteHeaders(true),
      body: JSON.stringify(body),
    });
    console.log(
      `[control] remote selected #${payload?.proposal?.id ?? "?"}` +
        `${payload?.proposal?.rank ? ` · rank ${payload.proposal.rank}` : ""}` +
        `${payload?.proposal?.score != null ? ` · score ${payload.proposal.score}` : ""}` +
        ` → ${payload?.proposal?.text ?? payload?.directive?.text ?? "selected proposal"}`,
    );
    return true;
  }
  if (command === "resolve") {
    const refresh = args.includes("--refresh");
    const force = args.includes("--force");
    const text = args
      .filter((arg) => arg !== "--refresh" && arg !== "--force")
      .join(" ")
      .trim();
    if (!text) throw new Error("resolve requires prompt text");
    const payload = await remoteJson("/api/admin/resolve", {
      method: "POST",
      headers: remoteHeaders(true),
      body: JSON.stringify({ text, refresh, force }),
    });
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  if (command === "prompt" || command === "episode") {
    const jsonOutput = args.includes("--json");
    const target = args.find((arg) => arg !== "--json") || "latest";
    const payload = await remoteJson(
      `/api/admin/prompt?episode=${encodeURIComponent(target)}`,
      { headers: remoteHeaders() },
    );
    if (jsonOutput) console.log(JSON.stringify(payload, null, 2));
    else printPromptArtifact(payload);
    return true;
  }
  if (command === "wallet") {
    const address = args.find((arg) => !arg.startsWith("--")) || "";
    if (!address) throw new Error("wallet requires an EVM address");
    const refresh = args.includes("--refresh") ? "&refresh=1" : "";
    const payload = await remoteJson(
      `/api/wallet/score?walletAddress=${encodeURIComponent(address)}${refresh}`,
      { headers: remoteHeaders() },
    );
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }
  if (command === "bans") {
    const payload = await remoteJson("/api/admin/moderation", {
      headers: remoteHeaders(),
    });
    if (!(payload.bans || []).length)
      console.log("[control] no moderation bans");
    for (const ban of payload.bans || [])
      console.log(
        `#${ban.id}  ${ban.active ? "ACTIVE" : "off"}  ${ban.hash}  ${ban.reason || ""}`.trim(),
      );
    return true;
  }
  if (["remove", "ban", "ban-ip", "unban"].includes(command)) {
    let body: Record<string, unknown>;
    if (command === "remove")
      body = { action: "remove", proposalId: proposalArg(args) };
    else if (command === "ban")
      body = {
        action: "ban-proposal",
        proposalId: proposalArg(args),
        reason: reasonArg(args),
      };
    else if (command === "ban-ip") {
      const ip = args.find((value) => !value.startsWith("--"));
      if (!ip) throw new Error("ban-ip requires an IP address");
      body = { action: "ban-ip", ip, reason: reasonArg(args) };
    } else body = { action: "unban", banId: positiveArg(args[0], "ban id") };
    const payload = await remoteJson("/api/admin/moderation", {
      method: "POST",
      headers: remoteHeaders(true),
      body: JSON.stringify(body),
    });
    console.log(`[control] remote ${ADMIN_URL}`);
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }

  throw new Error(
    `${command} is local-only while PUMPTV_ADMIN_URL is configured. Pass --local to explicitly operate the local database.`,
  );
}

if (await handleRemoteCommand()) process.exit(0);

const repo = await import("../server/repository.ts");
const { db } = await import("../server/db.ts");

function usage() {
  console.log(
    `PumpTV control

  bun run control -- doctor [--local]
  bun run control -- status [--local]
  bun run control -- board [--local]
  bun run control -- watch --local
  bun run control -- json [--local]
  bun run control -- resolve [--refresh] [--force] <prompt...>
  bun run control -- prompt <episode|latest> [--json] [--local]
  bun run control -- wallet [--refresh] <address>
  bun run control -- reward-wallet --local
  bun run control -- rewards --local
  bun run control -- remove --proposal <id>
  bun run control -- ban --proposal <id> [--reason <text>]
  bun run control -- ban-ip <ip> [--reason <text>]
  bun run control -- bans
  bun run control -- unban <banId>
  bun run control -- set-votes <proposalId> <count|auto> --local
  bun run control -- trigger [--proposal <id> | --text <exact text>]
  bun run control -- force <proposalId>
  bun run control -- inject <prompt...> --local
  bun run control -- inject-force <prompt...> --local
  bun run control -- clear-queue --local
  bun run control -- clear-turn --local
`,
  );
}

function roundLines(
  label: string,
  round: PromptRound | null,
  now = Date.now(),
) {
  if (!round) return [`${label}: none`];
  const left =
    round.status === "open" && round.closesAtMs
      ? Math.max(0, round.closesAtMs - now)
      : null;
  const lines = [
    `${label}: #${round.id} → EP ${round.targetEpisode + 1} · ${round.status}${left == null ? "" : ` · ${(left / 1000).toFixed(1)}s`}`,
  ];
  for (const p of round.proposals) {
    lines.push(
      `${p.status === "selected" ? ">" : " "} #${p.id}  ${p.voteCount}${p.operatorVoteOverride == null ? "" : "*"}  [${p.ownerWeight}+${p.realVoteCount}; ${p.voterCount} voter${p.voterCount === 1 ? "" : "s"}]  @${p.author || p.authorAddress || "anon"}  ${p.text}`,
    );
  }
  return lines;
}

function statusLines(state: StreamState, now = Date.now()) {
  const p = state.program;
  const lines = [
    `program: ${p.phase.toUpperCase()} · live EP ${p.liveEpisode == null ? "—" : p.liveEpisode + 1} · target EP ${p.targetEpisode + 1}`,
    `worker: ${state.room.workerOnline ? "online" : "offline"} · ${state.room.workerProcess.state}${state.room.workerProcess.pid ? ` pid ${state.room.workerProcess.pid}` : ""}`,
  ];
  if (p.reason) lines.push(`reason: ${p.reason}`);
  if (p.directive)
    lines.push(
      `locked: ${p.directive.text} · @${p.directive.author || p.directive.authorAddress || "?"}`,
    );
  if (p.generationStartedAtMs)
    lines.push(
      `generation: ${state.room.generationStage} · ${((now - p.generationStartedAtMs) / 1000).toFixed(1)}s`,
    );
  if (state.room.prewarm?.stage && state.room.prewarm.stage !== "idle")
    lines.push(
      `prewarm: ${state.room.prewarm.stage} · round #${state.room.prewarm.roundId ?? "?"} · proposal #${state.room.prewarm.proposalId ?? "?"}${state.room.prewarm.startedAtMs ? ` · ${((now - state.room.prewarm.startedAtMs) / 1000).toFixed(1)}s` : ""}`,
    );
  lines.push(...roundLines("decision", p.decisionRound, now));
  if (p.votingRound?.id !== p.decisionRound?.id)
    lines.push(...roundLines("voting", p.votingRound, now));
  lines.push(
    `episodes: ${state.timeline.length} · queued winners: ${state.queuedCount} · viewers: ${state.room.viewerCount}`,
  );
  return lines;
}

function stateSignature(state: StreamState) {
  return JSON.stringify({
    phase: state.program.phase,
    live: state.program.liveEpisode,
    target: state.program.targetEpisode,
    directive: state.program.directive?.id ?? null,
    stage: state.room.generationStage,
    prewarm: [
      state.room.prewarm?.roundId ?? null,
      state.room.prewarm?.proposalId ?? null,
      state.room.prewarm?.stage ?? "idle",
    ],
    decision: state.program.decisionRound?.id ?? null,
    voting: state.program.votingRound?.id ?? null,
    proposals:
      state.program.votingRound?.proposals.map((p) => [
        p.id,
        p.voteCount,
        p.status,
      ]) ?? [],
    clips: state.timeline.length,
    queued: state.queuedCount,
  });
}

if (command === "doctor") {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { readTomlEnvironment } = await import("../server/config-file.ts");
  const webConfig = await readTomlEnvironment(PROJECT_ROOT, ".config.toml");
  const workerConfig = await readTomlEnvironment(PROJECT_ROOT, ".worker.toml");
  const webPath = resolve(PROJECT_ROOT, ".config.toml");
  const workerPath = resolve(PROJECT_ROOT, ".worker.toml");
  const webDb = resolve(
    PROJECT_ROOT,
    webConfig.PUMPTV_DB_PATH || ".data/pumptv.sqlite",
  );
  const workerDb = resolve(
    PROJECT_ROOT,
    workerConfig.PUMPTV_DB_PATH || ".data/pumptv.sqlite",
  );
  const webRoom = webConfig.PUMPTV_ROOM || "main";
  const workerRoom = workerConfig.PUMPTV_ROOM || "main";
  const issues: string[] = [];
  if (!existsSync(webPath)) issues.push("Missing .config.toml");
  if (!existsSync(workerPath)) issues.push("Missing .worker.toml");
  if (webDb !== workerDb)
    issues.push(`web DB ${webDb} != worker DB ${workerDb}`);
  if (webRoom !== workerRoom)
    issues.push(`web room ${webRoom} != worker room ${workerRoom}`);
  if (!webConfig.PUMPTV_TOKEN_MINT)
    issues.push("token_mint missing from .config.toml");
  if (!webConfig.PUMPTV_ADMIN_TOKEN)
    issues.push("admin_token missing from .config.toml");
  if (!webConfig.PUMPTV_MODERATION_SECRET)
    issues.push("moderation_secret missing from .config.toml");
  if (!workerConfig.FAL_KEY) issues.push("FAL key missing from .worker.toml");
  console.log("[doctor] target local config files");
  console.log(
    `[doctor] web ${existsSync(webPath) ? "ok" : "MISSING"} · worker ${existsSync(workerPath) ? "ok" : "MISSING"}`,
  );
  console.log(`[doctor] room ${webRoom} · db ${webDb}`);
  console.log(
    `[doctor] token mint ${webConfig.PUMPTV_TOKEN_MINT || "MISSING"}`,
  );
  console.log(
    `[doctor] worker FAL ${workerConfig.FAL_KEY ? "ok" : "MISSING"} · Exa ${workerConfig.EXA_API_KEY ? "ok" : "off"} · model ${workerConfig.JSX_AI_MODEL || "default"}`,
  );
  console.log(
    `[doctor] moderation ${webConfig.PUMPTV_MODERATION_SECRET ? "ok" : "MISSING SECRET"} · proxy headers ${webConfig.PUMPTV_TRUST_PROXY_HEADERS === "1" ? "trusted" : "direct only"}`,
  );
  if (ADMIN_URL)
    console.log(
      `[doctor] configured remote ${ADMIN_URL} (pass without --local to inspect running production)`,
    );
  if (issues.length) {
    console.log("[doctor] issues:");
    for (const issue of issues) console.log(`  - ${issue}`);
    process.exitCode = 2;
  } else {
    console.log("[doctor] config files OK");
  }
} else if (command === "status") {
  console.log(statusLines(await repo.getStreamState()).join("\n"));
} else if (command === "watch") {
  console.log("[control] watching canonical program state; Ctrl+C to stop\n");
  let previous = "";
  while (true) {
    const state = await repo.getStreamState();
    const signature = stateSignature(state);
    if (signature !== previous) {
      previous = signature;
      console.log(
        `[${new Date().toLocaleTimeString()}]\n${statusLines(state).join("\n")}\n`,
      );
    }
    await sleep(400);
  }
} else if (command === "json") {
  console.log(JSON.stringify(await repo.getStreamState(), null, 2));
} else if (command === "board") {
  const round = await repo.getOpenPromptRound();
  if (!round?.proposals.length) console.log("[control] no active proposals");
  else
    for (const proposal of round.proposals)
      console.log(`#${proposal.id}  ${proposal.voteCount}  ${proposal.text}`);
} else if (command === "bans") {
  const moderation = await import("../server/moderation.ts");
  const rows = moderation.listBans();
  if (!rows.length) console.log("[control] no moderation bans");
  for (const ban of rows)
    console.log(
      `#${ban.id}  ${ban.active ? "ACTIVE" : "off"}  ${ban.hash}  ${ban.reason || ""}`.trim(),
    );
} else if (command === "remove") {
  const moderation = await import("../server/moderation.ts");
  const result = moderation.removeProposalById(proposalArg(args));
  console.log(`[control] removed #${result.proposalId} → ${result.text}`);
} else if (command === "ban") {
  const moderation = await import("../server/moderation.ts");
  const proposalId = proposalArg(args);
  const result = moderation.banProposalIp(proposalId, reasonArg(args));
  console.log(
    `[control] banned origin of #${proposalId} · ban #${result.banId} · removed ${result.removedProposals} proposal(s), ${result.removedVotes} vote(s)`,
  );
} else if (command === "ban-ip") {
  const moderation = await import("../server/moderation.ts");
  const ip = args.find((value) => !value.startsWith("--"));
  if (!ip) throw new Error("ban-ip requires an IP address");
  const result = moderation.banIp(ip, reasonArg(args));
  console.log(
    `[control] banned ${result.ip} · ban #${result.banId} · removed ${result.removedProposals} proposal(s), ${result.removedVotes} vote(s)`,
  );
} else if (command === "unban") {
  const moderation = await import("../server/moderation.ts");
  const result = moderation.unbanById(positiveArg(args[0], "ban id"));
  console.log(`[control] unbanned #${result.banId}`);
} else if (command === "wallet") {
  const address = args.find((arg) => !arg.startsWith("--")) || "";
  if (!address) {
    usage();
    process.exit(1);
  }
  const { walletVotingPower } = await import("../server/evm-wallet.ts");
  const result = await walletVotingPower(address, {
    fresh: args.includes("--refresh"),
  });
  console.log(JSON.stringify({ walletAddress: address, ...result }, null, 2));
} else if (command === "reward-wallet") {
  const { rewardWalletInfo } = await import("../server/rewards.ts");
  console.log(JSON.stringify(await rewardWalletInfo(), null, 2));
} else if (command === "rewards") {
  const rows = db.raw<any>(
    `SELECT id, roundId, proposalId, walletAddress, chainId, asset,
            targetUsdCents, amountWei, quotedEthUsdMicros, quoteSource,
            status, signature, lastError, claimedAtMs, sentAtMs,
            createdAt, updatedAt
     FROM ideaRewards ORDER BY id DESC LIMIT 50`,
  );
  console.log(JSON.stringify(rows, null, 2));
} else if (command === "prompt" || command === "episode") {
  const jsonOutput = args.includes("--json");
  const target = args.find((arg) => arg !== "--json") || "latest";
  let row: any = null;

  if (target.toLowerCase() === "latest") {
    row =
      db.raw<any>(`SELECT * FROM clips ORDER BY episode DESC LIMIT 1`)[0] ||
      null;
  } else {
    const displayEpisode = Number(target.replace(/^ep/i, ""));
    if (!Number.isInteger(displayEpisode) || displayEpisode < 1) {
      usage();
      process.exit(1);
    }
    row =
      db.raw<any>(
        `SELECT * FROM clips WHERE episode = ? LIMIT 1`,
        displayEpisode - 1,
      )[0] || null;
  }

  if (!row) throw new Error(`Episode ${target} not found`);

  let storedPlan: Record<string, unknown> | null = null;
  try {
    storedPlan = row.showrunnerPlanJson
      ? JSON.parse(String(row.showrunnerPlanJson))
      : null;
  } catch {}

  const references =
    storedPlan && "_references" in storedPlan
      ? (storedPlan._references ?? null)
      : null;
  const factOverlay =
    storedPlan && "_factOverlay" in storedPlan
      ? (storedPlan._factOverlay ?? null)
      : null;
  const factKeyframe =
    storedPlan && "_factKeyframe" in storedPlan
      ? (storedPlan._factKeyframe ?? null)
      : null;
  const showrunnerPlan = storedPlan
    ? Object.fromEntries(
        Object.entries(storedPlan).filter(
          ([key]) =>
            key !== "_references" &&
            key !== "_factOverlay" &&
            key !== "_factKeyframe",
        ),
      )
    : null;

  const artifact = {
    episode: Number(row.episode) + 1,
    clipId: Number(row.id),
    directiveId: row.directiveId == null ? null : Number(row.directiveId),
    proposal: String(row.directive || ""),
    references,
    factOverlay,
    factKeyframe,
    showrunner: {
      model: row.showrunnerModel ?? null,
      inputTokens: row.showrunnerInputTokens ?? null,
      outputTokens: row.showrunnerOutputTokens ?? null,
      ms: row.showrunnerMs ?? null,
      plan: showrunnerPlan,
    },
    h3: {
      prompt: row.h3Prompt ?? null,
      expandedPrompt: row.expandedPrompt ?? null,
      ms: row.h3Ms ?? null,
      inferenceSeconds: row.inferenceSeconds ?? null,
      resolution: row.resolution ?? null,
    },
    generation: {
      mode: row.generationMode ?? null,
      totalMs: row.totalGenerationMs ?? null,
      requestId: row.requestId ?? null,
      videoUrl: row.videoUrl ?? null,
      anchorFrameUrl: row.anchorFrameUrl ?? null,
    },
  };

  if (jsonOutput) console.log(JSON.stringify(artifact, null, 2));
  else printPromptArtifact(artifact);
} else if (command === "resolve") {
  const bypassCache = args.includes("--refresh");
  const forceResearch = args.includes("--force");
  const text = args
    .filter((arg) => arg !== "--refresh" && arg !== "--force")
    .join(" ")
    .trim();
  if (!text) {
    usage();
    process.exit(1);
  }
  await loadTomlEnvironment(PROJECT_ROOT, ".worker.toml", { required: true });
  const { resolveExternalReferences } =
    await import("../server/reference-tools.ts");
  const worldState = await repo.getLatestWorldState();
  const context = await resolveExternalReferences(text, {
    bypassCache,
    forceResearch,
    knownTerms: [
      worldState.location,
      ...worldState.characters.map((character) => character.name),
      ...worldState.props.map((prop) => prop.name),
    ],
  });
  console.log(JSON.stringify(context, null, 2));
} else if (command === "set-votes") {
  const id = Number((args[0] || "").replace(/^#/, ""));
  if (!Number.isInteger(id) || id < 1 || !args[1]) {
    usage();
    process.exit(1);
  }
  const value = args[1].toLowerCase() === "auto" ? null : Number(args[1]);
  if (value !== null && (!Number.isFinite(value) || value < 0))
    throw new Error("count must be >= 0 or auto");
  const round = await repo.setProposalVoteOverride(id, value);
  console.log(
    `[control] #${id} votes=${value == null ? "auto" : Math.floor(value)}`,
  );
  if (round)
    for (const p of round.proposals)
      console.log(`#${p.id} ${p.voteCount} ${p.text}`);
} else if (command === "close" || command === "trigger") {
  const selection = triggerSelectionArgs(command, args);
  const result = await repo.triggerNextProposal({
    ...("proposalId" in selection ? { proposalId: selection.proposalId } : {}),
    ...("text" in selection ? { text: selection.text } : {}),
    actor: "cli",
  });
  console.log(
    `[control] selected #${result.proposal.id} · rank ${result.rank} · score ${result.score} → ${result.proposal.text}`,
  );
} else if (command === "force") {
  const id = Number((args[0] || "").replace(/^#/, ""));
  if (!Number.isInteger(id) || id < 1) {
    usage();
    process.exit(1);
  }
  const directive = await repo.forceProposalAsNext(id);
  if (!directive) throw new Error("No open round with proposals");
  console.log(`[control] forced #${id} → ${directive.text}`);
} else if (command === "clear-turn") {
  const room = await repo.getRoomRow();
  const workerHeartbeatAtMs = Number(room.heartbeatAtMs || 0);
  const workerIsLive =
    workerHeartbeatAtMs > 0 && Date.now() - workerHeartbeatAtMs < 5_000;
  if (workerIsLive) {
    throw new Error(
      "Generation worker is still online. Stop PumpTV first, wait ~6 seconds, then run clear-turn.",
    );
  }
  if (await repo.hasQueuedDirective())
    throw new Error(
      "A generation is still queued. Run clear-queue --local first, then clear-turn --local.",
    );
  const cleared = await repo.discardOpenPromptRound("control");
  const fresh = await repo.ensureOpenPromptRound(await repo.nextEpisode());
  console.log(
    `[control] cleared round ${cleared.roundId ?? "none"}: ${cleared.proposals} idea${cleared.proposals === 1 ? "" : "s"}, ${cleared.votes} vote${cleared.votes === 1 ? "" : "s"}; fresh turn #${fresh.id} → EP ${fresh.targetEpisode + 1}`,
  );
} else if (command === "clear-queue") {
  const room = await repo.getRoomRow();
  const workerHeartbeatAtMs = Number(room.heartbeatAtMs || 0);
  const workerIsLive =
    workerHeartbeatAtMs > 0 && Date.now() - workerHeartbeatAtMs < 5_000;
  if (workerIsLive) {
    throw new Error(
      "Generation worker is still online. Stop PumpTV first, wait ~6 seconds, then run clear-queue.",
    );
  }

  const before = Number(
    (
      db.raw<any>(
        "SELECT COUNT(*) AS count FROM directives WHERE status IN ('queued', 'generating')",
      )[0] || {}
    ).count || 0,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      `UPDATE directives
       SET status = 'used', usedEpisode = NULL, triggered = 0
       WHERE status IN ('queued', 'generating')`,
    );
    db.exec(
      `UPDATE rooms
       SET workerState = 'idle',
           generationStage = 'idle',
           generationStartedAtMs = NULL,
           leaseOwner = NULL,
           leaseUntilMs = 0
       WHERE name = '${(process.env.PUMPTV_ROOM || "main").replaceAll("'", "''")}'`,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }

  await repo.ensureOpenPromptRound(await repo.nextEpisode());
  console.log(
    `[control] discarded ${before} queued/generating prompt${before === 1 ? "" : "s"}; proposal board preserved and retargeted; next generation requires bun run control -- trigger`,
  );
} else if (command === "inject") {
  const text = args.join(" ").trim();
  if (!text) {
    usage();
    process.exit(1);
  }
  const proposal = await repo.operatorInjectProposal(text);
  if (!proposal) throw new Error("Could not inject operator proposal");
  const round = await repo.getPromptRoundForProposal(proposal.id);
  console.log(
    `[control] injected #${proposal.id} → EP ${(round?.targetEpisode ?? 0) + 1} (NOT locked; run \`bun run control -- trigger\` when ready)`,
  );
} else if (command === "inject-force") {
  const text = args.join(" ").trim();
  if (!text) {
    usage();
    process.exit(1);
  }
  const directive = await repo.operatorInjectAndForce(text);
  console.log(`[control] injected + locked → ${directive?.text}`);
} else {
  usage();
  process.exit(1);
}
