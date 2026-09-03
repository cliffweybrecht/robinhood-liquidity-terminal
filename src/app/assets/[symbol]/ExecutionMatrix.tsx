"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetExecutionMatrixDto, ExecutionMatrixGroupDto, MatrixResultSnapshotDto, MatrixRowDto } from "@/domain/execution-comparison";
import { MAX_MATRIX_AMOUNTS } from "@/domain/pool-quote";
import { parseTokenAmount } from "@/lib/decimal/parseTokenAmount";
import {
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
  isRowPreconditionFailed,
  matrixCellStatusCopy,
  rowPreconditionDetail,
  sharedAnalyticsUnavailableNote,
  winnerTransitionIndices,
  winnerTransitionText,
} from "./executionMatrixFormatting";

interface RequestBody {
  readonly tokenOut?: string;
  readonly amountsIn?: string[];
}

interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "error"; readonly message: string }
  | { readonly phase: "ready"; readonly data: AssetExecutionMatrixDto };

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

/** Trade-size execution intelligence — a same-block matrix of every verified pool in one output group x a ladder of sampled trade sizes. Sibling to (never merged into) `ExecutionComparison.tsx`; reuses its AbortController stale-request-protection pattern exactly, against its own separate fetch lifecycle. */
export function ExecutionMatrix({ symbol }: { symbol: string }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [customLadderText, setCustomLadderText] = useState("");
  const [ladderError, setLadderError] = useState<string | null>(null);
  const [tokenInDecimals, setTokenInDecimals] = useState<number | undefined>(undefined);
  const [switchingGroup, setSwitchingGroup] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<RequestBody>({});

  const runMatrix = useCallback(
    async (body: RequestBody) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      lastRequestRef.current = body;

      try {
        const res = await fetch(`/api/assets/${encodeURIComponent(symbol)}/execution/compare-matrix`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json = (await res.json()) as { data: AssetExecutionMatrixDto } | ApiErrorBody;
        if (!res.ok) {
          const message = "error" in json ? json.error.message : "Failed to load the execution matrix.";
          setState({ phase: "error", message });
          return;
        }
        const data = (json as { data: AssetExecutionMatrixDto }).data;
        setState({ phase: "ready", data });
        if (data.matrix.status === "OK" && data.matrix.tokenInDecimals !== undefined) {
          setTokenInDecimals(data.matrix.tokenInDecimals);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to load the execution matrix." });
      } finally {
        setSwitchingGroup(null);
      }
    },
    [symbol],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runMatrix({});
    return () => abortRef.current?.abort();
  }, [runMatrix]);

  function handleGroupClick(group: ExecutionMatrixGroupDto) {
    if (state.phase === "ready" && group.tokenOut === state.data.selectedTokenOut) return;
    setSwitchingGroup(group.tokenOut);
    void runMatrix({ tokenOut: group.tokenOut, amountsIn: lastRequestRef.current.amountsIn });
  }

  function handleLadderSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = customLadderText.trim();
    if (trimmed.length === 0) {
      // Empty field -> omit amountsIn entirely -> server default ladder.
      setLadderError(null);
      const currentTokenOut = state.phase === "ready" ? state.data.selectedTokenOut : undefined;
      void runMatrix({ tokenOut: currentTokenOut });
      return;
    }
    if (tokenInDecimals === undefined) return;
    const entries = trimmed.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (entries.length > MAX_MATRIX_AMOUNTS) {
      setLadderError(`Enter at most ${MAX_MATRIX_AMOUNTS} sizes.`);
      return;
    }
    for (const entry of entries) {
      const parsed = parseTokenAmount(entry, tokenInDecimals);
      if (!parsed.ok) {
        setLadderError(`"${entry}": ${amountParseErrorMessage(parsed.reason)}`);
        return;
      }
    }
    setLadderError(null);
    const currentTokenOut = state.phase === "ready" ? state.data.selectedTokenOut : undefined;
    void runMatrix({ tokenOut: currentTokenOut, amountsIn: entries });
  }

  function handleRefresh() {
    void runMatrix(lastRequestRef.current);
  }

  return (
    <section className="mt-10" aria-live="polite">
      <h2 className="text-sm font-medium text-neutral-300">Trade-Size Execution Intelligence</h2>

      {state.phase === "loading" && (
        <div aria-busy="true" className="mt-3 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
          Comparing execution across trade sizes…
        </div>
      )}

      {state.phase === "error" && (
        <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
          <p>Failed to load the execution matrix: {state.message}</p>
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
          customLadderText={customLadderText}
          ladderError={ladderError}
          switchingGroup={switchingGroup}
          onCustomLadderTextChange={(v) => {
            setCustomLadderText(v);
            setLadderError(null);
          }}
          onLadderSubmit={handleLadderSubmit}
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
      return "enter an amount.";
    case "MALFORMED":
      return "enter a plain positive number, e.g. 1 or 1.5.";
    case "NOT_POSITIVE":
      return "must be greater than zero.";
    case "EXCESS_PRECISION":
      return "too many decimal places for this token.";
  }
}

function ReadyPanel({
  symbol,
  data,
  customLadderText,
  ladderError,
  switchingGroup,
  onCustomLadderTextChange,
  onLadderSubmit,
  onGroupClick,
  onRefresh,
}: {
  symbol: string;
  data: AssetExecutionMatrixDto;
  customLadderText: string;
  ladderError: string | null;
  switchingGroup: string | null;
  onCustomLadderTextChange: (v: string) => void;
  onLadderSubmit: (e: React.FormEvent) => void;
  onGroupClick: (group: ExecutionMatrixGroupDto) => void;
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

        <form onSubmit={onLadderSubmit} className="flex items-center gap-2">
          <label htmlFor="execution-matrix-ladder" className="text-xs text-neutral-400">
            Custom sizes {amountInLabel(symbol).replace("Amount in ", "")} — comma-separated, optional
          </label>
          <input
            id="execution-matrix-ladder"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 1, 10, 100"
            value={customLadderText}
            onChange={(e) => onCustomLadderTextChange(e.target.value)}
            className="w-40 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Apply
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

      {ladderError && <p className="mt-2 text-xs text-red-400">{ladderError}</p>}

      <div aria-busy={busy} className={busy ? "opacity-60" : undefined}>
        <MatrixBody matrix={data.matrix} symbol={symbol} />
      </div>
    </div>
  );
}

function MatrixBody({ matrix, symbol }: { matrix: AssetExecutionMatrixDto["matrix"]; symbol: string }) {
  if (matrix.status === "BLOCK_PIN_FAILURE") {
    return (
      <div className="mt-3 rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
        Could not pin a block for this matrix. Try refreshing.
      </div>
    );
  }

  const analyticsNote = sharedAnalyticsUnavailableNote(matrix.sharedAnalyticsStatus);
  const transitions = winnerTransitionIndices(matrix.rankingsByAmount);
  const executableRows = matrix.rows.filter((r) => !isRowPreconditionFailed(r));
  const preconditionRows = matrix.rows.filter((r) => isRowPreconditionFailed(r));

  return (
    <>
      <p className="mt-3 text-xs text-neutral-500">
        Comparison at block {matrix.blockNumber} · Fetched {formatFetchedAt(matrix.fetchedAt)} · sampled sizes only, never interpolated
      </p>

      {analyticsNote && <p className="mt-2 rounded border border-amber-800 bg-amber-950/30 p-3 text-xs text-amber-300">{analyticsNote}</p>}

      {transitions.length > 0 && (
        <div className="mt-2 rounded border border-sky-800 bg-sky-950/20 p-3 text-xs text-sky-300">
          {transitions.map((i) => (
            <p key={i}>{winnerTransitionText(matrix.amountsIn, matrix.tokenInDecimals, i, symbol)}</p>
          ))}
        </div>
      )}

      {executableRows.length === 0 ? (
        <div className="mt-2 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
          No pools could be attempted for this output group at any sampled size.
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-neutral-400">
                <th className="py-2 pr-4 font-medium">Pool</th>
                <th className="py-2 pr-4 font-medium">Protocol</th>
                {matrix.amountsIn.map((amountIn, i) => (
                  <th key={i} className="py-2 pr-4 font-medium" title={formatAmountOutFull(amountIn, matrix.tokenInDecimals)}>
                    {formatAmountOut(amountIn, matrix.tokenInDecimals)} {symbol}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {executableRows.map((row) => (
                <MatrixRow key={row.pairAddress} row={row} amountsIn={matrix.amountsIn} rankingsByAmount={matrix.rankingsByAmount} tokenOutDecimals={matrix.tokenOutDecimals} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preconditionRows.length > 0 && (
        <details className="mt-4 rounded border border-neutral-800 p-3 text-sm text-neutral-400">
          <summary className="cursor-pointer text-xs text-neutral-400">
            {preconditionRows.length} verified pool{preconditionRows.length === 1 ? "" : "s"} excluded from this matrix — view details
          </summary>
          <ul className="mt-2 space-y-2">
            {preconditionRows.map((row) => (
              <li key={row.pairAddress} className="text-xs">
                <span className="font-mono text-neutral-500">{shortTokenLabel(row.pairAddress)}</span>{" "}
                <span className="text-neutral-400">{rowPreconditionDetail(row) ?? "Unsupported precondition."}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function MatrixRow({
  row,
  amountsIn,
  rankingsByAmount,
  tokenOutDecimals,
}: {
  row: MatrixRowDto;
  amountsIn: readonly string[];
  rankingsByAmount: MatrixResultSnapshotDto["rankingsByAmount"];
  tokenOutDecimals: number | undefined;
}) {
  return (
    <tr className="border-b border-neutral-900">
      <td className="py-2 pr-4 font-mono text-xs text-neutral-400">{shortTokenLabel(row.pairAddress)}</td>
      <td className="py-2 pr-4">{row.family === "UNISWAP_V3" ? "V3" : "V4"}</td>
      {amountsIn.map((amountIn, i) => {
        const cell = row.cells[i];
        if (!cell) return <td key={i} className="py-2 pr-4">—</td>;
        const ranking = rankingsByAmount[i];
        const best = ranking ? isBestCandidate(row.pairAddress, ranking.bestCandidatePoolAddresses) : false;
        return (
          <td key={i} className="py-2 pr-4 align-top">
            {best && ranking && (
              <div className="mb-1">
                <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  {bestExecutionLabel(ranking.bestCandidatePoolAddresses)}
                </span>
              </div>
            )}
            <div className="text-neutral-300">{matrixCellStatusCopy(row, cell)}</div>
            <div title={formatAmountOutFull(cell.amountOut, tokenOutDecimals)}>{formatAmountOut(cell.amountOut, tokenOutDecimals)}</div>
            <div className="text-[11px] text-neutral-500" title={formatExecutionPriceFull(cell.executionPrice)}>
              {formatExecutionPrice(cell.executionPrice)} · {formatImpactPercent(cell.priceImpactBps)}
            </div>
            <div className="text-[11px] text-neutral-600">{cell.status === "QUOTED" ? formatGasEstimate(cell.gasEstimate) : "—"}</div>
          </td>
        );
      })}
    </tr>
  );
}
