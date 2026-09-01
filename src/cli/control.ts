import { fileURLToPath } from "node:url";
import { loadTomlEnvironment } from "../server/config-file.ts";
import type { PromptRound, StreamState } from "../shared/contracts.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
await loadTomlEnvironment(PROJECT_ROOT, ".config.toml");

const repo = await import("../server/repository.ts");
const { db } = await import("../server/db.ts");
const command = process.argv[2] || "status";
const args = process.argv.slice(3);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function usage() {
  console.log(
    `PumpTV control\n\n  bun run control -- status\n  bun run control -- watch\n  bun run control -- json\n  bun run control -- resolve [--refresh] [--force] <prompt...>\n  bun run control -- set-votes <proposalId> <count|auto>\n  bun run control -- trigger\n  bun run control -- force <proposalId>\n  bun run control -- inject <prompt...>\n  bun run control -- inject-force <prompt...>\n  bun run control -- clear-queue\n`,
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
  const directive = await repo.triggerPromptRound();
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
