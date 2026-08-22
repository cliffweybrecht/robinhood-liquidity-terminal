import Link from "next/link";
import { notFound } from "next/navigation";
import { AssetNotFoundError, type CanonicalRobinhoodAsset } from "@/domain/asset";
import { getDexScreenerPoolsBySymbol, type LiquidityPool } from "@/domain/pool";

// Pool data must be fetched fresh on every request — see src/app/page.tsx.
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

export default async function AssetPoolsPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;

  let asset: CanonicalRobinhoodAsset | null = null;
  let pools: readonly LiquidityPool[] = [];
  let loadError: string | null = null;

  try {
    const result = await getDexScreenerPoolsBySymbol(symbol);
    asset = result.asset;
    pools = result.pools;
  } catch (err) {
    if (err instanceof AssetNotFoundError) {
      notFound();
    }
    loadError =
      err instanceof Error ? err.message : "Unknown error loading pools.";
  }

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link href="/" className="text-sm text-neutral-400 hover:text-neutral-200">
        ← Back
      </Link>

      {asset && (
        <div className="mt-2">
          <h1 className="text-2xl font-semibold">{asset.symbol}</h1>
          <p className="mt-1 text-sm text-neutral-400">{asset.name}</p>
          <p className="mt-1 font-mono text-xs text-neutral-500">
            {asset.contractAddress}
          </p>
        </div>
      )}

      {loadError ? (
        <div className="mt-6 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          Failed to load Dexscreener pools: {loadError}
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
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
              {pools.map((pool) => (
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
                  <td className="py-2 pr-4 font-mono text-xs">
                    {pool.baseToken.symbol}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {pool.quoteToken.symbol}
                  </td>
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
            {pools.length} validated pool{pools.length === 1 ? "" : "s"} for{" "}
            {symbol.toUpperCase()} on Robinhood Chain. Liquidity shown is
            displayed liquidity as reported by Dexscreener — not executable
            liquidity.
          </p>
        </div>
      )}
    </main>
  );
}
