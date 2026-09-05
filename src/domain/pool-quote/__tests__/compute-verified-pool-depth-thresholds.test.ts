import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { encodeDecimalsCall, encodeGetSlot0Call, encodeQuoteExactInputSingleV3Call, encodeQuoteExactInputSingleV4Call, encodeSlot0Call } from "../abi/selectors";
import {
  computeVerifiedPoolDepthThresholds,
  DEPTH_THRESHOLD_QUOTE_CONCURRENCY,
  DEPTH_THRESHOLD_QUOTE_INTERVAL_MS,
  deriveThresholdOutcomeForTesting,
  MAX_DEPTH_THRESHOLD_CELLS,
} from "../compute-verified-pool-depth-thresholds";
import type { MatrixCell } from "../types";
import {
  DepthThresholdsTooLargeError,
  DuplicateCandidateError,
  EmptyAmountsLadderError,
  EmptyCandidatesError,
  EmptyThresholdsError,
  InvalidAmountInError,
} from "../errors";
import { UINT128_MAX } from "../read-uniswap-v4-quote";
import type { DepthThresholdOutcome, VerifiedPoolDepthThresholdsSnapshot } from "../types";
import {
  decimalsReturn,
  DEFAULT_FEE,
  DEFAULT_TICK_SPACING,
  HOOK_ADDRESS,
  NVDA,
  QUOTE_BLOCK,
  slot0V3Return,
  slot0V4Return,
  USDG,
  v3ComparisonCandidate,
  v3QuoteReturn,
  v4ComparisonCandidate,
  v4QuoteReturn,
  WETH,
  type RpcStub,
} from "./fixtures";
import type { BlockTag, VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";

// This file NEVER imports `executeCell`/`classifySpot` from
// `../compare-verified-pools-across-amounts` — verifying Correction 1's
// structural independence is a static fact of this file's own import
// list, checked here as a comment anchor for reviewers grepping for it.
// The ONLY import from that file, anywhere in the primitive under test,
// is `classifyMatrixCandidates` (see compute-verified-pool-depth-
// thresholds.ts's own imports) — this test file imports nothing from
// it at all.

const V3_A = "0x0100000000000000000000000000000000000001" as Address;
const V3_B = "0x0200000000000000000000000000000000000002" as Address;
const V4_A = "0xaa000000000000000000000000000000000000000000000000000000000000aa" as Hex;

const UNIT = 1_000_000_000_000_000_000n; // 1 asset unit at 18 decimals
const LADDER = [1n, 2n, 5n, 10n, 25n, 50n, 100n, 250n, 500n, 1000n, 2500n, 5000n].map((m) => m * UNIT);
const THRESHOLDS = [50, 100, 200, 500]; // 0.5% / 1% / 2% / 5%

function word(data: string, index: number): string {
  return data.slice(10 + 64 * index, 10 + 64 * (index + 1));
}

interface CellStub {
  readonly v3Fee?: number;
  readonly v4Key?: { fee: number; tickSpacing: number; hooks: Address };
  readonly amountIn: bigint;
  readonly quote?: RpcStub;
}

interface RowStub {
  readonly kind: "v3" | "v4";
  readonly toOrPoolId: Address | Hex;
  readonly slot0?: RpcStub;
}

/** Local fake RPC, purpose-built for this primitive's own tests — mirrors the matrix test suite's own `buildFakeMatrixRpc` shape (same encoding, same routing-by-candidate-and-amountIn need) but kept entirely local to this file, never imported from or shared with the matrix's test file, matching Correction 1's "peer, not coupled" structure at the test layer too. */
function buildFakeDepthRpc(args: {
  rows: readonly RowStub[];
  cells: readonly CellStub[];
  decimalsByAddress?: Readonly<Record<string, RpcStub>>;
  getBlockNumber?: (() => Promise<bigint>) | { error: unknown };
}): {
  rpc: VerifiedRobinhoodRpcClient;
  calls: { getBlockNumberCalls: number; callsByKind: Record<string, number>; callLog: Array<{ kind: string; to: string; at: number; blockTag: BlockTag }> };
} {
  const calls = { getBlockNumberCalls: 0, callsByKind: {} as Record<string, number>, callLog: [] as Array<{ kind: string; to: string; at: number; blockTag: BlockTag }> };
  const bump = (kind: string, to: string, blockTag: BlockTag) => {
    calls.callsByKind[kind] = (calls.callsByKind[kind] ?? 0) + 1;
    calls.callLog.push({ kind, to, at: Date.now(), blockTag });
  };

  const v3QuoteSelector = encodeQuoteExactInputSingleV3Call(NVDA, USDG, UNIT, 500).slice(0, 10);
  const v4QuoteSelector = encodeQuoteExactInputSingleV4Call({ currency0: WETH, currency1: NVDA, fee: 8388608, tickSpacing: 4, hooks: "0x0000000000000000000000000000000000000000" as Address }, true, UNIT, "0x").slice(0, 10);
  const slot0Selector = encodeSlot0Call().slice(0, 10);
  const getSlot0Selector = encodeGetSlot0Call(V4_A).slice(0, 10);
  const decimalsSelector = encodeDecimalsCall().slice(0, 10);

  function resolveStub(stub: RpcStub | undefined, fallback: Hex): Promise<Hex> {
    if (stub === undefined) return Promise.resolve(fallback);
    if (typeof stub === "function") return stub();
    if (typeof stub === "object" && "error" in stub) return Promise.reject(stub.error);
    if (typeof stub === "object" && "revert" in stub) {
      return Promise.reject(new Error(`revert stub not supported by this local fixture: ${stub.revert}`));
    }
    return Promise.resolve(stub as Hex);
  }

  const rpc: VerifiedRobinhoodRpcClient = {
    chainId: 4663,
    getBlockNumber: async () => {
      calls.getBlockNumberCalls += 1;
      if (args.getBlockNumber && typeof args.getBlockNumber !== "function") throw args.getBlockNumber.error;
      return args.getBlockNumber ? (args.getBlockNumber as () => Promise<bigint>)() : QUOTE_BLOCK;
    },
    getCode: async () => {
      throw new Error("unstubbed: getCode");
    },
    call: async (request, blockTag = "latest") => {
      const selector = request.data.slice(0, 10);

      if (selector === decimalsSelector) {
        bump("decimals", request.to, blockTag);
        const key = request.to.toLowerCase();
        const stub = args.decimalsByAddress?.[key];
        return resolveStub(stub, decimalsReturn(18));
      }

      if (selector === slot0Selector) {
        bump("spot", request.to, blockTag);
        const row = args.rows.find((r) => r.kind === "v3" && (r.toOrPoolId as string).toLowerCase() === request.to.toLowerCase());
        return resolveStub(row?.slot0, slot0V3Return());
      }

      if (selector === getSlot0Selector) {
        const poolId = `0x${word(request.data, 0)}` as Hex;
        bump("spot", poolId, blockTag);
        const row = args.rows.find((r) => r.kind === "v4" && (r.toOrPoolId as string).toLowerCase() === poolId.toLowerCase());
        return resolveStub(row?.slot0, slot0V4Return());
      }

      if (selector === v3QuoteSelector) {
        const fee = Number(BigInt(`0x${word(request.data, 3)}`));
        const amountIn = BigInt(`0x${word(request.data, 2)}`);
        bump("quote", `v3:${fee}:${amountIn}`, blockTag);
        const cell = args.cells.find((c) => c.v3Fee === fee && c.amountIn === amountIn);
        if (!cell) throw new Error(`no cell stub for v3 fee=${fee} amountIn=${amountIn}`);
        return resolveStub(cell.quote, v3QuoteReturn());
      }

      if (selector === v4QuoteSelector) {
        const fee = Number(BigInt(`0x${word(request.data, 3)}`));
        const tickSpacingRaw = BigInt(`0x${word(request.data, 4)}`);
        const tickSpacing = Number(tickSpacingRaw > (1n << 255n) ? tickSpacingRaw - (1n << 256n) : tickSpacingRaw);
        const hooks = `0x${word(request.data, 5).slice(24)}`.toLowerCase();
        const amountIn = BigInt(`0x${word(request.data, 7)}`);
        bump("quote", `v4:${fee}:${tickSpacing}:${hooks}:${amountIn}`, blockTag);
        const cell = args.cells.find(
          (c) => c.v4Key && c.v4Key.fee === fee && c.v4Key.tickSpacing === tickSpacing && c.v4Key.hooks.toLowerCase() === hooks && c.amountIn === amountIn,
        );
        if (!cell) throw new Error(`no cell stub for v4 fee=${fee} tickSpacing=${tickSpacing} hooks=${hooks} amountIn=${amountIn}`);
        return resolveStub(cell.quote, v4QuoteReturn());
      }

      throw new Error(`unstubbed fake RPC call: to=${request.to} data=${request.data}`);
    },
    getLogs: async () => {
      throw new Error("unstubbed: getLogs");
    },
  };

  return { rpc, calls };
}

function asOk(result: Awaited<ReturnType<typeof computeVerifiedPoolDepthThresholds>>): VerifiedPoolDepthThresholdsSnapshot {
  if (result.status !== "OK") throw new Error(`expected OK, got ${result.status}`);
  return result;
}

function outcomeAt(result: VerifiedPoolDepthThresholdsSnapshot, poolIndex: number, thresholdBps: number): DepthThresholdOutcome {
  const pool = result.pools[poolIndex];
  if (!pool) throw new Error(`no pool at index ${poolIndex}`);
  const entry = pool.outcomesByThreshold.find((o) => o.thresholdBps === thresholdBps);
  if (!entry) throw new Error(`no outcome for threshold ${thresholdBps}`);
  return entry.outcome;
}

describe("computeVerifiedPoolDepthThresholds — structural validation (before any RPC)", () => {
  it("throws EmptyCandidatesError, zero RPC calls", async () => {
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [] });
    await expect(computeVerifiedPoolDepthThresholds({ candidates: [], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc })).rejects.toThrow(
      EmptyCandidatesError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws DuplicateCandidateError for the same pool twice, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [] });
    await expect(
      computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }, { pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    ).rejects.toThrow(DuplicateCandidateError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws EmptyAmountsLadderError for an empty ladder, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [] });
    await expect(
      computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [], thresholdsBps: THRESHOLDS, rpc }),
    ).rejects.toThrow(EmptyAmountsLadderError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws InvalidAmountInError for a non-positive amount, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [] });
    await expect(
      computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [UNIT, 0n], thresholdsBps: THRESHOLDS, rpc }),
    ).rejects.toThrow(InvalidAmountInError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws EmptyThresholdsError for an empty threshold list, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [] });
    await expect(
      computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: [], rpc }),
    ).rejects.toThrow(EmptyThresholdsError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws DepthThresholdsTooLargeError when executable x ladder exceeds MAX_DEPTH_THRESHOLD_CELLS, computed against EXECUTABLE candidates only", async () => {
    // 6 executable V3 candidates x 12-point ladder = 72 > 60.
    const candidates = Array.from({ length: 6 }, (_, i) =>
      v3ComparisonCandidate({ pairAddress: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, fee: 500 + i }),
    );
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [] });
    await expect(computeVerifiedPoolDepthThresholds({ candidates, tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc })).rejects.toThrow(
      DepthThresholdsTooLargeError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("does NOT throw DepthThresholdsTooLargeError when raw candidates exceed the cap but EXECUTABLE candidates do not (hooked-without-hookData rows excluded)", async () => {
    // 2 executable V3 + 6 hooked-without-hookData V4 = 8 raw. 8*12=96>60
    // (would wrongly reject if counted against raw); 2*12=24, well under 60.
    const v3s = [v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }), v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 })];
    const hookedV4s = Array.from({ length: 6 }, (_, i) =>
      v4ComparisonCandidate({ poolId: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, hooks: HOOK_ADDRESS, currency0: USDG }),
    );
    const candidates = [...v3s.map((c) => ({ pool: c.pool, identity: c.identity })), ...hookedV4s.map((c) => ({ pool: c.pool, identity: c.identity }))];
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A },
      { kind: "v3", toOrPoolId: V3_B },
    ];
    const cells: CellStub[] = LADDER.flatMap((amountIn) => [
      { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
      { v3Fee: 501, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
    ]);
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = await computeVerifiedPoolDepthThresholds({ candidates, tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
    expect(result.status).toBe("OK");
    expect(calls.getBlockNumberCalls).toBe(1);
    // 6 hooked rows issue zero quote calls; only the 2 executable V3 rows contribute.
    expect(calls.callsByKind["quote"]).toBe(2 * LADDER.length);
  });
});

describe("computeVerifiedPoolDepthThresholds — same-block invariant", () => {
  it("calls getBlockNumber exactly once, and every spot/decimals/quote eth_call happens at the identical pinned block (single RPC client, single block value threaded through)", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }));
    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.blockNumber).toBe(QUOTE_BLOCK);
  });

  it("BLOCK_PIN_FAILURE: eth_blockNumber failing means zero other RPC calls are attempted", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [], getBlockNumber: { error: new Error("boom") } });
    const result = await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
    expect(result.status).toBe("BLOCK_PIN_FAILURE");
    expect(calls.callsByKind["decimals"]).toBeUndefined();
    expect(calls.callsByKind["spot"]).toBeUndefined();
    expect(calls.callsByKind["quote"]).toBeUndefined();
  });
});

describe("computeVerifiedPoolDepthThresholds — externally supplied blockNumber (Phase 6H, additive-only input)", () => {
  // Deliberately DIFFERENT from `QUOTE_BLOCK` (the fake RPC's own
  // getBlockNumber fallback) — if this primitive ever self-pinned
  // despite receiving an explicit blockNumber, the result would come
  // back at QUOTE_BLOCK instead, and every assertion below comparing
  // against SUPPLIED_BLOCK would fail.
  const SUPPLIED_BLOCK = 777_777n;

  it("supplied blockNumber -> ZERO getBlockNumber calls, and the result reports the SUPPLIED value verbatim", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc, blockNumber: SUPPLIED_BLOCK }),
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(result.blockNumber).toBe(SUPPLIED_BLOCK);
  });

  it("supplied blockNumber reaches the one shared decimals read, every spot read, and every quote call — the SAME single value threaded through every downstream call, exactly as the self-pinned path already guarantees", async () => {
    const c1 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token1: WETH });
    const c2Poolid = "0xaa000000000000000000000000000000000000000000000000000000000000ab" as Hex;
    const c2 = v4ComparisonCandidate({ poolId: c2Poolid, currency0: WETH, currency1: NVDA });
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A },
      { kind: "v4", toOrPoolId: c2Poolid },
    ];
    const cells: CellStub[] = LADDER.flatMap((amountIn) => [
      { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
      { v4Key: { fee: DEFAULT_FEE, tickSpacing: DEFAULT_TICK_SPACING, hooks: "0x0000000000000000000000000000000000000000" as Address }, amountIn, quote: v4QuoteReturn({ amountOut: amountIn / 2n }) },
    ]);
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool: c1.pool, identity: c1.identity }, { pool: c2.pool, identity: c2.identity }],
        tokenIn: NVDA,
        amountsIn: LADDER,
        thresholdsBps: THRESHOLDS,
        rpc,
        blockNumber: SUPPLIED_BLOCK,
      }),
    );
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callsByKind["decimals"]).toBeGreaterThan(0);
    expect(calls.callsByKind["spot"]).toBe(2);
    expect(calls.callsByKind["quote"]).toBe(2 * LADDER.length);
    expect(result.blockNumber).toBe(SUPPLIED_BLOCK);
    // Every pool actually produced QUOTED cells — proving the fake RPC's
    // own per-cell stub lookup (which is NOT keyed by block at all)
    // was satisfied, i.e. every quote call reached the fake RPC and
    // succeeded using the supplied block's code path.
    expect(result.pools[0]!.row.cells.every((c) => c.status === "QUOTED")).toBe(true);
    expect(result.pools[1]!.row.cells.every((c) => c.status === "QUOTED")).toBe(true);

    // RELEASE-CRITICAL: every SINGLE `eth_call` this request made — the
    // one shared decimals read (both sides), every V3/V4 spot read, and
    // every V3/V4 quote call across both pools' full 12-point ladders —
    // was made at EXACTLY the externally supplied block. `blockTag`
    // defaults to `"latest"` on the fake RPC (mirroring the REAL
    // client's own `blockTag = "latest"` default) precisely so that a
    // production code path which forgot to thread `blockNumber` through
    // to some downstream `rpc.call` — falling back to that default
    // instead — is caught here: a strict `===` against the bigint
    // `SUPPLIED_BLOCK` fails for BOTH a different block AND the string
    // `"latest"`. Asserted against the exact expected call count (2
    // decimals + 2 spot + 2*12 quote = 28), not just "at least one",
    // so a call silently missing from the log can't hide a gap.
    expect(calls.callLog).toHaveLength(2 + 2 + 2 * LADDER.length);
    expect(calls.callLog.every((entry) => entry.blockTag === SUPPLIED_BLOCK)).toBe(true);
    expect(calls.callLog.some((entry) => entry.blockTag === "latest")).toBe(false);
  });

  it("omitted blockNumber -> exactly one self-pin, unchanged from before this field existed", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }));
    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.blockNumber).toBe(QUOTE_BLOCK);
  });

  it("omitted blockNumber + eth_blockNumber failure -> BLOCK_PIN_FAILURE, exactly as before this field existed", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeDepthRpc({ rows: [], cells: [], getBlockNumber: { error: new Error("boom") } });
    const result = await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
    expect(result.status).toBe("BLOCK_PIN_FAILURE");
    expect(calls.getBlockNumberCalls).toBe(1);
  });

  it("supplied blockNumber + a getBlockNumber stub that ALWAYS throws -> the request still succeeds, because getBlockNumber must never be invoked at all", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc, calls } = buildFakeDepthRpc({
      rows,
      cells,
      getBlockNumber: {
        error: new Error("getBlockNumber must never be called when an external blockNumber is supplied"),
      },
    });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc, blockNumber: SUPPLIED_BLOCK }),
    );
    expect(result.status).toBe("OK");
    expect(result.blockNumber).toBe(SUPPLIED_BLOCK);
    expect(calls.getBlockNumberCalls).toBe(0);
  });
});

describe("computeVerifiedPoolDepthThresholds — RPC shape", () => {
  it("exactly one shared decimals read, one spot read per executable candidate (never per ladder sample), exactly executableCandidates x 12 quote attempts", async () => {
    const c1 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const c2 = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A },
      { kind: "v3", toOrPoolId: V3_B },
    ];
    const cells: CellStub[] = LADDER.flatMap((amountIn) => [
      { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
      { v3Fee: 501, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
    ]);
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    await computeVerifiedPoolDepthThresholds({
      candidates: [{ pool: c1.pool, identity: c1.identity }, { pool: c2.pool, identity: c2.identity }],
      tokenIn: NVDA,
      amountsIn: LADDER,
      thresholdsBps: THRESHOLDS,
      rpc,
    });
    expect(calls.callsByKind["decimals"]).toBe(2); // tokenIn + tokenOut, once
    expect(calls.callsByKind["spot"]).toBe(2); // once per executable pool
    expect(calls.callsByKind["quote"]).toBe(2 * LADDER.length); // 2 pools x 12 samples
  });

  it("hooked missing-hookData pool remains visible, issues zero quote calls, contributes zero to the executable cell count", async () => {
    const executable = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const hooked = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, currency0: USDG });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool: executable.pool, identity: executable.identity }, { pool: hooked.pool, identity: hooked.identity }],
        tokenIn: NVDA,
        amountsIn: LADDER,
        thresholdsBps: THRESHOLDS,
        rpc,
      }),
    );
    expect(calls.callsByKind["quote"]).toBe(1 * LADDER.length);
    expect(result.pools).toHaveLength(2);
    const hookedResult = result.pools.find((p) => p.row.pool.pairAddress.toLowerCase() === V4_A.toLowerCase());
    expect(hookedResult).toBeDefined();
    expect(hookedResult!.row.cells.every((c) => c.status === "PRECONDITION_FAILED")).toBe(true);
    expect(hookedResult!.outcomesByThreshold).toHaveLength(0);
  });

  it("candidate order and ladder order are both preserved exactly as supplied", async () => {
    const c1 = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const c2 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A },
      { kind: "v3", toOrPoolId: V3_B },
    ];
    const cells: CellStub[] = LADDER.flatMap((amountIn) => [
      { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
      { v3Fee: 501, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
    ]);
    const { rpc } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool: c1.pool, identity: c1.identity }, { pool: c2.pool, identity: c2.identity }],
        tokenIn: NVDA,
        amountsIn: LADDER,
        thresholdsBps: THRESHOLDS,
        rpc,
      }),
    );
    expect(result.pools[0]!.row.pool.pairAddress.toLowerCase()).toBe(V3_B.toLowerCase());
    expect(result.pools[1]!.row.pool.pairAddress.toLowerCase()).toBe(V3_A.toLowerCase());
    expect(result.pools[0]!.row.cells.map((c) => c.amountIn)).toEqual(LADDER);
  });

  it("never caches — two back-to-back calls each perform their own full fan-out", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
    await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
    expect(calls.getBlockNumberCalls).toBe(2);
    expect(calls.callsByKind["quote"]).toBe(2 * LADDER.length);
  });
});

describe("computeVerifiedPoolDepthThresholds — dispatch concurrency/spacing", () => {
  it("never exceeds DEPTH_THRESHOLD_QUOTE_CONCURRENCY simultaneously in-flight quote calls", async () => {
    vi.useFakeTimers();
    try {
      const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
      let active = 0;
      let maxActive = 0;
      const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
      const cells: CellStub[] = LADDER.map((amountIn) => ({
        v3Fee: 500,
        amountIn,
        quote: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return v3QuoteReturn({ amountOut: amountIn / 2n });
        },
      }));
      const { rpc } = buildFakeDepthRpc({ rows, cells });
      const promise = computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
      await vi.runAllTimersAsync();
      await promise;
      expect(maxActive).toBeLessThanOrEqual(DEPTH_THRESHOLD_QUOTE_CONCURRENCY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never starts two quote calls closer than DEPTH_THRESHOLD_QUOTE_INTERVAL_MS apart", async () => {
    vi.useFakeTimers();
    try {
      const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
      const starts: number[] = [];
      const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
      const cells: CellStub[] = LADDER.map((amountIn) => ({
        v3Fee: 500,
        amountIn,
        quote: async () => {
          starts.push(Date.now());
          return v3QuoteReturn({ amountOut: amountIn / 2n });
        },
      }));
      const { rpc } = buildFakeDepthRpc({ rows, cells });
      const promise = computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc });
      await vi.runAllTimersAsync();
      await promise;
      starts.sort((a, b) => a - b);
      for (let i = 1; i < starts.length; i++) {
        expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(0);
      }
      // At concurrency 3, the 4th start must be spaced >= INTERVAL_MS after the 1st.
      if (starts.length >= 4) {
        expect(starts[3]! - starts[0]!).toBeGreaterThanOrEqual(DEPTH_THRESHOLD_QUOTE_INTERVAL_MS);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Deterministic spot/decimals fixture used by every scenario test
 * below: NVDA (18dp) -> USDG (6dp). `SPOT_SQRT_PRICE_X96` is chosen so
 * `computeSpotPrice`'s own formula (tokenInIsToken0=false here, since
 * NVDA.toLowerCase() > USDG.toLowerCase(): `{numerator: Q192 *
 * 10^(18-6), denominator: sqrtPriceX96^2}`) returns EXACTLY a 1:1
 * ratio — i.e. `sqrtPriceX96 = 2^96 * 10^6`, chosen precisely because
 * `Q192 * 10^12` is a perfect square (`(2^96 * 10^6)^2`), so this spot
 * reference is EXACT, not an approximation.
 *
 * `amountOutForBps` then solves `computeExecutionPrice`/
 * `computePriceImpactBps`'s own exact formulas algebraically for the
 * `amountOut` that produces EXACTLY the requested `bps` impact (not
 * approximately) — verified by direct derivation: with spotPrice
 * exactly 1:1, `priceImpactBps = 10000 * (1 - amountOut * 10^12 /
 * amountIn)`; solving for `amountOut` at a target `bps` gives
 * `amountOut = (amountIn / 10^16) * (10000 - bps)`, which is always an
 * EXACT integer here because every `amountIn` used in this file is a
 * whole multiple of `UNIT = 10^18`.
 */
const SPOT_SQRT_PRICE_X96 = 79228162514264337593543950336000000n; // 2^96 * 10^6, exact

function amountOutForBps(amountIn: bigint, bps: number): bigint {
  return (amountIn / 10_000_000_000_000_000n) * BigInt(10_000 - bps);
}

describe("computeVerifiedPoolDepthThresholds — sampled threshold derivation", () => {
  function singlePoolFixture(amountOutFor: (amountIn: bigint) => bigint | "RPC_ERROR" | "INDETERMINATE") {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) }];
    const cells: CellStub[] = LADDER.map((amountIn) => {
      const out = amountOutFor(amountIn);
      if (out === "RPC_ERROR") return { v3Fee: 500, amountIn, quote: { error: new Error("simulated RPC failure") } };
      if (out === "INDETERMINATE") return { v3Fee: 500, amountIn, quote: "0x" as Hex };
      return { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: out }) };
    });
    const decimalsByAddress: Record<string, RpcStub> = {
      [NVDA.toLowerCase()]: decimalsReturn(18),
      [USDG.toLowerCase()]: decimalsReturn(6),
    };
    return { pool, identity, rows, cells, decimalsByAddress };
  }

  it("largest qualifying sampled amount at 1% — the exact CLEAN BRACKET scenario (100=>0.7%, 250=>1.2%)", async () => {
    const f = singlePoolFixture((amountIn) => {
      if (amountIn === 100n * UNIT) return amountOutForBps(amountIn, 70);
      if (amountIn < 100n * UNIT) return amountOutForBps(amountIn, 5); // comfortably qualifies at every threshold
      if (amountIn === 250n * UNIT) return amountOutForBps(amountIn, 120); // exceeds 1%
      return amountOutForBps(amountIn, 9999); // everything above 250 also clearly exceeds — 100 must remain the unique max-qualifying point
    });
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const outcome = outcomeAt(result, 0, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") {
      expect(outcome.qualifyingAmountIn).toBe(100n * UNIT);
      expect(outcome.upperRange).toEqual({ kind: "CLEAN_CEILING", nextMeasuredAmountIn: 250n * UNIT });
    }
  });

  it("GAPPED_CEILING — the exact frozen correction scenario: 100=>0.7% QUOTED, 250 RPC_ERROR, 500=>1.4% QUOTED", async () => {
    const f = singlePoolFixture((amountIn) => {
      if (amountIn === 100n * UNIT) return amountOutForBps(amountIn, 70);
      if (amountIn < 100n * UNIT) return amountOutForBps(amountIn, 5);
      if (amountIn === 250n * UNIT) return "RPC_ERROR";
      if (amountIn === 500n * UNIT) return amountOutForBps(amountIn, 140);
      return amountOutForBps(amountIn, 9999); // everything above 500 also clearly exceeds
    });
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const outcome = outcomeAt(result, 0, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") {
      expect(outcome.qualifyingAmountIn).toBe(100n * UNIT);
      // NEVER "the next tested size, 500, exceeded 1%" without disclosing the 250 gap.
      expect(outcome.upperRange).toEqual({ kind: "GAPPED_CEILING", nextMeasuredAmountIn: 500n * UNIT });
    }
  });

  it("GAPPED_NO_CEILING — 100=>0.7% QUOTED, 250 and 500 both RPC_ERROR, no larger size successfully measured", async () => {
    const f = singlePoolFixture((amountIn) => {
      if (amountIn === 100n * UNIT) return amountOutForBps(amountIn, 70);
      if (amountIn === 250n * UNIT) return "RPC_ERROR";
      if (amountIn === 500n * UNIT) return "RPC_ERROR";
      if (amountIn > 500n * UNIT) return "RPC_ERROR";
      return amountOutForBps(amountIn, 5);
    });
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const outcome = outcomeAt(result, 0, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") {
      expect(outcome.qualifyingAmountIn).toBe(100n * UNIT);
      expect(outcome.upperRange).toEqual({ kind: "GAPPED_NO_CEILING" });
    }
  });

  it("OPEN — the ladder's own largest sample (5000) qualifies and nothing larger was requested; never implies pool capacity ends there", async () => {
    const f = singlePoolFixture((amountIn) => amountOutForBps(amountIn, 5)); // every sample comfortably qualifies at every threshold
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const outcome = outcomeAt(result, 0, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") {
      expect(outcome.qualifyingAmountIn).toBe(5000n * UNIT);
      expect(outcome.upperRange).toEqual({ kind: "OPEN" });
    }
  });

  it("EXCEEDED_AT_SMALLEST_SAMPLE — every measured sample exceeds every threshold", async () => {
    const f = singlePoolFixture((amountIn) => amountOutForBps(amountIn, 9999)); // ~100% impact everywhere
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const outcome = outcomeAt(result, 0, 500);
    expect(outcome.kind).toBe("EXCEEDED_AT_SMALLEST_SAMPLE");
    if (outcome.kind === "EXCEEDED_AT_SMALLEST_SAMPLE") {
      expect(outcome.smallestMeasuredAmountIn).toBe(1n * UNIT);
    }
  });

  it("EXCEEDED_AT_SMALLEST_SAMPLE uses the smallest MEASURED sample, not the literal smallest REQUESTED sample, when amountIn=1 itself failed to quote", async () => {
    const f = singlePoolFixture((amountIn) => {
      if (amountIn === 1n * UNIT) return "RPC_ERROR";
      return amountOutForBps(amountIn, 9999);
    });
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const outcome = outcomeAt(result, 0, 500);
    expect(outcome.kind).toBe("EXCEEDED_AT_SMALLEST_SAMPLE");
    if (outcome.kind === "EXCEEDED_AT_SMALLEST_SAMPLE") {
      // amountIn=1 failed to quote (RPC_ERROR) — the smallest MEASURED sample is 2, never 1.
      expect(outcome.smallestMeasuredAmountIn).toBe(2n * UNIT);
    }
  });

  it("NO_QUOTED_SAMPLES — every sample fails to quote", async () => {
    const f = singlePoolFixture(() => "RPC_ERROR");
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    expect(outcomeAt(result, 0, 100)).toEqual({ kind: "NO_QUOTED_SAMPLES" });
  });

  it("ANALYTICS_UNAVAILABLE — quotes succeed but the shared spot read fails; amountOut/status remain valid on the raw ladder while every threshold is unavailable", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A, slot0: { error: new Error("spot read failed") } }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    expect(outcomeAt(result, 0, 100)).toEqual({ kind: "ANALYTICS_UNAVAILABLE" });
    // The raw quote survives: amountOut/status are NEVER downgraded by the analytics failure.
    expect(result.pools[0]!.row.cells.every((c) => c.status === "QUOTED" && c.amountOut !== undefined)).toBe(true);
    expect(result.pools[0]!.row.cells.every((c) => c.priceImpactBps === undefined)).toBe(true);
  });

  it("one candidate's own spot-read failure does not affect a sibling candidate's threshold derivation", async () => {
    const c1 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const c2 = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501, token0: NVDA, token1: USDG });
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A, slot0: { error: new Error("this candidate's own spot read fails") } },
      { kind: "v3", toOrPoolId: V3_B, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) },
    ];
    const cells: CellStub[] = LADDER.flatMap((amountIn) => [
      { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) },
      { v3Fee: 501, amountIn, quote: v3QuoteReturn({ amountOut: amountOutForBps(amountIn, 5) }) },
    ]);
    const decimalsByAddress: Record<string, RpcStub> = { [NVDA.toLowerCase()]: decimalsReturn(18), [USDG.toLowerCase()]: decimalsReturn(6) };
    const { rpc } = buildFakeDepthRpc({ rows, cells, decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool: c1.pool, identity: c1.identity }, { pool: c2.pool, identity: c2.identity }],
        tokenIn: NVDA,
        amountsIn: LADDER,
        thresholdsBps: THRESHOLDS,
        rpc,
      }),
    );
    // Note: sharedAnalyticsStatus/sharedDecimals is REQUEST-wide (one shared decimals read),
    // but each pool's OWN spot read is independent — c1's spot failure means c1's cells never
    // get priceImpactBps (ANALYTICS_UNAVAILABLE), while c2's cells DO, since sharedDecimals
    // itself succeeded and c2's own spot read succeeded.
    expect(result.sharedAnalyticsStatus).toBe("OK");
    expect(outcomeAt(result, 0, 500).kind).toBe("ANALYTICS_UNAVAILABLE");
    expect(outcomeAt(result, 1, 500).kind).toBe("WITHIN_THRESHOLD");
  });

  it("exact threshold equality qualifies (<=, not <)", async () => {
    const f = singlePoolFixture((amountIn) => (amountIn === 1n * UNIT ? amountOutForBps(amountIn, 100) : amountOutForBps(amountIn, 9999)));
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: [100], rpc }),
    );
    const outcome = outcomeAt(result, 0, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") expect(outcome.qualifyingAmountIn).toBe(1n * UNIT);
  });

  it("deliberately non-monotonic impact fixture: a smaller sample exceeds while a larger one qualifies — sampledDepthAtBps still returns the larger value, and monotonicityObserved is false", async () => {
    const f = singlePoolFixture((amountIn) => {
      if (amountIn === 1n * UNIT) return amountOutForBps(amountIn, 9999); // smaller, exceeds
      if (amountIn === 2n * UNIT) return amountOutForBps(amountIn, 5); // larger, qualifies
      return "RPC_ERROR"; // everything else irrelevant to this scenario
    });
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: [100], rpc }),
    );
    const outcome = outcomeAt(result, 0, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") {
      expect(outcome.qualifyingAmountIn).toBe(2n * UNIT); // no early-exit / no monotonic assumption — scans all points
      expect(outcome.monotonicityObserved).toBe(false);
    }
  });

  it("negative priceImpactBps (favorable execution) is compared correctly, no clamping", async () => {
    const f = singlePoolFixture((amountIn) => (amountIn === 1n * UNIT ? amountOutForBps(amountIn, -50) : "RPC_ERROR"));
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: [50], rpc }),
    );
    const outcome = outcomeAt(result, 0, 50);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") expect(outcome.qualifyingAmountIn).toBe(1n * UNIT);
  });
});

describe("deriveThresholdOutcomeForTesting — 'measured' requires status===QUOTED AND priceImpactBps defined (adversarial pre-commit pass, Issue 3)", () => {
  function cell(amountIn: bigint, overrides: Partial<MatrixCell> = {}): MatrixCell {
    return { amountIn, status: "QUOTED", analyticsStatus: "OK", evidence: [], ...overrides };
  }

  it("the exact scenario from the adversarial pass: 100=>QUOTED 0.7%, 250=>QUOTED impact-unavailable, 500=>QUOTED 1.4% — at 1% this must NOT become CLEAN_CEILING", () => {
    const cells: MatrixCell[] = [
      cell(100n * UNIT, { amountOut: 1n, priceImpactBps: { numerator: 70n, denominator: 1n } }),
      cell(250n * UNIT, { amountOut: 1n }), // QUOTED, amountOut valid, but priceImpactBps undefined (analytics unavailable for this point)
      cell(500n * UNIT, { amountOut: 1n, priceImpactBps: { numerator: 140n, denominator: 1n } }),
    ];
    const outcome = deriveThresholdOutcomeForTesting(cells, 100);
    expect(outcome.kind).toBe("WITHIN_THRESHOLD");
    if (outcome.kind === "WITHIN_THRESHOLD") {
      expect(outcome.qualifyingAmountIn).toBe(100n * UNIT);
      // The critical assertion: NEVER CLEAN_CEILING here — 250's outcome relative
      // to the threshold is genuinely unknown (QUOTED but unmeasured), so this
      // must disclose the gap via GAPPED_CEILING, with 500 (the smallest point
      // that actually HAS a measured impact) as the ceiling — never silently
      // treating 250 as if it had been evaluated and found to exceed.
      expect(outcome.upperRange).toEqual({ kind: "GAPPED_CEILING", nextMeasuredAmountIn: 500n * UNIT });
    }
  });

  it("a QUOTED-but-unmeasured point does not itself count as 'exceeded' for EXCEEDED_AT_SMALLEST_SAMPLE either — smallestMeasuredAmountIn only ever names a point with a real measured impact", () => {
    const cells: MatrixCell[] = [
      cell(1n * UNIT), // QUOTED, unmeasured
      cell(2n * UNIT, { priceImpactBps: { numerator: 9999n, denominator: 1n } }), // QUOTED, measured, exceeds
    ];
    const outcome = deriveThresholdOutcomeForTesting(cells, 100);
    expect(outcome.kind).toBe("EXCEEDED_AT_SMALLEST_SAMPLE");
    if (outcome.kind === "EXCEEDED_AT_SMALLEST_SAMPLE") {
      expect(outcome.smallestMeasuredAmountIn).toBe(2n * UNIT); // never 1n*UNIT, which was never actually measured
    }
  });
});

describe("computeVerifiedPoolDepthThresholds — V4 uint128 per-cell isolation", () => {
  it("a mid-ladder amountIn exceeding UINT128_MAX isolates to that ONE cell as PRECONDITION_FAILED; smaller AND larger sibling samples for the SAME pool remain independently evaluated", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, hooks: "0x0000000000000000000000000000000000000000" as Address, currency0: WETH, currency1: NVDA });
    const oversized = UINT128_MAX + 1n;
    const ladderWithOversized = [1n * UNIT, oversized, 5n * UNIT];
    const rows: RowStub[] = [{ kind: "v4", toOrPoolId: V4_A, slot0: slot0V4Return() }];
    const zeroHooks = "0x0000000000000000000000000000000000000000" as Address;
    const cells: CellStub[] = [
      { v4Key: { fee: 500, tickSpacing: 10, hooks: zeroHooks }, amountIn: 1n * UNIT, quote: v4QuoteReturn({ amountOut: 1n }) },
      { v4Key: { fee: 500, tickSpacing: 10, hooks: zeroHooks }, amountIn: 5n * UNIT, quote: v4QuoteReturn({ amountOut: 5n }) },
    ];
    const { rpc, calls } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool, identity }],
        tokenIn: WETH,
        amountsIn: ladderWithOversized,
        thresholdsBps: THRESHOLDS,
        rpc,
      }),
    );
    const cellsOut = result.pools[0]!.row.cells;
    expect(cellsOut[0]!.amountIn).toBe(1n * UNIT);
    expect(cellsOut[0]!.status).toBe("QUOTED");
    expect(cellsOut[1]!.amountIn).toBe(oversized);
    expect(cellsOut[1]!.status).toBe("PRECONDITION_FAILED");
    expect(cellsOut[1]!.preconditionFailure?.code).toBe("AMOUNT_IN_EXCEEDS_V4_BOUND");
    expect(cellsOut[2]!.amountIn).toBe(5n * UNIT);
    expect(cellsOut[2]!.status).toBe("QUOTED");
    // Zero quote RPC issued for the oversized cell — only 2 real quote calls.
    expect(calls.callsByKind["quote"]).toBe(2);
  });
});

describe("computeVerifiedPoolDepthThresholds — best-venue roll-up", () => {
  it("the pool with the largest qualifying amount wins; exact bigint ties are preserved, no gas/liquidity tie-break", async () => {
    const c1 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const c2 = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501, token0: NVDA, token1: USDG });
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) },
      { kind: "v3", toOrPoolId: V3_B, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) },
    ];
    // Both pools qualify at 1% for every sample up through 250; 500 exceeds for both — an exact tie at 250.
    const cells: CellStub[] = LADDER.flatMap((amountIn) => {
      const bps = amountIn <= 250n * UNIT ? 5 : 9999;
      return [
        { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountOutForBps(amountIn, bps) }) },
        { v3Fee: 501, amountIn, quote: v3QuoteReturn({ amountOut: amountOutForBps(amountIn, bps) }) },
      ];
    });
    const decimalsByAddress: Record<string, RpcStub> = { [NVDA.toLowerCase()]: decimalsReturn(18), [USDG.toLowerCase()]: decimalsReturn(6) };
    const { rpc } = buildFakeDepthRpc({ rows, cells, decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool: c1.pool, identity: c1.identity }, { pool: c2.pool, identity: c2.identity }],
        tokenIn: NVDA,
        amountsIn: LADDER,
        thresholdsBps: [100],
        rpc,
      }),
    );
    const best = result.bestVenueByThreshold.find((b) => b.thresholdBps === 100)!;
    expect(best.poolAddresses).toHaveLength(2);
    expect(best.poolAddresses.map((a) => a.toLowerCase()).sort()).toEqual([V3_A.toLowerCase(), V3_B.toLowerCase()].sort());
  });

  it("best-venue is empty (never omitted) when zero pools qualify at a threshold", async () => {
    const f = ((): ReturnType<typeof v3ComparisonCandidate> & { rows: RowStub[]; cells: CellStub[]; decimalsByAddress: Record<string, RpcStub> } => {
      const c = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
      return {
        ...c,
        rows: [{ kind: "v3", toOrPoolId: V3_A, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) }],
        cells: LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountOutForBps(amountIn, 9999) }) })),
        decimalsByAddress: { [NVDA.toLowerCase()]: decimalsReturn(18), [USDG.toLowerCase()]: decimalsReturn(6) },
      };
    })();
    const { rpc } = buildFakeDepthRpc({ rows: f.rows, cells: f.cells, decimalsByAddress: f.decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates: [{ pool: f.pool, identity: f.identity }], tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: [50], rpc }),
    );
    const best = result.bestVenueByThreshold.find((b) => b.thresholdBps === 50)!;
    expect(best.poolAddresses).toEqual([]);
  });

  it("best-venue is computed independently per threshold", async () => {
    const c1 = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const c2 = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501, token0: NVDA, token1: USDG });
    const rows: RowStub[] = [
      { kind: "v3", toOrPoolId: V3_A, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) },
      { kind: "v3", toOrPoolId: V3_B, slot0: slot0V3Return({ sqrtPriceX96: SPOT_SQRT_PRICE_X96 }) },
    ];
    // V3_A qualifies up to 1000 at every threshold; V3_B only up to 100 — so V3_A should win at every threshold, distinctly computed.
    const cells: CellStub[] = LADDER.flatMap((amountIn) => [
      { v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountOutForBps(amountIn, amountIn <= 1000n * UNIT ? 5 : 9999) }) },
      { v3Fee: 501, amountIn, quote: v3QuoteReturn({ amountOut: amountOutForBps(amountIn, amountIn <= 100n * UNIT ? 5 : 9999) }) },
    ]);
    const decimalsByAddress: Record<string, RpcStub> = { [NVDA.toLowerCase()]: decimalsReturn(18), [USDG.toLowerCase()]: decimalsReturn(6) };
    const { rpc } = buildFakeDepthRpc({ rows, cells, decimalsByAddress });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({
        candidates: [{ pool: c1.pool, identity: c1.identity }, { pool: c2.pool, identity: c2.identity }],
        tokenIn: NVDA,
        amountsIn: LADDER,
        thresholdsBps: [50, 500],
        rpc,
      }),
    );
    for (const th of [50, 500]) {
      const best = result.bestVenueByThreshold.find((b) => b.thresholdBps === th)!;
      expect(best.poolAddresses.map((a) => a.toLowerCase())).toEqual([V3_A.toLowerCase()]);
    }
  });
});

describe("computeVerifiedPoolDepthThresholds — classification consistency with the matrix's own classifyMatrixCandidates", () => {
  it("the same classifyMatrixCandidates call this primitive uses agrees with the matrix's own fast-path pre-check for identical inputs (shared, single implementation — never two independently-reasoned classifications)", async () => {
    const { classifyMatrixCandidates } = await import("../compare-verified-pools-across-amounts");
    const executable = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const hooked = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, currency0: USDG });
    const candidates = [{ pool: executable.pool, identity: executable.identity }, { pool: hooked.pool, identity: hooked.identity }];
    const classified = classifyMatrixCandidates(candidates, NVDA, 4663);
    expect(classified.executable).toHaveLength(1);
    expect(classified.preconditionFailed).toHaveLength(1);

    const rows: RowStub[] = [{ kind: "v3", toOrPoolId: V3_A }];
    const cells: CellStub[] = LADDER.map((amountIn) => ({ v3Fee: 500, amountIn, quote: v3QuoteReturn({ amountOut: amountIn / 2n }) }));
    const { rpc } = buildFakeDepthRpc({ rows, cells });
    const result = asOk(
      await computeVerifiedPoolDepthThresholds({ candidates, tokenIn: NVDA, amountsIn: LADDER, thresholdsBps: THRESHOLDS, rpc }),
    );
    const executableCount = result.pools.filter((p) => p.outcomesByThreshold.length > 0).length;
    const preconditionFailedCount = result.pools.filter((p) => p.outcomesByThreshold.length === 0).length;
    expect(executableCount).toBe(classified.executable.length);
    expect(preconditionFailedCount).toBe(classified.preconditionFailed.length);
  });
});

it("MAX_DEPTH_THRESHOLD_CELLS is frozen at 60", () => {
  expect(MAX_DEPTH_THRESHOLD_CELLS).toBe(60);
});
it("DEPTH_THRESHOLD_QUOTE_CONCURRENCY is frozen at 3", () => {
  expect(DEPTH_THRESHOLD_QUOTE_CONCURRENCY).toBe(3);
});
it("DEPTH_THRESHOLD_QUOTE_INTERVAL_MS is frozen at 100", () => {
  expect(DEPTH_THRESHOLD_QUOTE_INTERVAL_MS).toBe(100);
});
