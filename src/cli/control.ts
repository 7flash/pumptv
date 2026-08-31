import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptRound, StreamState } from "../shared/contracts.ts";

function flattenConfig(section: string, values: Record<string, unknown>) {
  const prefix = section.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  for (const [key, value] of Object.entries(values)) {
    if (value == null || typeof value === "object") continue;
    process.env[`${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`] =
      String(value);
  }
}

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const configPath = resolve(PROJECT_ROOT, ".config.toml");
if (existsSync(configPath)) {
  const parsed = Bun.TOML.parse(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >;
  for (const [section, value] of Object.entries(parsed)) {
    if (value && typeof value === "object" && !Array.isArray(value))
      flattenConfig(section, value as Record<string, unknown>);
  }
}

const repo = await import("../server/repository.ts");
const command = process.argv[2] || "status";
const args = process.argv.slice(3);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function usage() {
  console.log(
    `PumpTV control\n\n  bun run control -- status\n  bun run control -- watch\n  bun run control -- json\n  bun run control -- set-votes <proposalId> <count|auto>\n  bun run control -- trigger\n  bun run control -- force <proposalId>\n  bun run control -- inject <prompt...>\n`,
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
      `${p.status === "selected" ? ">" : " "} #${p.id}  ${p.voteCount}${p.operatorVoteOverride == null ? "" : "*"}  @${p.author || p.authorAddress || "anon"}  ${p.text}`,
    );
  }
  return lines;
}

function statusLines(state: StreamState, now = Date.now()) {
  const p = state.program;
  const lines = [
    `program: ${p.phase.toUpperCase()} · live EP ${p.liveEpisode == null ? "—" : p.liveEpisode + 1} · target EP ${p.targetEpisode + 1}`,
    `worker: ${state.room.workerOnline ? "online" : "offline"} · ${state.room.workerProcess.state}${state.room.workerProcess.pid ? ` pid ${state.room.workerProcess.pid}` : ""} · pump.fun ${state.room.pumpfun.state}`,
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

if (command === "status") {
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
  const directive = await repo.closePromptRound();
  if (!directive) throw new Error("No open round with proposals");
  console.log(`[control] locked → ${directive.text}`);
} else if (command === "force") {
  const id = Number((args[0] || "").replace(/^#/, ""));
  if (!Number.isInteger(id) || id < 1) {
    usage();
    process.exit(1);
  }
  const directive = await repo.forceProposalAsNext(id);
  if (!directive) throw new Error("No open round with proposals");
  console.log(`[control] forced #${id} → ${directive.text}`);
} else if (command === "inject") {
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
