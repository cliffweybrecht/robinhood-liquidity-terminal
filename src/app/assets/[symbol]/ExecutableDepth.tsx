"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetExecutableDepthDto, DepthThresholdPoolResultDto, ExecutionMatrixGroupDto } from "@/domain/execution-comparison";
import {
  bestVenueText,
  depthCellStatusCopy,
  formatAmountOut,
  formatGasEstimate,
  formatGroupLabel,
  formatImpactPercent,
  isPoolPreconditionFailed,
  monotonicityCautionText,
  poolPreconditionDetail,
  thresholdLabel,
  thresholdOutcomeText,
} from "./executableDepthFormatting";

interface RequestBody {
  readonly tokenOut?: string;
}

interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

/**
 * `"idle"` is this component's OWN state, deliberately absent from
 * `ExecutionMatrix.tsx`'s own `LoadState` — the entire point of this
 * component is to perform ZERO network work until the user explicitly
 * clicks the trigger below. No `useEffect` anywhere in this file fires
 * a fetch on mount.
 */
type LoadState =
  | { readonly phase: "idle" }
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "ready"; readonly data: AssetExecutableDepthDto };

function formatFetchedAt(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function shortTokenLabel(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Executable Depth — sampled, tested execution evidence: for each
 * verified pool in one output group, the largest of a fixed 12-sample
 * ladder that was tested and observed to qualify within each of four
 * fixed price-impact thresholds. Sibling to (never merged into)
 * `ExecutionMatrix.tsx`/`ExecutionComparison.tsx`; reuses their exact
 * AbortController stale-request-protection pattern, but — unlike
 * both — performs NO fetch on mount. The panel renders collapsed/
 * inactive until the user explicitly clicks "Show Executable Depth,"
 * so this feature never becomes a third automatic RPC-heavy workload
 * on page load.
 */
export function ExecutableDepth({ symbol }: { symbol: string }) {
  const [state, setState] = useState<LoadState>({ phase: "idle" });
  const [switchingGroup, setSwitchingGroup] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<RequestBody>({});

  const runDepth = useCallback(
    async (body: RequestBody) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      lastRequestRef.current = body;
      setState({ phase: "loading" });

      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(symbol)}/execution/depth-thresholds`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json = (await res.json()) as { data: AssetExecutableDepthDto } | ApiErrorBody;
        if (!res.ok) {
          const message = "error" in json ? json.error.message : "Failed to load executable depth.";
          setState({ phase: "error", message });
          return;
        }
        const data = (json as { data: AssetExecutableDepthDto }).data;
        setState({ phase: "ready", data });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load executable depth." });
      } finally {
        setSwitchingGroup(null);
      }
    },
    [symbol],
  );

  // NOT a fetch-on-mount effect (no fetch is ever fired here) — this
  // exists ONLY to abort an in-flight request if the component
  // unmounts (e.g. the user navigates away mid-load), mirroring
  // `ExecutionMatrix.tsx`'s own identical cleanup, which that
  // component gets "for free" from its own mount-fetching `useEffect`.
  // Found during the adversarial pre-commit pass: without this, a
  // request started by an explicit click could still resolve and call
  // `setState` after unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function handleShowClick() {
    void runDepth({});
  }

  function handleGroupClick(group: ExecutionMatrixGroupDto) {
    if (state.phase === "ready" && group.tokenOut === state.data.selectedTokenOut) return;
    setSwitchingGroup(group.tokenOut);
    void runDepth({ tokenOut: group.tokenOut });
  }

  function handleRefresh() {
    void runDepth(lastRequestRef.current);
  }

  return (
    <section className="mt-10" aria-live="polite">
      <h2 className="text-sm font-medium text-neutral-300">Executable Depth</h2>
      <p className="mt-1 text-xs text-neutral-500">
        Sampled execution evidence — the largest of 12 tested trade sizes observed to stay within each of four price-impact
        thresholds. Never continuous or exact depth; never a guarantee about a future trade.
      </p>

      {state.phase === "idle" && (
        <button
          type="button"
          onClick={handleShowClick}
          className="mt-3 rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          Show Executable Depth
        </button>
      )}

      {state.phase === "loading" && (
        <div aria-busy="true" className="mt-3 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
          Sampling executable depth across trade sizes…
        </div>
      )}

      {state.phase === "error" && (
        <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          <p>Failed to load executable depth: {state.message}</p>
          <button
            type="button"
            onClick={handleRefresh}
            className="mt-2 rounded border border-red-700 px-3 py-1 text-xs text-red-200 hover:bg-red-900/40"
          >
            Retry
          </button>
        </div>
      )}

      {state.phase === "ready" && (
        <ReadyPanel
          symbol={symbol}
          data={state.data}
          switchingGroup={switchingGroup}
          onGroupClick={handleGroupClick}
          onRefresh={handleRefresh}
        />
      )}
    </section>
  );
}

function ReadyPanel({
  symbol,
  data,
  switchingGroup,
  onGroupClick,
  onRefresh,
}: {
  symbol: string;
  data: AssetExecutableDepthDto;
  switchingGroup: string | null;
  onGroupClick: (group: ExecutionMatrixGroupDto) => void;
  onRefresh: () => void;
}) {
  const busy = switchingGroup !== null;

  if (data.groups.length === 0) {
    return <div className="mt-3 rounded border border-neutral-800 p-4 text-sm text-neutral-400">No verified pools found for this asset yet.</div>;
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-4">
        <div role="tablist" aria-label="Receive" className="flex gap-1 rounded border border-neutral-800 p-1">
          {data.groups.map((group) => {
            const selected = group.tokenOut === data.selectedTokenOut;
            return (
              <button
                key={group.tokenOut}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onGroupClick(group)}
                disabled={busy}
                className={`rounded px-3 py-1 text-xs ${selected ? "bg-neutral-100 text-neutral-900" : "text-neutral-300 hover:bg-neutral-800"}`}
              >
                Receive {formatGroupLabel(group.tokenOut, group.tokenOutSymbol)}
                <span className="ml-1 text-[10px] opacity-60">({group.candidateCount})</span>
              </button>
            );
          })}
        </div>

        <button type="button" onClick={onRefresh} className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800">
          Refresh
        </button>
      </div>

      <div aria-busy={busy} className={busy ? "opacity-60" : undefined}>
        <DepthBody result={data.result} symbol={symbol} />
      </div>
    </div>
  );
}

function DepthBody({ result, symbol }: { result: AssetExecutableDepthDto["result"]; symbol: string }) {
  if (result.status === "BLOCK_PIN_FAILURE") {
    return <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">Could not pin a block for this request. Try refreshing.</div>;
  }

  const executablePools = result.pools.filter((p) => !isPoolPreconditionFailed(p));
  const preconditionPools = result.pools.filter((p) => isPoolPreconditionFailed(p));

  return (
    <>
      <p className="mt-3 text-xs text-neutral-500">
        Sampled at block {result.blockNumber} · Fetched {formatFetchedAt(result.fetchedAt)} · 12 tested sizes, never interpolated
      </p>

      {result.sharedAnalyticsStatus !== "OK" && (
        <p className="mt-2 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">
          Price-impact could not be computed for this request — a required on-chain read did not complete or could not be decoded at this block. Try
          Refresh.
        </p>
      )}

      <div className="mt-3 rounded border border-neutral-800 p-3">
        <h3 className="text-xs font-medium text-neutral-400">Best sampled venue</h3>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {result.thresholdsBps.map((bps) => {
            const best = result.bestVenueByThreshold.find((b) => b.thresholdBps === bps);
            return (
              <div key={bps}>
                <dt className="text-[10px] uppercase text-neutral-500">{thresholdLabel(bps)}</dt>
                <dd className="text-xs text-neutral-300">{bestVenueText(best?.poolAddresses ?? [])}</dd>
              </div>
            );
          })}
        </dl>
      </div>

      {executablePools.length === 0 ? (
        <div className="mt-3 rounded border border-neutral-800 p-4 text-sm text-neutral-400">No pools could be attempted for this output group.</div>
      ) : (
        <div className="mt-3 space-y-3">
          {executablePools.map((pool) => (
            <PoolCard key={pool.pairAddress} pool={pool} symbol={symbol} tokenInDecimals={result.tokenInDecimals} blockNumber={result.blockNumber} />
          ))}
        </div>
      )}

      {preconditionPools.length > 0 && (
        <details className="mt-4 rounded border border-neutral-800 p-3 text-sm text-neutral-400">
          <summary className="cursor-pointer text-xs text-neutral-400">
            {preconditionPools.length} verified pool{preconditionPools.length === 1 ? "" : "s"} excluded — view details
          </summary>
          <ul className="mt-2 space-y-2">
            {preconditionPools.map((pool) => (
              <li key={pool.pairAddress} className="text-xs">
                <span className="font-mono text-neutral-500">{shortTokenLabel(pool.pairAddress)}</span>{" "}
                <span className="text-neutral-400">{poolPreconditionDetail(pool) ?? "Unsupported precondition."}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function PoolCard({
  pool,
  symbol,
  tokenInDecimals,
  blockNumber,
}: {
  pool: DepthThresholdPoolResultDto;
  symbol: string;
  tokenInDecimals: number | undefined;
  blockNumber: string;
}) {
  return (
    <div className="rounded border border-neutral-800 p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs text-neutral-400">{shortTokenLabel(pool.pairAddress)}</span>
        <span className="text-xs text-neutral-500">{pool.family === "UNISWAP_V3" ? "V3" : "V4"}</span>
      </div>

      <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {pool.outcomesByThreshold.map((outcome) => {
          const caution = monotonicityCautionText(outcome);
          return (
            <div key={outcome.thresholdBps} className="text-xs">
              <dt className="text-[10px] uppercase text-neutral-500">{thresholdLabel(outcome.thresholdBps)} impact</dt>
              <dd className="text-neutral-300">{thresholdOutcomeText(outcome, tokenInDecimals, blockNumber, symbol)}</dd>
              {caution && <dd className="mt-1 text-amber-400">{caution}</dd>}
            </div>
          );
        })}
      </dl>

      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-neutral-500">Show all {pool.ladder.length} tested samples</summary>
        <table className="mt-2 w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-neutral-900 text-left text-neutral-500">
              <th className="py-1 pr-3 font-medium">
                Amount ({symbol})
              </th>
              <th className="py-1 pr-3 font-medium">Status</th>
              <th className="py-1 pr-3 font-medium">Impact</th>
              <th className="py-1 pr-3 font-medium">Gas</th>
            </tr>
          </thead>
          <tbody>
            {pool.ladder.map((cell, i) => (
              <tr key={i} className="border-b border-neutral-950">
                <td className="py-1 pr-3">{formatAmountOut(cell.amountIn, tokenInDecimals)}</td>
                <td className="py-1 pr-3 text-neutral-400">{depthCellStatusCopy(pool, cell)}</td>
                <td className="py-1 pr-3 text-neutral-500">{formatImpactPercent(cell.priceImpactBps)}</td>
                <td className="py-1 pr-3 text-neutral-600">{cell.status === "QUOTED" ? formatGasEstimate(cell.gasEstimate) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
