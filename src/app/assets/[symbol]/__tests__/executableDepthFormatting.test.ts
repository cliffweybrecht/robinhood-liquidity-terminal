import { describe, expect, it } from "vitest";
import type {
  DepthThresholdCellDto,
  DepthThresholdOutcomeDto,
  DepthThresholdPoolResultDto,
  ExecutionSummaryUnknownReason,
  VenueParticipationStatus,
  VenueTransitionKind,
} from "@/domain/execution-comparison";
import {
  bestVenueText,
  depthCellStatusCopy,
  isPoolPreconditionFailed,
  monotonicityCautionText,
  poolPreconditionDetail,
  thresholdLabel,
  thresholdOutcomeText,
  unknownReasonText,
  venueDispositionText,
  venueTransitionText,
} from "../executableDepthFormatting";

const POOL_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BLOCK = "53049052";
const SYMBOL = "NVDA";
const DECIMALS = 18;

function cell(overrides: Partial<DepthThresholdCellDto> = {}): DepthThresholdCellDto {
  return { amountIn: "1000000000000000000", status: "QUOTED", analyticsStatus: "OK", ...overrides };
}

function pool(overrides: Partial<DepthThresholdPoolResultDto> = {}): DepthThresholdPoolResultDto {
  return { pairAddress: POOL_A, dexId: "uniswap", family: "UNISWAP_V3", status: "EXECUTABLE", ladder: [cell()], outcomesByThreshold: [], ...overrides };
}

describe("thresholdLabel", () => {
  it("maps the four frozen thresholds exactly", () => {
    expect(thresholdLabel(50)).toBe("0.5%");
    expect(thresholdLabel(100)).toBe("1%");
    expect(thresholdLabel(200)).toBe("2%");
    expect(thresholdLabel(500)).toBe("5%");
  });
});

describe("depthCellStatusCopy — reuses the real statusCopy via a real ExecutionCandidateDto-shaped adapter", () => {
  it("produces the exact same copy statusCopy already produces for a single comparison", () => {
    expect(depthCellStatusCopy(pool(), cell({ status: "QUOTED" }))).toBe("Quoted");
    expect(depthCellStatusCopy(pool(), cell({ status: "RPC_ERROR" }))).toBe("RPC error");
    expect(depthCellStatusCopy(pool(), cell({ status: "INDETERMINATE" }))).toBe("Could not determine");
  });

  it("produces the exact hooked-precondition copy, never a generic 'Error'", () => {
    const failed = cell({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "x" } });
    expect(depthCellStatusCopy(pool(), failed)).toBe("Hook parameters unsupported");
  });

  it("produces the exact V4 uint128-bound copy for a per-cell precondition failure", () => {
    const failed = cell({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "AMOUNT_IN_EXCEEDS_V4_BOUND", detail: "x" } });
    expect(depthCellStatusCopy(pool(), failed)).toBe("Amount exceeds quote bound");
  });
});

describe("isPoolPreconditionFailed / poolPreconditionDetail", () => {
  it("is true only when status === PRECONDITION_FAILED", () => {
    expect(isPoolPreconditionFailed(pool({ status: "EXECUTABLE" }))).toBe(false);
    expect(isPoolPreconditionFailed(pool({ status: "PRECONDITION_FAILED" }))).toBe(true);
  });

  it("returns the exact hooked-precondition detail copy keyed off the pool's own code", () => {
    const failedPool = pool({ status: "PRECONDITION_FAILED", preconditionFailure: { code: "MISSING_HOOK_DATA", detail: "raw detail" } });
    expect(poolPreconditionDetail(failedPool)).toBe("This pool uses custom hook parameters that this app cannot safely construct yet.");
  });

  it("returns undefined for an executable pool", () => {
    expect(poolPreconditionDetail(pool({ status: "EXECUTABLE" }))).toBeUndefined();
  });
});

describe("thresholdOutcomeText — the six frozen product-copy variants (Revision 2, section 18)", () => {
  it("CLEAN BRACKET", () => {
    const outcome: DepthThresholdOutcomeDto = {
      thresholdBps: 100,
      kind: "WITHIN_THRESHOLD",
      qualifyingAmountIn: "100000000000000000000", // 100 NVDA
      monotonicityObserved: true,
      upperRange: { kind: "CLEAN_CEILING", nextMeasuredAmountIn: "250000000000000000000" }, // 250 NVDA
    };
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(
      `At least 100 NVDA was executable within 1% impact at block ${BLOCK}. The next tested size, 250 NVDA, exceeded 1% impact.`,
    );
  });

  it("GAPPED BRACKET, measured ceiling", () => {
    const outcome: DepthThresholdOutcomeDto = {
      thresholdBps: 100,
      kind: "WITHIN_THRESHOLD",
      qualifyingAmountIn: "100000000000000000000",
      monotonicityObserved: true,
      upperRange: { kind: "GAPPED_CEILING", nextMeasuredAmountIn: "500000000000000000000" }, // 500 NVDA
    };
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(
      `At least 100 NVDA was executable within 1% impact at block ${BLOCK}. One or more larger tested sizes could not be determined; 500 NVDA was measured above 1% impact.`,
    );
    // NEVER the misleading claim the frozen correction explicitly forbids.
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).not.toContain("The next tested size, 500 NVDA, exceeded");
  });

  it("GAPPED BRACKET, no measured ceiling", () => {
    const outcome: DepthThresholdOutcomeDto = {
      thresholdBps: 100,
      kind: "WITHIN_THRESHOLD",
      qualifyingAmountIn: "100000000000000000000",
      monotonicityObserved: true,
      upperRange: { kind: "GAPPED_NO_CEILING" },
    };
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(
      `At least 100 NVDA was executable within 1% impact at block ${BLOCK}. One or more larger tested sizes could not be determined; no larger size was successfully measured.`,
    );
  });

  it("OPEN UPPER RANGE — never implies the pool's true capacity ends at the qualifying value", () => {
    const outcome: DepthThresholdOutcomeDto = {
      thresholdBps: 100,
      kind: "WITHIN_THRESHOLD",
      qualifyingAmountIn: "5000000000000000000000", // 5000 NVDA
      monotonicityObserved: true,
      upperRange: { kind: "OPEN" },
    };
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(
      `At least 5000 NVDA was executable within 1% impact at block ${BLOCK}. No larger size was tested.`,
    );
  });

  it("SMALLEST EXCEEDS — uses the smallest MEASURED sample, never assumed to be the literal 1-unit request", () => {
    const outcome: DepthThresholdOutcomeDto = { thresholdBps: 500, kind: "EXCEEDED_AT_SMALLEST_SAMPLE", smallestMeasuredAmountIn: "2000000000000000000" }; // 2 NVDA
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(`The smallest tested size, 2 NVDA, exceeded 5% impact at block ${BLOCK}.`);
  });

  it("ANALYTICS UNAVAILABLE", () => {
    const outcome: DepthThresholdOutcomeDto = { thresholdBps: 100, kind: "ANALYTICS_UNAVAILABLE" };
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(`Price-impact could not be computed for this pool at block ${BLOCK}.`);
  });

  it("ZERO QUOTED SAMPLES", () => {
    const outcome: DepthThresholdOutcomeDto = { thresholdBps: 100, kind: "NO_QUOTED_SAMPLES" };
    expect(thresholdOutcomeText(outcome, DECIMALS, BLOCK, SYMBOL)).toBe(`No executable quote could be obtained for this pool at block ${BLOCK}.`);
  });

  it("never claims exact/continuous depth language ('depth = X') in any variant", () => {
    const variants: DepthThresholdOutcomeDto[] = [
      { thresholdBps: 100, kind: "WITHIN_THRESHOLD", qualifyingAmountIn: "100000000000000000000", monotonicityObserved: true, upperRange: { kind: "OPEN" } },
      { thresholdBps: 100, kind: "EXCEEDED_AT_SMALLEST_SAMPLE", smallestMeasuredAmountIn: "1000000000000000000" },
      { thresholdBps: 100, kind: "ANALYTICS_UNAVAILABLE" },
      { thresholdBps: 100, kind: "NO_QUOTED_SAMPLES" },
    ];
    for (const v of variants) {
      const text = thresholdOutcomeText(v, DECIMALS, BLOCK, SYMBOL);
      expect(text.toLowerCase()).not.toMatch(/depth\s*=/);
    }
  });
});

describe("monotonicityCautionText", () => {
  it("returns undefined when monotonicityObserved is true", () => {
    const outcome: DepthThresholdOutcomeDto = {
      thresholdBps: 100,
      kind: "WITHIN_THRESHOLD",
      qualifyingAmountIn: "1",
      monotonicityObserved: true,
      upperRange: { kind: "OPEN" },
    };
    expect(monotonicityCautionText(outcome)).toBeUndefined();
  });

  it("returns undefined for a non-WITHIN_THRESHOLD outcome", () => {
    expect(monotonicityCautionText({ thresholdBps: 100, kind: "NO_QUOTED_SAMPLES" })).toBeUndefined();
  });

  it("returns the caution line, additive, when monotonicityObserved is false", () => {
    const outcome: DepthThresholdOutcomeDto = {
      thresholdBps: 100,
      kind: "WITHIN_THRESHOLD",
      qualifyingAmountIn: "1",
      monotonicityObserved: false,
      upperRange: { kind: "OPEN" },
    };
    expect(monotonicityCautionText(outcome)).toContain("not consistently improving");
  });
});

describe("bestVenueText", () => {
  it("renders an explicit 'no venue qualifies' message for an empty array, never a blank line", () => {
    expect(bestVenueText([])).toBe("No tested venue qualifies at this threshold.");
  });

  it("renders a single address shortened", () => {
    expect(bestVenueText([POOL_A])).toBe("0xaaaa…aaaa");
  });

  it("renders a tie as a joined list, preserving every tied address", () => {
    const text = bestVenueText([POOL_A, POOL_B]);
    expect(text).toContain("0xaaaa…aaaa");
    expect(text).toContain("0xbbbb…bbbb");
  });
});

describe("Phase 6G presentation copy — exhaustive mapping", () => {
  const ALL_VENUE_PARTICIPATION_STATUSES: readonly VenueParticipationStatus[] = ["PARTICIPATED", "PRECONDITION_FAILED", "NO_QUOTED_SAMPLES", "ANALYTICS_UNAVAILABLE"];
  const ALL_VENUE_TRANSITION_KINDS: readonly VenueTransitionKind[] = ["NO_DIFFERENCE", "WINNER_SET_DIFFERS", "SOLE_WINNER_CHANGED"];
  const ALL_UNKNOWN_REASONS: readonly ExecutionSummaryUnknownReason[] = [
    "CROSS_GROUP_COMPARISON_NOT_ATTEMPTED",
    "UNSAMPLED_TRADE_SIZES_UNKNOWN",
    "FUTURE_BLOCK_EXECUTION_UNKNOWN",
    "EXCLUDED_VENUES_NOT_COMPARED",
  ];

  it("venueDispositionText has a non-empty entry for every VenueParticipationStatus", () => {
    for (const status of ALL_VENUE_PARTICIPATION_STATUSES) {
      expect(venueDispositionText(status).length).toBeGreaterThan(0);
    }
  });

  it("venueTransitionText has a non-empty entry for every VenueTransitionKind, and never uses 'changed' for WINNER_SET_DIFFERS", () => {
    for (const kind of ALL_VENUE_TRANSITION_KINDS) {
      const text = venueTransitionText({ kind, fromThresholdBps: 50, toThresholdBps: 100 });
      expect(text.length).toBeGreaterThan(0);
    }
    const winnerSetDiffers = venueTransitionText({ kind: "WINNER_SET_DIFFERS", fromThresholdBps: 50, toThresholdBps: 100 });
    expect(winnerSetDiffers.toLowerCase()).not.toContain("changed");
    const soleWinnerChanged = venueTransitionText({ kind: "SOLE_WINNER_CHANGED", fromThresholdBps: 50, toThresholdBps: 100 });
    expect(soleWinnerChanged.toLowerCase()).toContain("changed");
  });

  it("venueTransitionText includes both threshold labels", () => {
    const text = venueTransitionText({ kind: "NO_DIFFERENCE", fromThresholdBps: 100, toThresholdBps: 200 });
    expect(text).toContain("1%");
    expect(text).toContain("2%");
  });

  it("unknownReasonText has a non-empty entry for every ExecutionSummaryUnknownReason", () => {
    for (const reason of ALL_UNKNOWN_REASONS) {
      expect(unknownReasonText(reason).length).toBeGreaterThan(0);
    }
  });

  it("no Phase 6G copy string ever claims continuous/exact depth or uses advisory/recommendation language", () => {
    const allCopy = [
      ...ALL_VENUE_PARTICIPATION_STATUSES.map(venueDispositionText),
      ...ALL_VENUE_TRANSITION_KINDS.map((kind) => venueTransitionText({ kind, fromThresholdBps: 50, toThresholdBps: 100 })),
      ...ALL_UNKNOWN_REASONS.map(unknownReasonText),
    ].join(" ").toLowerCase();
    expect(allCopy).not.toMatch(/should trade|recommend|you should|best choice for you/);
    // "continuous depth" legitimately appears once, but ONLY inside an explicit
    // disclaimer ("nothing about ... continuous depth ... is claimed") — the
    // real adversarial check is that it is never used to AFFIRM continuous/exact
    // depth (e.g. "shows continuous depth", "provides exact depth").
    expect(allCopy).not.toMatch(/(shows|provides|represents|is) (a )?(continuous|exact) depth/);
  });

  it("NEVER describes bestVenueByThreshold using 'best-priced'/'best price'/'best execution price' — bestVenueByThreshold names the sampled qualifying-depth leader(s), not a price/execution-quality claim", () => {
    const allCopy = [
      ...ALL_VENUE_PARTICIPATION_STATUSES.map(venueDispositionText),
      ...ALL_VENUE_TRANSITION_KINDS.map((kind) => venueTransitionText({ kind, fromThresholdBps: 50, toThresholdBps: 100 })),
      ...ALL_UNKNOWN_REASONS.map(unknownReasonText),
    ].join(" ").toLowerCase();
    expect(allCopy).not.toContain("best-priced");
    expect(allCopy).not.toContain("best price");
    expect(allCopy).not.toContain("best execution price");
    expect(allCopy).not.toContain("best-price");
  });

  it("uses the frozen 'sampled depth leader' vocabulary for venue-transition copy, precisely describing bestVenueByThreshold's own actual metric (greatest sampled qualifying depth, tie-preserved)", () => {
    const noDifference = venueTransitionText({ kind: "NO_DIFFERENCE", fromThresholdBps: 50, toThresholdBps: 100 });
    const winnerSetDiffers = venueTransitionText({ kind: "WINNER_SET_DIFFERS", fromThresholdBps: 50, toThresholdBps: 100 });
    const soleWinnerChanged = venueTransitionText({ kind: "SOLE_WINNER_CHANGED", fromThresholdBps: 50, toThresholdBps: 100 });
    expect(noDifference.toLowerCase()).toContain("sampled depth leader");
    expect(winnerSetDiffers.toLowerCase()).toContain("sampled depth leader");
    expect(soleWinnerChanged.toLowerCase()).toContain("sampled depth leader");
  });
});
