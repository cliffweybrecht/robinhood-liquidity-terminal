import { MarketLeaderboard } from "@/app/_components/MarketLeaderboard";
import { getMarketLiquiditySnapshot } from "@/domain/market";

// The snapshot cache (see src/domain/market/cache.ts) decides freshness
// itself — this page must not be statically baked at build time, or
// every visitor would see one build-time snapshot forever.
export const dynamic = "force-dynamic";

function formatAgo(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remSeconds}s`;
}

export default async function Home() {
  let snapshotResult: Awaited<ReturnType<typeof getMarketLiquiditySnapshot>> | null = null;
  let loadError: string | null = null;

  try {
    snapshotResult = await getMarketLiquiditySnapshot();
  } catch (err) {
    loadError =
      err instanceof Error ? err.message : "Unknown error building the market liquidity snapshot.";
  }

  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Robinhood Chain Liquidity Terminal</h1>
      <p className="mt-1 text-sm text-neutral-400">
        Market-wide displayed DEX liquidity across canonical Robinhood Stock
        Tokens on Robinhood Chain.
      </p>

      <div className="mt-4 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
        Displayed liquidity is provider-reported pool liquidity and does not
        represent executable buy capacity.
      </div>

      {loadError ? (
        <div className="mt-6 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          Failed to build the market liquidity snapshot: {loadError}
        </div>
      ) : (
        snapshotResult && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-neutral-400">
              <span>
                Snapshot generated:{" "}
                <span className="text-neutral-200">
                  {formatAgo(snapshotResult.cache.ageMs)}
                </span>{" "}
                ({new Date(snapshotResult.snapshot.generatedAt).toISOString()} UTC, took{" "}
                {formatDuration(snapshotResult.snapshot.refreshDurationMs)} to build,{" "}
                {snapshotResult.cache.status})
              </span>
              <span>
                Assets:{" "}
                <span className="text-neutral-200">
                  {snapshotResult.snapshot.assetsSucceeded} / {snapshotResult.snapshot.assetsRequested}
                </span>{" "}
                successful
              </span>
            </div>

            {!snapshotResult.snapshot.completeness.complete && (
              <div className="mt-3 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
                <details>
                  <summary className="cursor-pointer">
                    {snapshotResult.snapshot.assetsFailed} asset
                    {snapshotResult.snapshot.assetsFailed === 1 ? "" : "s"} failed to refresh —
                    this snapshot is incomplete.
                  </summary>
                  <ul className="mt-2 space-y-1 font-mono">
                    {snapshotResult.snapshot.failures.map((f) => (
                      <li key={f.contractAddress}>
                        {f.symbol} — {f.category}: {f.message}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}

            <div className="mt-6">
              <MarketLeaderboard rows={snapshotResult.snapshot.rows} />
            </div>
          </>
        )
      )}
    </main>
  );
}
