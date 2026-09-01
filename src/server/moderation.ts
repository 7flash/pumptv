import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { Database, z } from "sqlite-zod-orm";
import { db } from "./db.ts";
import { resolveProjectPath } from "./project-paths.ts";
import { moderationMeasure } from "./observability.ts";

export class ModerationBlockedError extends Error {}

const moderationDbPath = resolveProjectPath(
  process.env.PUMPTV_MODERATION_DB_PATH || ".data/pumptv-moderation.sqlite",
);

mkdirSync(dirname(moderationDbPath), { recursive: true });

const moderationDb = moderationMeasure.measureSync(
  {
    start: () => "Open moderation database",
    end: () => ({ path: moderationDbPath }),
  },
  () =>
    new Database(
      moderationDbPath,
      {
        origins: z.object({
          subjectKey: z.string(),
          ipHash: z.string(),
        }),
        bans: z.object({
          kind: z.enum(["ip"]).default("ip"),
          valueHash: z.string(),
          reason: z.string().nullable().default(null),
          active: z.boolean().default(true),
        }),
      },
      { timestamps: true },
    ),
);

if (!moderationDb) throw new Error("Could not open moderation database");
moderationDb.exec("PRAGMA busy_timeout = 15000");

function proxyHeadersEnabled() {
  return process.env.PUMPTV_TRUST_PROXY_HEADERS === "1";
}

function moderationSecret() {
  return (
    process.env.PUMPTV_MODERATION_SECRET ||
    process.env.PUMPTV_ADMIN_TOKEN ||
    ""
  ).trim();
}

export function normalizeIp(value: unknown): string | null {
  let ip = String(value || "").trim();
  if (!ip) return null;
  if (ip.includes(",")) ip = ip.split(",", 1)[0].trim();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (isIP(ip)) return ip.toLowerCase();
  const ipv4WithPort = ip.match(/^((?:\d{1,3}\.){3}\d{1,3}):\d+$/);
  if (ipv4WithPort && isIP(ipv4WithPort[1])) return ipv4WithPort[1];
  return null;
}

export function requestIp(request: Request): string | null {
  if (!proxyHeadersEnabled()) return null;
  return (
    normalizeIp(request.headers.get("cf-connecting-ip")) ||
    normalizeIp(request.headers.get("x-real-ip")) ||
    normalizeIp(request.headers.get("x-forwarded-for"))
  );
}

export function hashIp(ip: string): string {
  const secret = moderationSecret();
  if (!secret)
    throw new Error(
      "PUMPTV_MODERATION_SECRET (or PUMPTV_ADMIN_TOKEN fallback) is required for IP moderation",
    );
  const normalized = normalizeIp(ip);
  if (!normalized) throw new Error("Invalid IP address");
  return createHmac("sha256", secret)
    .update(`pumptv-ip-v1:${normalized}`)
    .digest("hex");
}

export function requestIpHash(request: Request): string | null {
  const ip = requestIp(request);
  return ip ? hashIp(ip) : null;
}

function activeBanForHash(ipHash: string) {
  return (
    moderationDb.raw<any>(
      `SELECT * FROM bans
     WHERE kind = 'ip' AND valueHash = ? AND active = 1
     ORDER BY id DESC LIMIT 1`,
      ipHash,
    )[0] || null
  );
}

export function assertRequestAllowed(request: Request) {
  const originIpHash = requestIpHash(request);
  if (originIpHash && activeBanForHash(originIpHash))
    throw new ModerationBlockedError(
      "This network is blocked from participating.",
    );
  return { originIpHash };
}

export function recordSubjectOrigin(
  subjectKey: string,
  originIpHash: string | null,
) {
  const key = String(subjectKey || "")
    .trim()
    .slice(0, 240);
  if (!key || !originIpHash) return false;
  return moderationMeasure.measureSync(
    {
      start: () => "Remember participant origin",
      end: () => ({ recorded: true }),
    },
    () => {
      const existing =
        moderationDb.raw<any>(
          `SELECT id FROM origins WHERE subjectKey = ? ORDER BY id DESC LIMIT 1`,
          key,
        )[0] || null;
      if (existing)
        moderationDb.exec(
          `UPDATE origins SET ipHash = ? WHERE id = ?`,
          originIpHash,
          existing.id,
        );
      else
        moderationDb.origins.insert({ subjectKey: key, ipHash: originIpHash });
      return true;
    },
  );
}

function subjectKeysForHash(ipHash: string) {
  return moderationDb
    .raw<any>(
      `SELECT subjectKey FROM origins WHERE ipHash = ? ORDER BY id ASC`,
      ipHash,
    )
    .map((row) => String(row.subjectKey));
}

function removeActiveContributions(subjectKeys: string[]) {
  const keys = [...new Set(subjectKeys.filter(Boolean))];
  if (!keys.length) return { removedProposals: 0, removedVotes: 0 };
  const placeholders = keys.map(() => "?").join(",");
  const owned = db.raw<any>(
    `SELECT id FROM proposals
     WHERE status = 'open' AND sourceId IN (${placeholders})`,
    ...keys,
  );
  let removedVotes = Number(
    (
      db.raw<any>(
        `SELECT COUNT(*) AS count FROM proposalVotes WHERE voterKey IN (${placeholders})`,
        ...keys,
      )[0] || {}
    ).count || 0,
  );
  for (const proposal of owned) {
    removedVotes += Number(
      (
        db.raw<any>(
          `SELECT COUNT(*) AS count FROM proposalVotes WHERE proposalId = ?`,
          proposal.id,
        )[0] || {}
      ).count || 0,
    );
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const proposal of owned)
      db.exec(`DELETE FROM proposalVotes WHERE proposalId = ?`, proposal.id);
    db.exec(
      `DELETE FROM proposalVotes WHERE voterKey IN (${placeholders})`,
      ...keys,
    );
    db.exec(
      `DELETE FROM proposals WHERE status = 'open' AND sourceId IN (${placeholders})`,
      ...keys,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
  return { removedProposals: owned.length, removedVotes };
}

function activateIpBan(ipHash: string, reason?: string | null) {
  const existing = activeBanForHash(ipHash);
  if (existing) {
    if (reason && reason !== existing.reason)
      moderationDb.exec(
        `UPDATE bans SET reason = ? WHERE id = ?`,
        reason,
        existing.id,
      );
    return Number(existing.id);
  }
  const row = moderationDb.bans.insert({
    kind: "ip",
    valueHash: ipHash,
    reason: reason || null,
    active: true,
  });
  if (!row) throw new Error("Could not create IP ban");
  return Number((row as any).id);
}

export function removeProposalById(proposalId: number) {
  return moderationMeasure.measureSync(
    {
      start: () => `Remove proposal #${proposalId}`,
      end: (result) => ({ proposalId: result.proposalId }),
    },
    () => {
      const proposal =
        db.raw<any>(
          `SELECT id, text, status FROM proposals WHERE id = ? LIMIT 1`,
          proposalId,
        )[0] || null;
      if (!proposal) throw new Error(`Proposal #${proposalId} not found`);
      if (proposal.status !== "open")
        throw new Error(
          `Proposal #${proposalId} is already ${proposal.status}`,
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`DELETE FROM proposalVotes WHERE proposalId = ?`, proposalId);
        db.exec(`DELETE FROM proposals WHERE id = ?`, proposalId);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      return { proposalId, text: String(proposal.text) };
    },
  );
}

export function banIp(ip: string, reason?: string | null) {
  const normalized = normalizeIp(ip);
  if (!normalized) throw new Error("Invalid IP address");
  const ipHash = hashIp(normalized);
  return moderationMeasure.measureSync(
    {
      start: () => `Ban IP ${normalized}`,
      end: (result) => ({
        banId: result.banId,
        removedProposals: result.removedProposals,
        removedVotes: result.removedVotes,
      }),
    },
    () => {
      const banId = activateIpBan(ipHash, reason);
      const cleaned = removeActiveContributions(subjectKeysForHash(ipHash));
      return { banId, ip: normalized, hash: ipHash.slice(0, 12), ...cleaned };
    },
  );
}

export function banProposalIp(proposalId: number, reason?: string | null) {
  return moderationMeasure.measureSync(
    {
      start: () => `Ban origin of proposal #${proposalId}`,
      end: (result) => ({
        banId: result.banId,
        removedProposals: result.removedProposals,
        removedVotes: result.removedVotes,
      }),
    },
    () => {
      const proposal =
        db.raw<any>(
          `SELECT id, text, sourceId, authorAddress FROM proposals WHERE id = ? LIMIT 1`,
          proposalId,
        )[0] || null;
      if (!proposal) throw new Error(`Proposal #${proposalId} not found`);
      const subjectKeys = [
        String(proposal.sourceId || ""),
        proposal.authorAddress ? `wallet:${proposal.authorAddress}` : "",
      ].filter(Boolean);
      let origin: any = null;
      for (const key of subjectKeys) {
        origin =
          moderationDb.raw<any>(
            `SELECT * FROM origins WHERE subjectKey = ? ORDER BY id DESC LIMIT 1`,
            key,
          )[0] || null;
        if (origin) break;
      }
      if (!origin)
        throw new Error(
          `Proposal #${proposalId} has no recorded IP hash (it predates IP moderation, or trusted proxy headers are disabled).`,
        );
      const ipHash = String(origin.ipHash);
      const banId = activateIpBan(ipHash, reason);
      const cleaned = removeActiveContributions(subjectKeysForHash(ipHash));
      return {
        banId,
        proposalId,
        text: String(proposal.text),
        hash: ipHash.slice(0, 12),
        ...cleaned,
      };
    },
  );
}

export function listBans() {
  return moderationMeasure.measureSync(
    {
      start: () => "List moderation bans",
      end: (rows) => ({
        active: rows.filter((row: any) => row.active).length,
        total: rows.length,
      }),
    },
    () =>
      moderationDb
        .raw<any>(
          `SELECT id, kind, valueHash, reason, active, createdAt, updatedAt
         FROM bans ORDER BY active DESC, id DESC`,
        )
        .map((row) => ({
          id: Number(row.id),
          kind: row.kind,
          hash: String(row.valueHash).slice(0, 12),
          reason: row.reason ?? null,
          active: Boolean(row.active),
          createdAt: row.createdAt ?? null,
          updatedAt: row.updatedAt ?? null,
        })),
  );
}

export function unbanById(banId: number) {
  return moderationMeasure.measureSync(`Unban #${banId}`, () => {
    const row =
      moderationDb.raw<any>(
        `SELECT id FROM bans WHERE id = ? LIMIT 1`,
        banId,
      )[0] || null;
    if (!row) throw new Error(`Ban #${banId} not found`);
    moderationDb.exec(`UPDATE bans SET active = 0 WHERE id = ?`, banId);
    return { banId, active: false };
  });
}
