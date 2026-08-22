import Link from "next/link";
import { notFound } from "next/navigation";
import { AssetNotFoundError } from "@/domain/asset";
import { getAssetLiquidityProfileBySymbol, type AssetLiquidityProfile } from "@/domain/liquidity";

// Data must be fetched fresh on every request — see src/app/page.tsx.
export const dynamic = "force-dynamic";

function formatUsd(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded border border-neutral-800 p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

export default async function AssetPoolsPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;

  let profile: AssetLiquidityProfile | null = null;
  let loadError: string | null = null;

  try {
    profile = await getAssetLiquidityProfileBySymbol(symbol);
  } catch (err) {
    if (err instanceof AssetNotFoundError) {
      notFound();
    }
    loadError =
      err instanceof Error ? err.message : "Unknown error loading the liquidity profile.";
  }

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Back
      </Link>

      {profile && (
        <div className="mt-2">
          <h1 className="text-2xl font-semibold">{profile.asset.symbol}</h1>
          <p className="mt-1 text-sm text-neutral-400">{profile.asset.name}</p>
          <p className="mt-1 font-mono text-xs text-neutral-500">
            {profile.asset.contractAddress}
          </p>
        </div>
      )}

      {loadError ? (
        <div className="mt-6 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          Failed to load the liquidity profile: {loadError}
        </div>
      ) : (
        profile && (
          <>
            <div className="mt-4 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
              Displayed liquidity is provider-reported pool liquidity and does
              not represent executable buy capacity.
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                label="Displayed Liquidity"
                value={formatUsd(profile.displayedLiquidityUsd)}
                sub={
                  !profile.coverage.liquidity.complete
                    ? `${profile.coverage.liquidity.poolsReporting}/${profile.poolCount} pools reporting`
                    : undefined
                }
              />
              <StatCard
                label="USDG Displayed Liquidity"
                value={formatUsd(profile.usdGLiquidityUsd)}
              />
              <StatCard
                label="Observed 24h DEX Volume"
                value={formatUsd(profile.activity.volume24h)}
              />
              <StatCard label="Pool Count" value={formatCount(profile.poolCount)} />
              <StatCard label="DEX Count" value={formatCount(profile.dexCount)} />
              <StatCard
                label="Largest Pool"
                value={profile.largestPool ? profile.largestPool.dexId : "—"}
                sub={profile.largestPool ? shortAddress(profile.largestPool.pairAddress) : undefined}
              />
              <StatCard
                label="Largest Pool Share"
                value={
                  profile.largestPool
                    ? formatPct(profile.largestPool.shareOfDisplayedLiquidityPct)
                    : "—"
                }
              />
              <StatCard label="Top 3 Concentration" value={formatPct(profile.concentration.top3Pct)} />
              <StatCard label="Top 5 Concentration" value={formatPct(profile.concentration.top5Pct)} />
              <StatCard
                label="24h Buys / Sells"
                value={`${formatCount(profile.activity.buys24h)} / ${formatCount(profile.activity.sells24h)}`}
              />
            </div>

            <div className="mt-8 grid gap-8 lg:grid-cols-2">
              <div>
                <h2 className="text-sm font-medium text-neutral-300">
                  Quote-Asset Composition
                </h2>
                <table className="mt-2 w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 text-left text-neutral-400">
                      <th className="py-2 pr-4 font-medium">Asset</th>
                      <th className="py-2 pr-4 font-medium">Liquidity (USD)</th>
                      <th className="py-2 pr-4 font-medium">Share</th>
                      <th className="py-2 pr-4 font-medium">Pools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.quoteAssets.map((q) => (
                      <tr key={q.address} className="border-b border-neutral-900">
                        <td className="py-2 pr-4 font-mono">
                          {q.symbol}
                          {q.symbolConflict && (
                            <span
                              className="ml-1 text-amber-400"
                              title="Pools disagree on this address's symbol"
                            >
                              ⚠
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4">{formatUsd(q.displayedLiquidityUsd)}</td>
                        <td className="py-2 pr-4">{formatPct(q.shareOfDisplayedLiquidityPct)}</td>
                        <td className="py-2 pr-4">{q.poolCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h2 className="text-sm font-medium text-neutral-300">DEX Composition</h2>
                <table className="mt-2 w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 text-left text-neutral-400">
                      <th className="py-2 pr-4 font-medium">DEX</th>
                      <th className="py-2 pr-4 font-medium">Liquidity (USD)</th>
                      <th className="py-2 pr-4 font-medium">Share</th>
                      <th className="py-2 pr-4 font-medium">Pools</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.dexes.map((d) => (
                      <tr key={d.dexId} className="border-b border-neutral-900">
                        <td className="py-2 pr-4">{d.dexId}</td>
                        <td className="py-2 pr-4">{formatUsd(d.displayedLiquidityUsd)}</td>
                        <td className="py-2 pr-4">{formatPct(d.shareOfDisplayedLiquidityPct)}</td>
                        <td className="py-2 pr-4">{d.poolCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-8 overflow-x-auto">
              <h2 className="text-sm font-medium text-neutral-300">Pools</h2>
              <table className="mt-2 w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-800 text-left text-neutral-400">
                    <th className="py-2 pr-4 font-medium">DEX</th>
                    <th className="py-2 pr-4 font-medium">Pair</th>
                    <th className="py-2 pr-4 font-medium">Pair Address</th>
                    <th className="py-2 pr-4 font-medium">Base Token</th>
                    <th className="py-2 pr-4 font-medium">Quote Token</th>
                    <th className="py-2 pr-4 font-medium">Liquidity (USD)</th>
                    <th className="py-2 pr-4 font-medium">24h Volume</th>
                    <th className="py-2 pr-4 font-medium">24h Buys</th>
                    <th className="py-2 pr-4 font-medium">24h Sells</th>
                    <th className="py-2 pr-4 font-medium">Link</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.pools.map((pool) => (
                    <tr
                      key={`${pool.chainId}:${pool.pairAddress}`}
                      className="border-b border-neutral-900"
                    >
                      <td className="py-2 pr-4">{pool.dexId}</td>
                      <td className="py-2 pr-4 font-mono">
                        {pool.baseToken.symbol}/{pool.quoteToken.symbol}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-neutral-400">
                        {pool.pairAddress}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{pool.baseToken.symbol}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{pool.quoteToken.symbol}</td>
                      <td className="py-2 pr-4">{formatUsd(pool.liquidityUsd)}</td>
                      <td className="py-2 pr-4">{formatUsd(pool.volume24h)}</td>
                      <td className="py-2 pr-4">{formatCount(pool.buys24h)}</td>
                      <td className="py-2 pr-4">{formatCount(pool.sells24h)}</td>
                      <td className="py-2 pr-4">
                        {pool.dexScreenerUrl ? (
                          <a
                            href={pool.dexScreenerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-400 hover:underline"
                          >
                            View
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-4 text-xs text-neutral-500">
                {profile.poolCount} validated pool{profile.poolCount === 1 ? "" : "s"} for{" "}
                {profile.asset.symbol} on Robinhood Chain.
              </p>
            </div>
          </>
        )
      )}
    </main>
  );
}
