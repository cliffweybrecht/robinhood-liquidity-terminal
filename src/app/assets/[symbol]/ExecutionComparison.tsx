"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetExecutionComparisonDto, ExecutionGroupDto } from "@/domain/execution-comparison";
import { parseTokenAmount } from "@/lib/decimal/parseTokenAmount";
import {
  PRECONDITION_DETAIL_COPY,
  amountInLabel,
  bestExecutionLabel,
  formatAmountOut,
  formatAmountOutFull,
  formatExecutionPrice,
  formatExecutionPriceFull,
  formatGasEstimate,
  formatGroupLabel,
  formatImpactPercent,
  isBestCandidate,
  orderCandidatesForTable,
  sharedAnalyticsUnavailableNote,
  statusCopy,
} from "./executionFormatting";

interface RequestBody {
  readonly tokenOut?: string;
  readonly amountIn?: string;
}

interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "ready"; readonly data: AssetExecutionComparisonDto };

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

export function ExecutionComparison({ symbol }: { symbol: string }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [amountText, setAmountText] = useState("1");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [tokenInDecimals, setTokenInDecimals] = useState<number | undefined>(undefined);
  const [switchingGroup, setSwitchingGroup] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<RequestBody>({});

  const runComparison = useCallback(
    async (body: RequestBody) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      lastRequestRef.current = body;

      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(symbol)}/execution/compare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json = (await res.json()) as { data: AssetExecutionComparisonDto } | ApiErrorBody;
        if (!res.ok) {
          const message = "error" in json ? json.error.message : "Failed to load the execution comparison.";
          setState({ phase: "error", message });
          return;
        }
        const data = (json as { data: AssetExecutionComparisonDto }).data;
        setState({ phase: "ready", data });
        if (data.comparison.status === "OK" && data.comparison.tokenInDecimals !== undefined) {
          setTokenInDecimals(data.comparison.tokenInDecimals);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load the execution comparison." });
      } finally {
        setSwitchingGroup(null);
      }
    },
    [symbol],
  );

  useEffect(() => {
    // Fetch-on-mount: the canonical React "Fetching data" effect pattern
    // (https://react.dev/learn/synchronizing-with-effects#fetching-data).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runComparison({});
    return () => abortRef.current?.abort();
  }, [runComparison]);

  function handleGroupClick(group: ExecutionGroupDto) {
    if (state.phase === "ready" && group.tokenOut === state.data.selectedTokenOut) return;
    setSwitchingGroup(group.tokenOut);
    void runComparison({ tokenOut: group.tokenOut, amountIn: amountText });
  }

  function handleAmountSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (tokenInDecimals === undefined) return;
    const parsed = parseTokenAmount(amountText, tokenInDecimals);
    if (!parsed.ok) {
      setAmountError(amountParseErrorMessage(parsed.reason));
      return;
    }
    setAmountError(null);
    const currentTokenOut = state.phase === "ready" ? state.data.selectedTokenOut : undefined;
    void runComparison({ tokenOut: currentTokenOut, amountIn: amountText });
  }

  function handleRefresh() {
    void runComparison(lastRequestRef.current);
  }

  return (
    <section className="mt-10" aria-live="polite">
      <h2 className="text-sm font-medium text-neutral-300">Execution Comparison</h2>

      {state.phase === "loading" && (
        <div aria-busy="true" className="mt-3 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
          Verifying pools and comparing execution…
        </div>
      )}

      {state.phase === "error" && (
        <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          <p>Failed to load the execution comparison: {state.message}</p>
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
          amountText={amountText}
          amountError={amountError}
          switchingGroup={switchingGroup}
          onAmountTextChange={(v) => {
            setAmountText(v);
            setAmountError(null);
          }}
          onAmountSubmit={handleAmountSubmit}
          onGroupClick={handleGroupClick}
          onRefresh={handleRefresh}
        />
      )}
    </section>
  );
}

function amountParseErrorMessage(reason: "EMPTY" | "MALFORMED" | "NOT_POSITIVE" | "EXCESS_PRECISION"): string {
  switch (reason) {
    case "EMPTY":
      return "Enter an amount.";
    case "MALFORMED":
      return "Enter a plain positive number, e.g. 1 or 1.5.";
    case "NOT_POSITIVE":
      return "Amount must be greater than zero.";
    case "EXCESS_PRECISION":
      return "Too many decimal places for this token.";
  }
}

function ReadyPanel({
  symbol,
  data,
  amountText,
  amountError,
  switchingGroup,
  onAmountTextChange,
  onAmountSubmit,
  onGroupClick,
  onRefresh,
}: {
  symbol: string;
  data: AssetExecutionComparisonDto;
  amountText: string;
  amountError: string | null;
  switchingGroup: string | null;
  onAmountTextChange: (v: string) => void;
  onAmountSubmit: (e: React.FormEvent) => void;
  onGroupClick: (group: ExecutionGroupDto) => void;
  onRefresh: () => void;
}) {
  const busy = switchingGroup !== null;

  if (data.groups.length === 0) {
    return (
      <div className="mt-3 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
        No verified pools found for this asset yet.
      </div>
    );
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
                className={`rounded px-3 py-1 text-xs ${
                  selected ? "bg-neutral-100 text-neutral-900" : "text-neutral-300 hover:bg-neutral-800"
                }`}
              >
                Receive {formatGroupLabel(group.tokenOut, group.tokenOutSymbol)}
                <span className="ml-1 text-[10px] opacity-60">({group.candidateCount})</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={onAmountSubmit} className="flex items-center gap-2">
          <label htmlFor="execution-amount-in" className="text-xs text-neutral-400">
            {amountInLabel(symbol)}
          </label>
          <input
            id="execution-amount-in"
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(e) => onAmountTextChange(e.target.value)}
            className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Compare
          </button>
        </form>

        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          Refresh
        </button>
      </div>

      {amountError && <p className="mt-2 text-xs text-red-400">{amountError}</p>}

      <div aria-busy={busy} className={busy ? "opacity-60" : undefined}>
        <ComparisonBody comparison={data.comparison} />
      </div>
    </div>
  );
}

function shortTokenLabel(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function ComparisonBody({ comparison }: { comparison: AssetExecutionComparisonDto["comparison"] }) {
  if (comparison.status === "BLOCK_PIN_FAILURE") {
    return (
      <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
        Could not pin a block for this comparison. Try refreshing.
      </div>
    );
  }

  const { attempted, precondition } = orderCandidatesForTable(comparison.candidates, comparison.ranking);
  const analyticsNote = sharedAnalyticsUnavailableNote(comparison.sharedAnalyticsStatus);

  return (
    <>
      <p className="mt-3 text-xs text-neutral-500">
        Comparison at block {comparison.blockNumber} · Fetched {formatFetchedAt(comparison.fetchedAt)}
      </p>

      {analyticsNote && (
        <p className="mt-2 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">{analyticsNote}</p>
      )}

      {attempted.length === 0 ? (
        <div className="mt-2 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
          No pools could be attempted for this output group and amount.
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-neutral-400">
                <th className="py-2 pr-4 font-medium">Best</th>
                <th className="py-2 pr-4 font-medium">Pool</th>
                <th className="py-2 pr-4 font-medium">Protocol</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Amount Out</th>
                <th className="py-2 pr-4 font-medium">Execution Price</th>
                <th className="py-2 pr-4 font-medium">Impact</th>
                <th className="py-2 pr-4 font-medium" title="Gas estimate is not converted to transaction cost and does not affect ranking.">
                  Gas
                </th>
              </tr>
            </thead>
            <tbody>
              {attempted.map((candidate) => {
                const best = isBestCandidate(candidate.pairAddress, comparison.ranking.bestCandidatePoolAddresses);
                return (
                  <tr key={candidate.pairAddress} className="border-b border-neutral-900">
                    <td className="py-2 pr-4">
                      {best ? (
                        <span className="rounded bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-300">
                          {bestExecutionLabel(comparison.ranking.bestCandidatePoolAddresses)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-neutral-400">{shortTokenLabel(candidate.pairAddress)}</td>
                    <td className="py-2 pr-4">{candidate.family === "UNISWAP_V3" ? "V3" : "V4"}</td>
                    <td className="py-2 pr-4">{statusCopy(candidate)}</td>
                    <td className="py-2 pr-4" title={formatAmountOutFull(candidate.amountOut, comparison.tokenOutDecimals)}>
                      {formatAmountOut(candidate.amountOut, comparison.tokenOutDecimals)}
                    </td>
                    <td className="py-2 pr-4" title={formatExecutionPriceFull(candidate.executionPrice)}>
                      {formatExecutionPrice(candidate.executionPrice)}
                    </td>
                    <td className="py-2 pr-4">{formatImpactPercent(candidate.priceImpactBps)}</td>
                    <td className="py-2 pr-4">{candidate.status === "QUOTED" ? formatGasEstimate(candidate.gasEstimate) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {precondition.length > 0 && (
        <details className="mt-4 rounded border border-neutral-800 p-3 text-sm text-neutral-400">
          <summary className="cursor-pointer text-xs text-neutral-400">
            {precondition.length} verified pool{precondition.length === 1 ? "" : "s"} excluded from this comparison — view details
          </summary>
          <ul className="mt-2 space-y-2">
            {precondition.map((candidate) => (
              <li key={candidate.pairAddress} className="text-xs">
                <span className="font-mono text-neutral-500">{shortTokenLabel(candidate.pairAddress)}</span>{" "}
                <span className="text-neutral-400">
                  {candidate.preconditionFailure ? PRECONDITION_DETAIL_COPY[candidate.preconditionFailure.code] : "Unsupported precondition."}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
