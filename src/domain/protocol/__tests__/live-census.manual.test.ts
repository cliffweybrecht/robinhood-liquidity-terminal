import { describe, expect, it } from "vitest";
import { getRobinhoodAssets } from "@/domain/asset";
import { getDexScreenerPoolsForAsset } from "@/domain/pool";
import type { LiquidityPool } from "@/domain/pool";
import { createLimiter } from "@/lib/concurrency/limiter";
import { classifyPoolProtocol } from "../classify";
import type { PoolProtocolClassification } from "../types";

/**
 * Manual live census for Phase 6B. Skipped by default — like every
 * other manual test in this project, normal `npm test` never touches
 * the network. Run on demand only:
 *
 *   RUN_LIVE_CENSUS=1 npx vitest run src/domain/protocol/__tests__/live-census.manual.test.ts
 *
 * This is evidence gathering, not application runtime behavior: it
 * loads the Phase 1 canonical registry, discovers each asset's pools
 * via Phase 2 (unmodified), classifies every pool with the pure Phase
 * 6B classifier (unmodified, no network calls of its own), and prints
 * an aggregate report. It does not persist results into the repository
 * as canonical facts — live protocol distribution across ~194 assets'
 * pools can change at any time, so the report is console output only,
 * and no assertion in this file depends on any specific live count.
 *
 * Uses the same bounded-concurrency/interval-spaced Dexscreener access
 * pattern as Phase 4's `buildMarketLiquiditySnapshot`
 * (`src/domain/market/snapshot.ts`) — concurrency 2, 1000ms spacing —
 * since this walks every canonical asset the same way that does. That
 * snapshot's measured full-registry build time was ~197s (see README
 * "Snapshot build time"); this test's timeout is set well above that.
 */
const RUN_LIVE = process.env.RUN_LIVE_CENSUS === "1";

interface AssetPoolResult {
  readonly symbol: string;
  readonly pools: readonly LiquidityPool[];
}

interface CensusEntry {
  readonly symbol: string;
  readonly labels: readonly string[];
  readonly classification: PoolProtocolClassification;
}

function tally(entries: readonly CensusEntry[], key: (entry: CensusEntry) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const k = key(entry);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function formatTally(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `  ${label}: ${count}`);
}

describe.skipIf(!RUN_LIVE)("Robinhood Chain protocol census (live)", () => {
  it(
    "classifies every currently discovered pool across all canonical assets and reports the aggregate protocol distribution",
    async () => {
      const registry = await getRobinhoodAssets();
      const assets = registry.assets;

      const limiter = createLimiter({ concurrency: 2, intervalMs: 1000 });

      const settled = await Promise.allSettled(
        assets.map((asset) =>
          limiter.schedule(async (): Promise<AssetPoolResult> => {
            const { pools } = await getDexScreenerPoolsForAsset(asset);
            return { symbol: asset.symbol, pools };
          }),
        ),
      );

      const entries: CensusEntry[] = [];
      let assetFailures = 0;
      for (const result of settled) {
        if (result.status === "rejected") {
          assetFailures += 1;
          continue;
        }
        for (const pool of result.value.pools) {
          entries.push({ symbol: result.value.symbol, labels: pool.labels, classification: classifyPoolProtocol(pool) });
        }
      }

      const byFamily = tally(entries, (e) => e.classification.family);
      const byStatus = tally(entries, (e) => e.classification.status);
      const byDexId = tally(entries, (e) => e.classification.pool.dexId);
      const byShape = tally(entries, (e) => e.classification.identifierShape);
      const byLabelCount = tally(entries, (e) => String(e.labels.length));

      const conflicts = entries.filter((e) => e.classification.status === "CONFLICT");
      const unknowns = entries.filter((e) => e.classification.status === "UNKNOWN");
      const provisional = entries.filter((e) => e.classification.status === "PROVISIONAL");
      // The hardening pass's mixed-evidence rule only matters for pools
      // carrying more than one label — surfaced explicitly here since
      // that's exactly the population the rule targets.
      const multiLabelPools = entries.filter((e) => e.labels.length > 1);

      const representative = new Map<string, CensusEntry>();
      for (const entry of entries) {
        const key = `${entry.classification.family}:${entry.classification.status}`;
        if (!representative.has(key)) representative.set(key, entry);
      }

      const lines: string[] = [];
      lines.push("=== Robinhood Chain Protocol Census (live, Phase 6B) ===");
      lines.push("Classification = discovery-metadata evidence only. NOT on-chain verification.");
      lines.push(`assets processed: ${assets.length} (asset-level failures: ${assetFailures})`);
      lines.push(`TOTAL POOLS: ${entries.length}`);

      lines.push("\nBY PROTOCOL:", ...formatTally(byFamily));
      lines.push("\nBY STATUS:", ...formatTally(byStatus));
      lines.push("\nBY DEX ID:", ...formatTally(byDexId));
      lines.push("\nBY IDENTIFIER SHAPE:", ...formatTally(byShape));
      lines.push("\nBY LABEL COUNT (0/1/2+ labels on the raw pool):", ...formatTally(byLabelCount));

      lines.push(`\nCONFLICTS (${conflicts.length}):`);
      for (const entry of conflicts) {
        const c = entry.classification;
        lines.push(
          `  ${entry.symbol} ${c.pool.chainId}/${c.pool.pairAddress} dexId="${c.pool.dexId}" shape=${c.identifierShape} labels=[${entry.labels.join(", ")}] evidence=[${c.evidence.map((e) => e.kind).join(", ")}]`,
        );
      }

      lines.push(`\nPROVISIONAL (${provisional.length}) — includes the hardening pass's mixed matched/unsupported-label case:`);
      for (const entry of provisional.slice(0, 50)) {
        const c = entry.classification;
        lines.push(`  ${entry.symbol} dexId="${c.pool.dexId}" shape=${c.identifierShape} labels=[${entry.labels.join(", ")}]`);
      }
      if (provisional.length > 50) lines.push(`  ...and ${provisional.length - 50} more`);

      lines.push(`\nMULTI-LABEL POOLS (${multiLabelPools.length} pools with >1 label — the population the mixed-evidence rule targets):`);
      for (const entry of multiLabelPools) {
        const c = entry.classification;
        lines.push(
          `  ${entry.symbol} dexId="${c.pool.dexId}" labels=[${entry.labels.join(", ")}] -> ${c.family}/${c.status}`,
        );
      }

      lines.push(`\nUNKNOWNS (${unknowns.length}):`);
      for (const entry of unknowns.slice(0, 50)) {
        const c = entry.classification;
        lines.push(`  ${entry.symbol} dexId="${c.pool.dexId}" shape=${c.identifierShape} labels=[${entry.labels.join(", ")}]`);
      }
      if (unknowns.length > 50) lines.push(`  ...and ${unknowns.length - 50} more`);

      lines.push("\nREPRESENTATIVE EXAMPLES:");
      for (const [key, entry] of representative) {
        const c = entry.classification;
        lines.push(
          `  [${key}] ${entry.symbol} dexId="${c.pool.dexId}" pairAddress=${c.pool.pairAddress} version=${c.version ?? "null"}`,
        );
      }

      console.log(`\n${lines.join("\n")}\n`);

      // Evidence gathering only — no assertion on any specific live
      // distribution, since it can change between runs. The one
      // invariant this test does enforce: every classification carries
      // at least one piece of typed evidence, never an opaque result.
      expect(entries.every((entry) => entry.classification.evidence.length > 0)).toBe(true);
    },
    300000,
  );
});
