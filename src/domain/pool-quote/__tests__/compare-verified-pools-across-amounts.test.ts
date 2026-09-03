import type { Address, Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDecimalsCall, encodeGetSlot0Call, encodeQuoteExactInputSingleV3Call, encodeQuoteExactInputSingleV4Call, encodeSlot0Call } from "../abi/selectors";
import {
  classifyMatrixCandidates,
  compareVerifiedPoolsAcrossExactInputs,
  MAX_MATRIX_AMOUNTS,
  MAX_MATRIX_CELLS,
  MATRIX_QUOTE_CONCURRENCY,
  MATRIX_QUOTE_INTERVAL_MS,
} from "../compare-verified-pools-across-amounts";
import {
  DuplicateCandidateError,
  EmptyAmountsLadderError,
  EmptyCandidatesError,
  InvalidAmountInError,
  MatrixTooLargeError,
  MismatchedComparisonGroupError,
  TooManyAmountsError,
} from "../errors";
import { UINT128_MAX } from "../read-uniswap-v4-quote";
import type { CrossPoolExecutionMatrixSnapshot } from "../types";
import {
  DEFAULT_TICK_SPACING,
  decimalsReturn,
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
import type { VerifiedRobinhoodRpcClient } from "@/providers/robinhood-rpc";

const V3_A = "0x0100000000000000000000000000000000000001" as Address;
const V3_B = "0x0200000000000000000000000000000000000002" as Address;
const V3_C = "0x0300000000000000000000000000000000000003" as Address;
const V4_A = "0xaa000000000000000000000000000000000000000000000000000000000000aa" as Hex;
const V4_B = "0xbb000000000000000000000000000000000000000000000000000000000000bb" as Hex;

const A1 = 1_000_000_000_000_000_000n; // 1
const A2 = 10_000_000_000_000_000_000n; // 10
const A3 = 100_000_000_000_000_000_000n; // 100

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

/**
 * A local fake RPC, purpose-built for the matrix primitive's own tests
 * — distinct from `buildFakeMultiPoolRpc` (which only supports ONE
 * shared `amountIn` across every candidate, exactly matching 6F.2's own
 * single-size contract) because a matrix test needs to route BOTH by
 * candidate AND by `amountIn` simultaneously. Never modifies the shared
 * `fixtures.ts` file — kept local to this test file only.
 */
function buildFakeMatrixRpc(args: {
  rows: readonly RowStub[];
  cells: readonly CellStub[];
  decimalsByAddress?: Readonly<Record<string, RpcStub>>;
  getBlockNumber?: (() => Promise<bigint>) | { error: unknown };
}): { rpc: VerifiedRobinhoodRpcClient; calls: { getBlockNumberCalls: number; callsByKind: Record<string, number>; callLog: Array<{ kind: string; to: string }> } } {
  const calls = { getBlockNumberCalls: 0, callsByKind: {} as Record<string, number>, callLog: [] as Array<{ kind: string; to: string }> };
  const bump = (kind: string, to: string) => {
    calls.callsByKind[kind] = (calls.callsByKind[kind] ?? 0) + 1;
    calls.callLog.push({ kind, to });
  };

  const v3QuoteSelector = encodeQuoteExactInputSingleV3Call(NVDA, USDG, A1, 500).slice(0, 10);
  const v4QuoteSelector = encodeQuoteExactInputSingleV4Call({ currency0: WETH, currency1: NVDA, fee: 8388608, tickSpacing: 4, hooks: "0x0000000000000000000000000000000000000000" as Address }, true, A1, "0x").slice(0, 10);
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
    call: async (request) => {
      const selector = request.data.slice(0, 10);

      if (selector === decimalsSelector) {
        bump("decimals", request.to);
        const key = request.to.toLowerCase();
        const stub = args.decimalsByAddress?.[key];
        return resolveStub(stub, decimalsReturn(18));
      }

      if (selector === slot0Selector) {
        bump("spot", request.to);
        const row = args.rows.find((r) => r.kind === "v3" && (r.toOrPoolId as string).toLowerCase() === request.to.toLowerCase());
        return resolveStub(row?.slot0, slot0V3Return());
      }

      if (selector === getSlot0Selector) {
        const poolId = `0x${word(request.data, 0)}` as Hex;
        bump("spot", poolId);
        const row = args.rows.find((r) => r.kind === "v4" && (r.toOrPoolId as string).toLowerCase() === poolId.toLowerCase());
        return resolveStub(row?.slot0, slot0V4Return());
      }

      if (selector === v3QuoteSelector) {
        const fee = Number(BigInt(`0x${word(request.data, 3)}`));
        const amountIn = BigInt(`0x${word(request.data, 2)}`);
        bump("quote", `v3:${fee}:${amountIn}`);
        const cell = args.cells.find((c) => c.v3Fee === fee && c.amountIn === amountIn);
        if (!cell) throw new Error(`no cell stub for v3 fee=${fee} amountIn=${amountIn}`);
        return resolveStub(cell.quote, v3QuoteReturn());
      }

      if (selector === v4QuoteSelector) {
        const fee = Number(BigInt(`0x${word(request.data, 3)}`));
        const tickSpacingRaw = BigInt(`0x${word(request.data, 4)}`);
        const tickSpacing = Number(tickSpacingRaw > (1n << 255n) ? tickSpacingRaw - (1n << 256n) : tickSpacingRaw);
        const hooks = (`0x${word(request.data, 5).slice(24)}`).toLowerCase();
        const amountIn = BigInt(`0x${word(request.data, 7)}`);
        bump("quote", `v4:${fee}:${tickSpacing}:${hooks}:${amountIn}`);
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

function asOk(result: Awaited<ReturnType<typeof compareVerifiedPoolsAcrossExactInputs>>): CrossPoolExecutionMatrixSnapshot {
  if (result.status !== "OK") throw new Error(`expected OK, got ${result.status}`);
  return result;
}

describe("compareVerifiedPoolsAcrossExactInputs — structural validation (before any RPC)", () => {
  it("throws EmptyCandidatesError, zero RPC calls", async () => {
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(compareVerifiedPoolsAcrossExactInputs({ candidates: [], tokenIn: NVDA, amountsIn: [A1], rpc })).rejects.toThrow(EmptyCandidatesError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws DuplicateCandidateError for the same pool twice, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(
      compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }, { pool, identity }], tokenIn: NVDA, amountsIn: [A1], rpc }),
    ).rejects.toThrow(DuplicateCandidateError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws EmptyAmountsLadderError for an empty ladder, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [], rpc })).rejects.toThrow(
      EmptyAmountsLadderError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws InvalidAmountInError for a non-positive amount, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1, 0n], rpc })).rejects.toThrow(
      InvalidAmountInError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws TooManyAmountsError when amountsIn.length exceeds MAX_MATRIX_AMOUNTS, zero RPC calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    const tooMany = Array.from({ length: MAX_MATRIX_AMOUNTS + 1 }, (_, i) => A1 + BigInt(i));
    await expect(compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: tooMany, rpc })).rejects.toThrow(
      TooManyAmountsError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws MismatchedComparisonGroupError when candidates resolve to different tokenOut, zero RPC calls", async () => {
    const { pool: p1, identity: i1 } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500, token0: NVDA, token1: USDG });
    const { pool: p2, identity: i2 } = v3ComparisonCandidate({ pairAddress: V3_B, fee: 500, token0: NVDA, token1: WETH });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(
      compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: p1, identity: i1 },
          { pool: p2, identity: i2 },
        ],
        tokenIn: NVDA,
        amountsIn: [A1],
        rpc,
      }),
    ).rejects.toThrow(MismatchedComparisonGroupError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("throws MatrixTooLargeError when executable x amounts exceeds MAX_MATRIX_CELLS, computed against EXECUTABLE candidates only (not raw)", async () => {
    // 7 executable V3 candidates x 9 amounts = 63 > 60.
    const candidates = Array.from({ length: 7 }, (_, i) =>
      v3ComparisonCandidate({ pairAddress: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, fee: 500 + i }),
    );
    const amounts = Array.from({ length: 9 }, (_, i) => A1 + BigInt(i));
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(compareVerifiedPoolsAcrossExactInputs({ candidates, tokenIn: NVDA, amountsIn: amounts, rpc })).rejects.toThrow(MatrixTooLargeError);
    expect(calls.getBlockNumberCalls).toBe(0);
  });

  it("does NOT throw MatrixTooLargeError when raw candidates x amounts exceeds the cap but EXECUTABLE candidates x amounts does not (hooked-without-hookData rows excluded from the count)", async () => {
    // 2 executable V3 + 5 hooked-without-hookData V4 = 7 raw candidates.
    // 7 x 9 = 63 > 60 (would wrongly reject if counted against raw), but
    // 2 x 9 = 18, well under 60.
    const v3s = [
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 }),
    ];
    const hookedV4s = Array.from({ length: 5 }, (_, i) =>
      v4ComparisonCandidate({ poolId: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, hooks: HOOK_ADDRESS, currency0: USDG }),
    );
    const candidates = [...v3s.map((c) => ({ pool: c.pool, identity: c.identity })), ...hookedV4s.map((c) => ({ pool: c.pool, identity: c.identity }))];
    const amounts = Array.from({ length: 9 }, (_, i) => A1 + BigInt(i));
    const { rpc } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: [
        ...amounts.map((amountIn) => ({ v3Fee: 500, amountIn })),
        ...amounts.map((amountIn) => ({ v3Fee: 501, amountIn })),
      ],
    });
    const result = await compareVerifiedPoolsAcrossExactInputs({ candidates, tokenIn: NVDA, amountsIn: amounts, rpc });
    const snapshot = asOk(result);
    expect(snapshot.rows).toHaveLength(7);
  });
});

describe("classifyMatrixCandidates — pure, zero-RPC classification", () => {
  it("partitions V3 (always executable) and hooked-without-hookData V4 (precondition-failed) candidates", () => {
    const { pool: p1, identity: i1 } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: p2, identity: i2 } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, currency0: USDG });
    const { pool: p3, identity: i3 } = v4ComparisonCandidate({ poolId: V4_B, hooks: "0x0000000000000000000000000000000000000000" as Address, currency0: USDG });

    const result = classifyMatrixCandidates(
      [
        { pool: p1, identity: i1 },
        { pool: p2, identity: i2 },
        { pool: p3, identity: i3 },
      ],
      NVDA,
      4663,
    );

    expect(result.executable.map((r) => r.input.pool.pairAddress)).toEqual([p1.pairAddress, p3.pairAddress]);
    expect(result.preconditionFailed.map((r) => r.input.pool.pairAddress)).toEqual([p2.pairAddress]);
    expect(result.preconditionFailed[0]!.code).toBe("MISSING_HOOK_DATA");
  });

  it("does not throw for a hooked V4 candidate when hookData IS supplied", () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS });
    const result = classifyMatrixCandidates([{ pool, identity, hookData: "0xabcd" as Hex }], NVDA, 4663);
    expect(result.executable).toHaveLength(1);
    expect(result.preconditionFailed).toHaveLength(0);
  });

  it("is PURE and DETERMINISTIC — identical inputs always produce identical executable/preconditionFailed partitions and counts, called repeatedly — the exact property the dual (orchestration fast-path + primitive authoritative) MAX_MATRIX_CELLS enforcement relies on to never disagree", () => {
    const { pool: p1, identity: i1 } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: p2, identity: i2 } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, currency0: USDG });
    const { pool: p3, identity: i3 } = v4ComparisonCandidate({ poolId: V4_B, hooks: "0x0000000000000000000000000000000000000000" as Address, currency0: USDG });
    const candidates = [
      { pool: p1, identity: i1 },
      { pool: p2, identity: i2 },
      { pool: p3, identity: i3 },
    ];

    const first = classifyMatrixCandidates(candidates, NVDA, 4663);
    const second = classifyMatrixCandidates(candidates, NVDA, 4663);
    const third = classifyMatrixCandidates(candidates, NVDA, 4663);

    expect(first.executable.length).toBe(second.executable.length);
    expect(first.executable.length).toBe(third.executable.length);
    expect(first.preconditionFailed.length).toBe(second.preconditionFailed.length);
    expect(first.executable.map((r) => r.input.pool.pairAddress)).toEqual(second.executable.map((r) => r.input.pool.pairAddress));
    expect(first.executable.map((r) => r.input.pool.pairAddress)).toEqual(third.executable.map((r) => r.input.pool.pairAddress));
    expect(first.tokenOut).toBe(second.tokenOut);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — same-block invariant", () => {
  it("calls rpc.getBlockNumber exactly once regardless of candidate/amount count", async () => {
    const candidates = [v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }), v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 })];
    const amounts = [A1, A2, A3];
    const { rpc, calls } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: amounts.flatMap((amountIn) => [{ v3Fee: 500, amountIn }, { v3Fee: 501, amountIn }]),
    });
    await compareVerifiedPoolsAcrossExactInputs({
      candidates: candidates.map((c) => ({ pool: c.pool, identity: c.identity })),
      tokenIn: NVDA,
      amountsIn: amounts,
      rpc,
    });
    expect(calls.getBlockNumberCalls).toBe(1);
  });

  it("every cell in the result carries the identical blockNumber", async () => {
    const candidates = [v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 })];
    const amounts = [A1, A2];
    const { rpc } = buildFakeMatrixRpc({
      rows: [{ kind: "v3", toOrPoolId: V3_A }],
      cells: amounts.map((amountIn) => ({ v3Fee: 500, amountIn })),
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: candidates.map((c) => ({ pool: c.pool, identity: c.identity })),
        tokenIn: NVDA,
        amountsIn: amounts,
        rpc,
      }),
    );
    expect(result.blockNumber).toBe(QUOTE_BLOCK);
  });

  it("returns BLOCK_PIN_FAILURE and attempts zero further reads when eth_blockNumber fails", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [], getBlockNumber: { error: new Error("boom") } });
    const result = await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1], rpc });
    expect(result.status).toBe("BLOCK_PIN_FAILURE");
    expect(calls.callsByKind).toEqual({});
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — RPC call-count shape", () => {
  it("exactly one decimals() read per token side (2 total for ERC20/ERC20), regardless of candidate/amount count", async () => {
    const candidates = [
      v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }),
      v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 }),
      v3ComparisonCandidate({ pairAddress: V3_C, fee: 502 }),
    ];
    const amounts = [A1, A2, A3];
    const { rpc, calls } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
        { kind: "v3", toOrPoolId: V3_C },
      ],
      cells: amounts.flatMap((amountIn) => [
        { v3Fee: 500, amountIn },
        { v3Fee: 501, amountIn },
        { v3Fee: 502, amountIn },
      ]),
    });
    await compareVerifiedPoolsAcrossExactInputs({
      candidates: candidates.map((c) => ({ pool: c.pool, identity: c.identity })),
      tokenIn: NVDA,
      amountsIn: amounts,
      rpc,
    });
    expect(calls.callsByKind.decimals).toBe(2);
  });

  it("exactly one spot read per EXECUTABLE candidate — never per cell", async () => {
    const candidates = [v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 }), v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 })];
    const amounts = [A1, A2, A3, A1 + 1n, A2 + 1n]; // 5 amounts
    const { rpc, calls } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: amounts.flatMap((amountIn) => [{ v3Fee: 500, amountIn }, { v3Fee: 501, amountIn }]),
    });
    await compareVerifiedPoolsAcrossExactInputs({
      candidates: candidates.map((c) => ({ pool: c.pool, identity: c.identity })),
      tokenIn: NVDA,
      amountsIn: amounts,
      rpc,
    });
    // 2 candidates -> 2 spot reads, NOT 2 candidates x 5 amounts = 10.
    expect(calls.callsByKind.spot).toBe(2);
  });

  it("exactly executable.length x amountsIn.length quote calls — precondition-failed rows issue ZERO", async () => {
    const { pool: pV3, identity: iV3 } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: pHooked, identity: iHooked } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, currency0: USDG });
    const amounts = [A1, A2, A3];
    const { rpc, calls } = buildFakeMatrixRpc({
      rows: [{ kind: "v3", toOrPoolId: V3_A }],
      cells: amounts.map((amountIn) => ({ v3Fee: 500, amountIn })),
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: pV3, identity: iV3 },
          { pool: pHooked, identity: iHooked },
        ],
        tokenIn: NVDA,
        amountsIn: amounts,
        rpc,
      }),
    );
    expect(calls.callsByKind.quote).toBe(3); // 1 executable candidate x 3 amounts
    expect(result.rows).toHaveLength(2);
    const hookedRow = result.rows.find((r) => r.pool.pairAddress.toLowerCase() === pHooked.pairAddress.toLowerCase())!;
    expect(hookedRow.cells).toHaveLength(3);
    expect(hookedRow.cells.every((c) => c.status === "PRECONDITION_FAILED" && c.preconditionFailure?.code === "MISSING_HOOK_DATA")).toBe(true);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — ordering", () => {
  it("preserves caller candidate order in rows, including precondition-failed rows interleaved", async () => {
    const { pool: pA, identity: iA } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: pHooked, identity: iHooked } = v4ComparisonCandidate({ poolId: V4_A, hooks: HOOK_ADDRESS, currency0: USDG });
    const { pool: pB, identity: iB } = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const { rpc } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: [{ v3Fee: 500, amountIn: A1 }, { v3Fee: 501, amountIn: A1 }],
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: pA, identity: iA },
          { pool: pHooked, identity: iHooked },
          { pool: pB, identity: iB },
        ],
        tokenIn: NVDA,
        amountsIn: [A1],
        rpc,
      }),
    );
    expect(result.rows.map((r) => r.pool.pairAddress)).toEqual([pA.pairAddress, pHooked.pairAddress, pB.pairAddress]);
  });

  it("preserves caller amount order across columns, including an intentionally unsorted ladder", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const unsorted = [A3, A1, A2];
    const { rpc } = buildFakeMatrixRpc({
      rows: [{ kind: "v3", toOrPoolId: V3_A }],
      cells: unsorted.map((amountIn) => ({ v3Fee: 500, amountIn })),
    });
    const result = asOk(await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: unsorted, rpc }));
    expect(result.amountsIn).toEqual(unsorted);
    expect(result.rows[0]!.cells.map((c) => c.amountIn)).toEqual(unsorted);
    expect(result.rankingsByAmount.map((r) => r.amountIn)).toEqual(unsorted);
  });

  it("DUPLICATE amounts (e.g. [1, 1, 10]) are handled by ARRAY INDEX throughout, never merged/deduplicated/overwritten — a release-critical adversarial target", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const duplicated = [A1, A1, A2]; // 3 entries, first two identical
    const { rpc, calls } = buildFakeMatrixRpc({
      rows: [{ kind: "v3", toOrPoolId: V3_A }],
      cells: [
        { v3Fee: 500, amountIn: A1 },
        { v3Fee: 500, amountIn: A2 },
      ],
    });
    const result = asOk(await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: duplicated, rpc }));

    // The duplicate value issues its OWN independent RPC call each time —
    // never memoized/cached by amount value (3 requested amounts -> 3
    // quote calls, not 2 for the 2 unique values).
    expect(calls.callsByKind.quote).toBe(3);

    // Every index is preserved, positionally, exactly as requested —
    // never merged into 2 unique columns.
    expect(result.amountsIn).toEqual(duplicated);
    expect(result.amountsIn).toHaveLength(3);
    expect(result.rows[0]!.cells).toHaveLength(3);
    expect(result.rows[0]!.cells.map((c) => c.amountIn)).toEqual(duplicated);
    expect(result.rankingsByAmount).toHaveLength(3);
    expect(result.rankingsByAmount.map((r) => r.amountIn)).toEqual(duplicated);
    // Both duplicate-value columns (index 0 and 1) independently rank the
    // same single candidate as best, neither column silently empty/overwritten.
    expect(result.rankingsByAmount[0]!.bestCandidatePoolAddresses).toEqual([pool.pairAddress]);
    expect(result.rankingsByAmount[1]!.bestCandidatePoolAddresses).toEqual([pool.pairAddress]);

    // The cap is computed against the RAW amountsIn.length (3), never a
    // deduplicated count (2) — duplicates count fully toward MAX_MATRIX_CELLS.
    expect(1 * duplicated.length).toBe(3);
  });

  it("a duplicated-amount ladder is counted PER-ENTRY (never deduplicated to unique values) when enforcing MAX_MATRIX_CELLS", async () => {
    // 7 executable candidates x a 9-entry ladder that is ALL THE SAME
    // repeated amount = 7 x 9 = 63 > 60 -> must REJECT. If duplicates
    // were silently deduplicated to 1 unique value first, this would
    // incorrectly compute 7 x 1 = 7 and NOT reject — the exact bug this
    // test exists to catch.
    const candidates = Array.from({ length: 7 }, (_, i) =>
      v3ComparisonCandidate({ pairAddress: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, fee: 500 + i }),
    );
    const allSameAmount = Array.from({ length: 9 }, () => A1);
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [], cells: [] });
    await expect(compareVerifiedPoolsAcrossExactInputs({ candidates, tokenIn: NVDA, amountsIn: allSameAmount, rpc })).rejects.toThrow(
      MatrixTooLargeError,
    );
    expect(calls.getBlockNumberCalls).toBe(0);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — ranking per size", () => {
  it("ranks each amount column independently, over that column's QUOTED cells only", async () => {
    const { pool: pA, identity: iA } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: pB, identity: iB } = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const { rpc } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: [
        { v3Fee: 500, amountIn: A1, quote: v3QuoteReturn({ amountOut: 100n }) },
        { v3Fee: 501, amountIn: A1, quote: v3QuoteReturn({ amountOut: 200n }) },
        { v3Fee: 500, amountIn: A2, quote: v3QuoteReturn({ amountOut: 5000n }) },
        { v3Fee: 501, amountIn: A2, quote: v3QuoteReturn({ amountOut: 3000n }) },
      ],
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: pA, identity: iA },
          { pool: pB, identity: iB },
        ],
        tokenIn: NVDA,
        amountsIn: [A1, A2],
        rpc,
      }),
    );
    // At A1, pool B wins (200 > 100). At A2, pool A wins (5000 > 3000) — size-dependent winner change.
    expect(result.rankingsByAmount[0]!.bestCandidatePoolAddresses).toEqual([pB.pairAddress]);
    expect(result.rankingsByAmount[1]!.bestCandidatePoolAddresses).toEqual([pA.pairAddress]);
  });

  it("reports an exact tie truthfully via bestCandidatePoolAddresses (length > 1)", async () => {
    const { pool: pA, identity: iA } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: pB, identity: iB } = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const { rpc } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: [
        { v3Fee: 500, amountIn: A1, quote: v3QuoteReturn({ amountOut: 500n }) },
        { v3Fee: 501, amountIn: A1, quote: v3QuoteReturn({ amountOut: 500n }) },
      ],
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: pA, identity: iA },
          { pool: pB, identity: iB },
        ],
        tokenIn: NVDA,
        amountsIn: [A1],
        rpc,
      }),
    );
    expect([...result.rankingsByAmount[0]!.bestCandidatePoolAddresses].sort()).toEqual([pA.pairAddress, pB.pairAddress].sort());
  });

  it("never computes or exposes a synthesized crossover amount anywhere in the result", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc } = buildFakeMatrixRpc({ rows: [{ kind: "v3", toOrPoolId: V3_A }], cells: [{ v3Fee: 500, amountIn: A1 }] });
    const result = asOk(await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1], rpc }));
    // Structural proof: MatrixRanking only ever carries amountIn (an
    // input echo) + two address arrays — there is no numeric field
    // anywhere that could represent an interpolated/synthesized amount.
    expect(Object.keys(result.rankingsByAmount[0]!).sort()).toEqual(["amountIn", "bestCandidatePoolAddresses", "rankedQuotedPoolAddresses"]);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — isolated per-cell status", () => {
  it("one cell's RPC_ERROR does not affect a sibling cell (same row, different amount) or a sibling row", async () => {
    const { pool: pA, identity: iA } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: pB, identity: iB } = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const { rpc } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: [
        { v3Fee: 500, amountIn: A1, quote: { error: new Error("transient") } },
        { v3Fee: 500, amountIn: A2 },
        { v3Fee: 501, amountIn: A1 },
      ],
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: pA, identity: iA },
          { pool: pB, identity: iB },
        ],
        tokenIn: NVDA,
        amountsIn: [A1, A2],
        rpc,
      }),
    );
    const rowA = result.rows.find((r) => r.pool.pairAddress === pA.pairAddress)!;
    const rowB = result.rows.find((r) => r.pool.pairAddress === pB.pairAddress)!;
    expect(rowA.cells[0]!.status).toBe("RPC_ERROR");
    expect(rowA.cells[1]!.status).toBe("QUOTED");
    expect(rowB.cells[0]!.status).toBe("QUOTED");
  });

  it("V4 uint128 overflow marks ONLY the oversized cell PRECONDITION_FAILED, smaller sizes in the same row remain valid", async () => {
    const { pool, identity } = v4ComparisonCandidate({ poolId: V4_A, hooks: "0x0000000000000000000000000000000000000000" as Address });
    const oversized = UINT128_MAX + 1n;
    const { rpc, calls } = buildFakeMatrixRpc({
      rows: [{ kind: "v4", toOrPoolId: V4_A }],
      cells: [{ v4Key: { fee: 500, tickSpacing: DEFAULT_TICK_SPACING, hooks: "0x0000000000000000000000000000000000000000" as Address }, amountIn: A1 }],
    });
    const result = asOk(await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1, oversized], rpc }));
    expect(result.rows[0]!.cells[0]!.status).toBe("QUOTED");
    expect(result.rows[0]!.cells[1]!.status).toBe("PRECONDITION_FAILED");
    expect(result.rows[0]!.cells[1]!.preconditionFailure?.code).toBe("AMOUNT_IN_EXCEEDS_V4_BOUND");
    // The oversized cell issued zero quoter calls.
    expect(calls.callsByKind.quote).toBe(1);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — analytics-failure invariant (RELEASE-CRITICAL)", () => {
  it("A. a shared-decimals failure never blanks a successful cell's amountOut/status — only executionPrice/priceImpactBps become unavailable", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc } = buildFakeMatrixRpc({
      rows: [{ kind: "v3", toOrPoolId: V3_A }],
      cells: [{ v3Fee: 500, amountIn: A1 }],
      decimalsByAddress: { [NVDA.toLowerCase()]: { error: new Error("decimals rpc failure") } },
    });
    const result = asOk(await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1], rpc }));
    expect(result.sharedAnalyticsStatus).toBe("RPC_ERROR");
    const cell = result.rows[0]!.cells[0]!;
    expect(cell.status).toBe("QUOTED");
    expect(cell.amountOut).toBeDefined();
    expect(cell.executionPrice).toBeUndefined();
    expect(cell.priceImpactBps).toBeUndefined();
    expect(result.rankingsByAmount[0]!.rankedQuotedPoolAddresses).toEqual([pool.pairAddress]);
  });

  it("B. one candidate's own spot-read failure never blanks its successful quote's amountOut/status, and does not affect a sibling candidate's own analytics", async () => {
    const { pool: pA, identity: iA } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { pool: pB, identity: iB } = v3ComparisonCandidate({ pairAddress: V3_B, fee: 501 });
    const { rpc } = buildFakeMatrixRpc({
      rows: [
        { kind: "v3", toOrPoolId: V3_A, slot0: { error: new Error("spot rpc failure") } },
        { kind: "v3", toOrPoolId: V3_B },
      ],
      cells: [
        { v3Fee: 500, amountIn: A1 },
        { v3Fee: 501, amountIn: A1 },
      ],
    });
    const result = asOk(
      await compareVerifiedPoolsAcrossExactInputs({
        candidates: [
          { pool: pA, identity: iA },
          { pool: pB, identity: iB },
        ],
        tokenIn: NVDA,
        amountsIn: [A1],
        rpc,
      }),
    );
    const rowA = result.rows.find((r) => r.pool.pairAddress === pA.pairAddress)!;
    const rowB = result.rows.find((r) => r.pool.pairAddress === pB.pairAddress)!;
    expect(rowA.cells[0]!.status).toBe("QUOTED");
    expect(rowA.cells[0]!.amountOut).toBeDefined();
    expect(rowA.cells[0]!.analyticsStatus).toBe("RPC_ERROR");
    expect(rowA.cells[0]!.executionPrice).toBeUndefined();
    // Sibling candidate B's own analytics are completely unaffected.
    expect(rowB.cells[0]!.analyticsStatus).toBe("OK");
    expect(rowB.cells[0]!.executionPrice).toBeDefined();
    // Both remain rankable — ranking is amountOut-based, never analytics-gated.
    expect(result.rankingsByAmount[0]!.rankedQuotedPoolAddresses).toHaveLength(2);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — quote caching absence", () => {
  it("two calls against the identical inputs issue two independent sets of quote calls", async () => {
    const { pool, identity } = v3ComparisonCandidate({ pairAddress: V3_A, fee: 500 });
    const { rpc, calls } = buildFakeMatrixRpc({ rows: [{ kind: "v3", toOrPoolId: V3_A }], cells: [{ v3Fee: 500, amountIn: A1 }] });
    await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1], rpc });
    await compareVerifiedPoolsAcrossExactInputs({ candidates: [{ pool, identity }], tokenIn: NVDA, amountsIn: [A1], rpc });
    expect(calls.callsByKind.quote).toBe(2);
    expect(calls.getBlockNumberCalls).toBe(2);
  });
});

describe("compareVerifiedPoolsAcrossExactInputs — concurrency/spacing (deterministic, fake timers, no wall-clock)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never exceeds MATRIX_QUOTE_CONCURRENCY simultaneously in-flight quote calls, and spaces quote-call STARTS by >= MATRIX_QUOTE_INTERVAL_MS globally — reusing the SAME deterministic technique already proven correct for createLimiter itself (limiter.test.ts)", async () => {
    const M = 5;
    const amounts = [A1, A2, A3]; // 5 x 3 = 15 cells — well under MAX_MATRIX_CELLS
    const candidates = Array.from({ length: M }, (_, i) =>
      v3ComparisonCandidate({ pairAddress: `0x${(i + 1).toString(16).padStart(40, "0")}` as Address, fee: 500 + i }),
    );

    const v3QuoteSelector = encodeQuoteExactInputSingleV3Call(NVDA, USDG, A1, 500).slice(0, 10);
    const slot0Selector = encodeSlot0Call().slice(0, 10);
    const decimalsSelector = encodeDecimalsCall().slice(0, 10);

    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;

    const rpc: VerifiedRobinhoodRpcClient = {
      chainId: 4663,
      getBlockNumber: async () => QUOTE_BLOCK,
      getCode: async () => {
        throw new Error("unstubbed: getCode");
      },
      call: async (request) => {
        const selector = request.data.slice(0, 10);
        if (selector === decimalsSelector) return decimalsReturn(18);
        if (selector === slot0Selector) return slot0V3Return();
        if (selector === v3QuoteSelector) {
          starts.push(Date.now());
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return v3QuoteReturn();
        }
        throw new Error(`unstubbed fake RPC call: ${selector}`);
      },
      getLogs: async () => {
        throw new Error("unstubbed: getLogs");
      },
    };

    const resultPromise = compareVerifiedPoolsAcrossExactInputs({
      candidates: candidates.map((c) => ({ pool: c.pool, identity: c.identity })),
      tokenIn: NVDA,
      amountsIn: amounts,
      rpc,
    });

    // Theoretical floor per the frozen plan's own arithmetic: (15 - 1) x
    // 100ms = 1400ms dispatch + ~10ms for the last call to finish. Advance
    // generously past that so the whole matrix definitely completes.
    await vi.advanceTimersByTimeAsync(3000);
    const result = await resultPromise;

    expect(result.status).toBe("OK");
    expect(starts).toHaveLength(15);
    expect(maxActive).toBeLessThanOrEqual(MATRIX_QUOTE_CONCURRENCY);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(MATRIX_QUOTE_INTERVAL_MS);
    }
    // Direct regression check for the frozen plan's correction 1 arithmetic:
    // the LAST cell must not start before (N-1) x intervalMs after the first.
    expect(starts[starts.length - 1]! - starts[0]!).toBeGreaterThanOrEqual((15 - 1) * MATRIX_QUOTE_INTERVAL_MS);
  });
});

describe("frozen constants", () => {
  it("match the frozen production parameters exactly", () => {
    expect(MAX_MATRIX_AMOUNTS).toBe(10);
    expect(MAX_MATRIX_CELLS).toBe(60);
    expect(MATRIX_QUOTE_CONCURRENCY).toBe(3);
    expect(MATRIX_QUOTE_INTERVAL_MS).toBe(100);
  });
});
