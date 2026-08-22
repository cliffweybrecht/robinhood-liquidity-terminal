export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-semibold">Robinhood Chain Liquidity Terminal</h1>
      <div className="mt-6 flex items-center gap-3 text-sm text-neutral-400">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-700 border-t-neutral-300" />
        Building market liquidity snapshot — this can take a few minutes on a
        cold cache, since requests to Dexscreener are deliberately
        rate-limited (see README).
      </div>
    </main>
  );
}
