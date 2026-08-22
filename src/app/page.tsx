import Link from "next/link";
import { getRobinhoodAssets, ROBINHOOD_CHAIN_ID } from "@/domain/asset";
import type { CanonicalRobinhoodAsset } from "@/domain/asset";

// The registry must be fetched fresh on every request, not baked into a
// static build — a liquidity terminal serving a build-time snapshot of
// market data indefinitely would be silently wrong.
export const dynamic = "force-dynamic";

export default async function Home() {
  let assets: readonly CanonicalRobinhoodAsset[] = [];
  let loadError: string | null = null;

  try {
    const registry = await getRobinhoodAssets();
    assets = registry.assets;
  } catch (err) {
    loadError =
      err instanceof Error
        ? err.message
        : "Unknown error loading the Robinhood asset registry.";
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">
        Robinhood Chain Liquidity Terminal
      </h1>
      <p className="mt-1 text-sm text-neutral-400">
        Phase 1 — Canonical Robinhood Stock Token registry (chain ID{" "}
        {ROBINHOOD_CHAIN_ID}). Liquidity, pricing, and volume data are not
        yet implemented.
      </p>

      {loadError ? (
        <div className="mt-6 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          Failed to load the canonical asset registry: {loadError}
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-neutral-400">
                <th className="py-2 pr-4 font-medium">Symbol</th>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Contract Address</th>
                <th className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr
                  key={asset.contractAddress}
                  className="border-b border-neutral-900"
                >
                  <td className="py-2 pr-4 font-mono">
                    <Link
                      href={`/assets/${asset.symbol}`}
                      className="text-blue-400 hover:underline"
                    >
                      {asset.symbol}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{asset.name}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-neutral-400">
                    {asset.contractAddress}
                  </td>
                  <td className="py-2 pr-4">{asset.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-xs text-neutral-500">
            {assets.length} canonical assets on Robinhood Chain (chain ID{" "}
            {ROBINHOOD_CHAIN_ID}).
          </p>
        </div>
      )}
    </main>
  );
}
