/**
 * Stable cohort used only for arbitration uniqueness.
 *
 * Wallet identity wins over network identity so two connected users behind the
 * same NAT can contest each other. Anonymous sessions on the same trusted IP
 * collapse into one cohort, preventing incognito/tab spam from manufacturing a
 * fake second participant.
 */
export function participationCohortKey(input: {
  originIpHash: string | null;
  walletAddress: string | null;
  subjectKey: string;
}) {
  if (input.walletAddress) return `wallet:${input.walletAddress}`;
  if (input.originIpHash) return `ip:${input.originIpHash}`;
  return input.subjectKey;
}
