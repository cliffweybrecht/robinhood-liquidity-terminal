import { describe, expect, it } from "vitest";
import type { ExecutionCandidateDto, ExecutionComparisonSnapshotDto } from "@/domain/execution-comparison";
import {
  amountInLabel,
  bestExecutionLabel,
  formatAmountOut,
  formatExecutionPrice,
  formatGasEstimate,
  formatGroupLabel,
  formatImpactPercent,
  isBestCandidate,
  orderCandidatesForTable,
  sharedAnalyticsUnavailableNote,
  statusCopy,
} from "../executionFormatting";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POOL_C = "0xcccccccccccccccccccccccccccccccccccccccc".slice(0, 42);

function candidate(overrides: Partial<ExecutionCandidateDto> = {}): ExecutionCandidateDto {
  return {
    pairAddress: POOL_A,
    dexId: "uniswap",
    family: "UNISWAP_V3",
    status: "QUOTED",
    analyticsStatus: "OK",
    ...overrides,
  };
}

describe("statusCopy — exact per-status copy, never a generic 'Error'", () => {
  it.each([
    ["QUOTED", "Quoted"],
    ["UNQUOTABLE", "Cannot execute"],
    ["INDETERMINATE", "Could not determine"],
    ["RPC_ERROR", "RPC error"],
  ] as const)("%s -> %s", (status, expected) => {
    expect(statusCopy(candidate({ status }))).toBe(expected);
  });

  it("PRECONDITION_FAILED / MISSING_HOOK_DATA -> 'Hook parameters unsupported'", () => {
    expect(
      statusCopy(candidate({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "x" } })),
    ).toBe("Hook parameters unsupported");
  });

  it("PRECONDITION_FAILED / AMOUNT_IN_EXCEEDS_V4_BOUND -> 'Amount exceeds quote bound'", () => {
    expect(
      statusCopy(candidate({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "AMOUNT_IN_EXCEEDS_V4_BOUND", detail: "x" } })),
    ).toBe("Amount exceeds quote bound");
  });
});

describe("orderCandidatesForTable", () => {
  it("orders QUOTED rows in the exact server ranking order, never by client-parsed amountOut", () => {
    const candidates = [
      candidate({ pairAddress: POOL_A, amountOut: "1" }),
      candidate({ pairAddress: POOL_B, amountOut: "999999999999999999999" }),
    ];
    const ranking: ExecutionComparisonSnapshotDto["ranking"] = {
      rankedQuotedPoolAddresses: [POOL_A, POOL_B],
      bestCandidatePoolAddresses: [POOL_A],
    };
    const { attempted } = orderCandidatesForTable(candidates, ranking);
    expect(attempted.map((c) => c.pairAddress)).toEqual([POOL_A, POOL_B]);
  });

  it("places attempted-but-not-quoted candidates after all QUOTED rows, in original order", () => {
    const candidates = [
      candidate({ pairAddress: POOL_A, status: "RPC_ERROR", amountOut: undefined }),
      candidate({ pairAddress: POOL_B, status: "QUOTED", amountOut: "5" }),
      candidate({ pairAddress: POOL_C, status: "UNQUOTABLE", amountOut: undefined }),
    ];
    const ranking: ExecutionComparisonSnapshotDto["ranking"] = {
      rankedQuotedPoolAddresses: [POOL_B],
      bestCandidatePoolAddresses: [POOL_B],
    };
    const { attempted } = orderCandidatesForTable(candidates, ranking);
    expect(attempted.map((c) => c.pairAddress)).toEqual([POOL_B, POOL_A, POOL_C]);
  });

  it("separates PRECONDITION_FAILED candidates out of the attempted table entirely", () => {
    const candidates = [
      candidate({ pairAddress: POOL_A, status: "QUOTED", amountOut: "5" }),
      candidate({ pairAddress: POOL_B, status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "x" } }),
    ];
    const ranking: ExecutionComparisonSnapshotDto["ranking"] = {
      rankedQuotedPoolAddresses: [POOL_A],
      bestCandidatePoolAddresses: [POOL_A],
    };
    const { attempted, precondition } = orderCandidatesForTable(candidates, ranking);
    expect(attempted.map((c) => c.pairAddress)).toEqual([POOL_A]);
    expect(precondition.map((c) => c.pairAddress)).toEqual([POOL_B]);
  });
});

describe("isBestCandidate / bestExecutionLabel — exact tie handling", () => {
  it("marks every tied address as best, not just the first", () => {
    const best = [POOL_A, POOL_B];
    expect(isBestCandidate(POOL_A, best)).toBe(true);
    expect(isBestCandidate(POOL_B, best)).toBe(true);
    expect(isBestCandidate(POOL_C, best)).toBe(false);
  });

  it("is case-insensitive on address comparison", () => {
    expect(isBestCandidate(POOL_A.toUpperCase(), [POOL_A])).toBe(true);
  });

  it("labels a unique winner 'Best execution' and a tie 'Tied best execution'", () => {
    expect(bestExecutionLabel([POOL_A])).toBe("Best execution");
    expect(bestExecutionLabel([POOL_A, POOL_B])).toBe("Tied best execution");
  });
});

describe("formatGasEstimate — thousands separators, no floating point", () => {
  it("groups a large integer string", () => {
    expect(formatGasEstimate("132533")).toBe("132,533");
  });

  it("handles small values with no separator needed", () => {
    expect(formatGasEstimate("42")).toBe("42");
  });

  it("returns an em dash for undefined", () => {
    expect(formatGasEstimate(undefined)).toBe("—");
  });
});

describe("formatAmountOut — exact bigint formatting, never Number()", () => {
  it("formats a value too large for safe Number precision without losing digits", () => {
    // 2^60 + 1, far beyond Number.MAX_SAFE_INTEGER-safe arithmetic if mishandled
    const raw = "1152921504606846977";
    expect(formatAmountOut(raw, 0)).toBe(raw);
  });

  it("returns an em dash when amountOut or decimals is unknown", () => {
    expect(formatAmountOut(undefined, 18)).toBe("—");
    expect(formatAmountOut("1", undefined)).toBe("—");
  });
});

describe("formatExecutionPrice / formatImpactPercent — exact rational formatting", () => {
  it("formats an execution price rational", () => {
    expect(formatExecutionPrice({ numerator: "1", denominator: "2" })).toBe("0.5");
  });

  it("returns an em dash when the rational is absent", () => {
    expect(formatExecutionPrice(undefined)).toBe("—");
    expect(formatImpactPercent(undefined)).toBe("—");
  });

  it("converts bps to a signed percent without inverting sign based on buy/sell intuition", () => {
    expect(formatImpactPercent({ numerator: "3", denominator: "1" })).toBe("+0.03%");
    expect(formatImpactPercent({ numerator: "-2", denominator: "1" })).toBe("-0.02%");
  });

  it("renders an exact zero impact as '0', not '+0' or '-0'", () => {
    expect(formatImpactPercent({ numerator: "0", denominator: "1" })).toBe("0");
  });
});

describe("formatGroupLabel", () => {
  it("labels the native ETH sentinel as 'ETH'", () => {
    expect(formatGroupLabel("NATIVE_ETH", undefined)).toBe("ETH");
  });

  it("prefers the verified tokenOutSymbol when present", () => {
    expect(formatGroupLabel(POOL_A, "WETH")).toBe("WETH");
  });

  it("falls back to a shortened address when no symbol is known", () => {
    expect(formatGroupLabel(POOL_A, undefined)).toBe(`${POOL_A.slice(0, 6)}…${POOL_A.slice(-4)}`);
  });
});

describe("live-payload regression — USDG (tokenOutDecimals=6) presentation (2026-09-01 manual browser validation)", () => {
  // Exact values from a real POST /api/assets/NVDA/execution/compare
  // response for tokenOut=USDG (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168),
  // amountIn=1000 NVDA — proves the presentation layer renders a fully
  // valid QUOTED candidate's amountOut/executionPrice/priceImpactBps
  // instead of "—", given a well-formed response.
  it("1. renders a valid amountOut with tokenOutDecimals=6, not an em dash", () => {
    expect(formatAmountOut("216922828056", 6)).toBe("216922.828056");
  });

  it("2. renders a valid executionPrice rational as a non-empty exact value, not an em dash", () => {
    const result = formatExecutionPrice({ numerator: "216922828056000000000000000000", denominator: "1000000000000000000000000000" });
    expect(result).toBe("216.922828");
    expect(result).not.toBe("—");
  });

  it("3. renders a positive priceImpactBps rational as a non-empty signed percent, not an em dash", () => {
    const result = formatImpactPercent({ numerator: "19", denominator: "1" });
    expect(result).toBe("+0.19%");
    expect(result).not.toBe("—");
  });

  it("4. a valid QUOTED amountOut still displays when this candidate's own optional analytics (executionPrice/priceImpactBps) are unavailable", () => {
    const degradedCandidate = candidate({
      status: "QUOTED",
      analyticsStatus: "RPC_ERROR",
      amountOut: "216922828056",
      executionPrice: undefined,
      priceImpactBps: undefined,
    });
    expect(formatAmountOut(degradedCandidate.amountOut, 6)).toBe("216922.828056");
    expect(formatExecutionPrice(degradedCandidate.executionPrice)).toBe("—");
    expect(formatImpactPercent(degradedCandidate.priceImpactBps)).toBe("—");
  });

  it("5. tokenOutDecimals=0 is a valid, known decimals value, never treated as 'missing' by a truthiness check", () => {
    // decimals=0 is falsy in JS — formatAmountOut must branch on
    // `=== undefined`, never `!tokenOutDecimals`, or a real 0-decimals
    // token would incorrectly render "—" instead of its exact amount.
    expect(formatAmountOut("42", 0)).not.toBe("—");
    expect(formatAmountOut("42", 0)).toBe("42");
  });

  it("6. the amount-input label uses the canonical asset symbol, never the tokenIn contract address", () => {
    expect(amountInLabel("NVDA")).toBe("Amount in (NVDA)");
    expect(amountInLabel("NVDA")).not.toContain("0x");
  });
});

describe("sharedAnalyticsUnavailableNote", () => {
  it("returns undefined when the shared decimals/analytics read succeeded", () => {
    expect(sharedAnalyticsUnavailableNote("OK")).toBeUndefined();
  });

  it("returns a non-empty explanatory note for RPC_ERROR, distinguishing a transient read gap from an ordinary missing value", () => {
    const note = sharedAnalyticsUnavailableNote("RPC_ERROR");
    expect(note).toBeDefined();
    expect(note!.length).toBeGreaterThan(0);
  });

  it("returns a non-empty explanatory note for INDETERMINATE", () => {
    const note = sharedAnalyticsUnavailableNote("INDETERMINATE");
    expect(note).toBeDefined();
    expect(note!.length).toBeGreaterThan(0);
  });
});
