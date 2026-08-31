import type {
  DirectiveSource,
  PromptProposal,
  PromptRound,
} from "../shared/contracts.ts";
import { db } from "./db.ts";
import { dbMeasure } from "./observability.ts";
import { sanitizeLine } from "./prompt.ts";

const PROMPT_WINDOW_MS = Number(process.env.SLOP_PROMPT_WINDOW_MS || 4_500);
export const GENERATION_LEAD_MS = Number(
  process.env.SLOP_GENERATION_LEAD_MS || 4_500,
);
const MAX_PROPOSALS = Number(process.env.SLOP_MAX_PROPOSALS_PER_ROUND || 40);

function normalizedText(text: string) {
  return sanitizeLine(text, 500).toLocaleLowerCase();
}

function toProposal(row: any): PromptProposal {
  return {
    id: Number(row.id),
    roundId: Number(row.roundId),
    text: row.text,
    status: row.status,
    source: row.source,
    sourceId: row.sourceId ?? null,
    author: row.author ?? null,
    authorAddress: row.authorAddress ?? null,
    sourceRoom: row.sourceRoom ?? null,
    voteCount: Number(row.voteCount || 0),
  };
}

async function proposalRows(roundId: number) {
  return dbMeasure.measureSync("Load prompt proposals", () =>
    db.raw<any>(
      `SELECT p.*, COUNT(v.id) AS voteCount
       FROM proposals p
       LEFT JOIN proposalVotes v ON v.proposalId = p.id
       WHERE p.roundId = ?
       GROUP BY p.id
       ORDER BY voteCount DESC, p.id ASC`,
      roundId,
    ),
  );
}

async function roundWithProposals(row: any): Promise<PromptRound> {
  const rows = (await proposalRows(Number(row.id))) || [];
  return {
    id: Number(row.id),
    targetEpisode: Number(row.targetEpisode),
    status: row.status,
    openedAtMs: Number(row.openedAtMs),
    closesAtMs: Number(row.closesAtMs),
    closedAtMs: row.closedAtMs == null ? null : Number(row.closedAtMs),
    winnerProposalId:
      row.winnerProposalId == null ? null : Number(row.winnerProposalId),
    proposals: rows.map(toProposal),
  };
}

export async function getOpenPromptRound(): Promise<PromptRound | null> {
  const row = await dbMeasure.measureSync("Load open prompt round", () =>
    db.promptRounds
      .select()
      .where({ status: "open" })
      .orderBy("id", "DESC")
      .first(),
  );
  return row ? roundWithProposals(row) : null;
}

export async function getPromptArena(): Promise<PromptRound | null> {
  const open = await getOpenPromptRound();
  if (open) return open;

  const latest = await dbMeasure.measureSync("Load latest prompt round", () =>
    db.promptRounds.select().orderBy("id", "DESC").first(),
  );
  return latest ? roundWithProposals(latest) : null;
}

export async function ensurePromptRound(
  targetEpisode: number,
  bufferUntilMs: number | null,
) {
  const now = Date.now();
  const latestSafeClose = bufferUntilMs
    ? Math.max(now, bufferUntilMs - GENERATION_LEAD_MS)
    : now + PROMPT_WINDOW_MS;
  const closesAtMs = Math.max(
    now,
    Math.min(now + PROMPT_WINDOW_MS, latestSafeClose),
  );

  const existing = await getOpenPromptRound();
  if (existing && existing.targetEpisode > targetEpisode) {
    // A stale ingress request must never regress the room to an older ballot.
    return existing;
  }

  if (existing?.targetEpisode === targetEpisode) {
    if (closesAtMs < existing.closesAtMs) {
      await dbMeasure.measureSync("Tighten prompt deadline", () =>
        db.promptRounds
          .select()
          .where({ id: existing.id })
          .updateAll({ closesAtMs }),
      );
      return { ...existing, closesAtMs };
    }
    return existing;
  }

  if (existing) {
    const closedAtMs = Date.now();
    await dbMeasure.measureSync("Close stale prompt round", () =>
      db.promptRounds
        .select()
        .where({ id: existing.id })
        .updateAll({ status: "closed", closedAtMs }),
    );
    await dbMeasure.measureSync("Expire stale proposals", () =>
      db.proposals
        .select()
        .where({ roundId: existing.id, status: "open" })
        .updateAll({ status: "lost" }),
    );
  }

  try {
    const row = await dbMeasure.measureSync.assert("Open prompt round", () =>
      db.promptRounds.insert({
        targetEpisode,
        openedAtMs: now,
        closesAtMs,
        status: "open",
      }),
    );
    if (!row) throw new Error("Could not create prompt round");
    return roundWithProposals(row);
  } catch {
    const raced = await getOpenPromptRound();
    if (raced?.targetEpisode === targetEpisode) return raced;
    throw new Error("Could not establish prompt round");
  }
}

export async function castProposalVote(input: {
  roundId: number;
  proposalId: number;
  voterKey: string;
  source: DirectiveSource;
  sourceId?: string | null;
}) {
  const voterKey = sanitizeLine(input.voterKey, 180);
  if (!voterKey) throw new Error("Missing voter identity");

  const round = await dbMeasure.measureSync("Load vote round", () =>
    db.promptRounds.select().where({ id: input.roundId }).first(),
  );
  if (!round || (round as any).status !== "open")
    throw new Error("Voting round is closed");
  if (Date.now() >= Number((round as any).closesAtMs))
    throw new Error("Voting window has closed");

  const proposal = await dbMeasure.measureSync("Load vote proposal", () =>
    db.proposals
      .select()
      .where({ id: input.proposalId, roundId: input.roundId })
      .first(),
  );
  if (!proposal || (proposal as any).status !== "open")
    throw new Error("Proposal is not votable");

  const existing = await dbMeasure.measureSync(
    "Load existing proposal vote",
    () =>
      db.proposalVotes
        .select()
        .where({ roundId: input.roundId, voterKey })
        .orderBy("id", "ASC")
        .first(),
  );

  if (existing) {
    await dbMeasure.measureSync.assert("Move proposal vote", () =>
      db.proposalVotes
        .select()
        .where({ id: (existing as any).id })
        .updateAll({
          proposalId: input.proposalId,
          source: input.source,
          sourceId: input.sourceId ?? null,
        }),
    );
  } else {
    try {
      await dbMeasure.measureSync.assert("Cast proposal vote", () =>
        db.proposalVotes.insert({
          roundId: input.roundId,
          proposalId: input.proposalId,
          voterKey,
          source: input.source,
          sourceId: input.sourceId ?? null,
        }),
      );
    } catch {
      // A second request from the same voter may have raced this insert.
      const raced = await dbMeasure.measureSync(
        "Reload raced proposal vote",
        () =>
          db.proposalVotes
            .select()
            .where({ roundId: input.roundId, voterKey })
            .first(),
      );
      if (!raced) throw new Error("Could not cast vote");
      await dbMeasure.measureSync.assert("Move raced proposal vote", () =>
        db.proposalVotes
          .select()
          .where({ id: (raced as any).id })
          .updateAll({
            proposalId: input.proposalId,
            source: input.source,
            sourceId: input.sourceId ?? null,
          }),
      );
    }
  }

  return getPromptArena();
}

export async function submitPromptProposal(input: {
  roundId: number;
  text: string;
  source: DirectiveSource;
  sourceId?: string | null;
  author?: string | null;
  authorAddress?: string | null;
  sourceRoom?: string | null;
  voterKey: string;
}) {
  const text = sanitizeLine(input.text, 500);
  if (!text) throw new Error("Proposal cannot be empty");

  const round = await dbMeasure.measureSync("Load proposal round", () =>
    db.promptRounds.select().where({ id: input.roundId }).first(),
  );
  if (!round || (round as any).status !== "open")
    throw new Error("Prompt round is closed");
  if (Date.now() >= Number((round as any).closesAtMs))
    throw new Error("Prompt window has closed");

  let proposal = await dbMeasure.measureSync("Find merged proposal", () =>
    db.proposals
      .select()
      .where({ roundId: input.roundId, normalizedText: normalizedText(text) })
      .orderBy("id", "ASC")
      .first(),
  );

  if (!proposal) {
    const count = await dbMeasure.measureSync("Count round proposals", () =>
      db.proposals.select().where({ roundId: input.roundId }).count(),
    );
    if (Number(count || 0) >= MAX_PROPOSALS)
      throw new Error("This prompt round is full");

    try {
      proposal = await dbMeasure.measureSync.assert(
        "Create prompt proposal",
        () =>
          db.proposals.insert({
            roundId: input.roundId,
            text,
            normalizedText: normalizedText(text),
            status: "open",
            source: input.source,
            sourceId: input.sourceId ?? null,
            author: input.author ?? null,
            authorAddress: input.authorAddress ?? null,
            sourceRoom: input.sourceRoom ?? null,
          }),
      );
    } catch {
      proposal = await dbMeasure.measureSync("Reload merged proposal", () =>
        db.proposals
          .select()
          .where({
            roundId: input.roundId,
            normalizedText: normalizedText(text),
          })
          .orderBy("id", "ASC")
          .first(),
      );
    }
  }

  if (!proposal) throw new Error("Could not create proposal");
  await castProposalVote({
    roundId: input.roundId,
    proposalId: Number((proposal as any).id),
    voterKey: input.voterKey,
    source: input.source,
    sourceId: input.sourceId ?? null,
  });

  return getPromptArena();
}

export async function commitPromptRound(targetEpisode: number) {
  const committed = dbMeasure.measureSync.assert(
    "Commit prompt round winner",
    () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const round = db.raw<any>(
          `SELECT * FROM promptRounds
         WHERE status = 'open' AND targetEpisode = ?
         ORDER BY id DESC LIMIT 1`,
          targetEpisode,
        )[0];

        if (!round) {
          db.exec("COMMIT");
          return { winner: null };
        }

        const winner = db.raw<any>(
          `SELECT p.*, COUNT(v.id) AS voteCount
         FROM proposals p
         LEFT JOIN proposalVotes v ON v.proposalId = p.id
         WHERE p.roundId = ? AND p.status = 'open'
         GROUP BY p.id
         ORDER BY voteCount DESC, p.id ASC
         LIMIT 1`,
          round.id,
        )[0];

        const closedAtMs = Date.now();
        db.exec(
          `UPDATE promptRounds
         SET status = 'closed', closedAtMs = ?, winnerProposalId = ?
         WHERE id = ?`,
          closedAtMs,
          winner?.id ?? null,
          round.id,
        );

        db.exec(
          `UPDATE proposals SET status = 'lost' WHERE roundId = ? AND status = 'open'`,
          round.id,
        );

        if (!winner) {
          db.exec("COMMIT");
          return { winner: null };
        }

        db.exec(
          `UPDATE proposals SET status = 'selected' WHERE id = ?`,
          winner.id,
        );
        const directive = db.directives.insert({
          text: winner.text,
          source: winner.source,
          sourceId: `round:${round.id}:winner:${winner.id}`,
          author: winner.author ?? null,
          authorAddress: winner.authorAddress ?? null,
          sourceRoom: winner.sourceRoom ?? null,
          proposalId: Number(winner.id),
        });
        if (!directive) throw new Error("Could not persist winning directive");

        db.exec("COMMIT");
        return {
          winner: {
            roundId: Number(round.id),
            proposalId: Number(winner.id),
            directiveId: Number((directive as any).id),
            text: winner.text as string,
            voteCount: Number(winner.voteCount || 0),
          },
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  );

  return committed.winner;
}
