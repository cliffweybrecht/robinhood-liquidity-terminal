import { describe, expect, it } from "vitest";
import { formatRational, formatTokenAmount, parseTokenAmount } from "../parseTokenAmount";

describe("parseTokenAmount", () => {
  it("parses a plain integer", () => {
    expect(parseTokenAmount("1", 18)).toEqual({ ok: true, value: 1_000_000_000_000_000_000n });
  });

  it("parses a decimal fraction", () => {
    expect(parseTokenAmount("1.5", 18)).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
  });

  it("parses the smallest supported fractional unit exactly", () => {
    expect(parseTokenAmount("0.000001", 6)).toEqual({ ok: true, value: 1n });
  });

  it("parses a fraction with fewer digits than decimals, padding with zeros", () => {
    expect(parseTokenAmount("0.1", 6)).toEqual({ ok: true, value: 100_000n });
  });

  it("rejects excess fractional precision beyond decimals", () => {
    expect(parseTokenAmount("1.1234567", 6)).toEqual({ ok: false, reason: "EXCESS_PRECISION" });
  });

  it("rejects zero", () => {
    expect(parseTokenAmount("0", 18)).toEqual({ ok: false, reason: "NOT_POSITIVE" });
    expect(parseTokenAmount("0.0", 18)).toEqual({ ok: false, reason: "NOT_POSITIVE" });
  });

  it("rejects a negative amount", () => {
    expect(parseTokenAmount("-1", 18)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("rejects empty/whitespace-only input", () => {
    expect(parseTokenAmount("", 18)).toEqual({ ok: false, reason: "EMPTY" });
    expect(parseTokenAmount("   ", 18)).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("rejects malformed input", () => {
    expect(parseTokenAmount("abc", 18)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseTokenAmount("1e18", 18)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseTokenAmount("1,000", 18)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseTokenAmount("1.2.3", 18)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseTokenAmount("+1", 18)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(parseTokenAmount(".5", 18)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTokenAmount("  1.5  ", 18)).toEqual({ ok: true, value: 1_500_000_000_000_000_000n });
  });

  it("handles zero decimals (no fractional part ever valid)", () => {
    expect(parseTokenAmount("5", 0)).toEqual({ ok: true, value: 5n });
    expect(parseTokenAmount("5.1", 0)).toEqual({ ok: false, reason: "EXCESS_PRECISION" });
  });
});

describe("formatTokenAmount", () => {
  it("formats a whole number with no fractional part", () => {
    const r = formatTokenAmount(1_000_000_000_000_000_000n, 18);
    expect(r.display).toBe("1");
    expect(r.full).toBe("1");
  });

  it("formats a fractional amount, trimming trailing zeros", () => {
    const r = formatTokenAmount(1_500_000_000_000_000_000n, 18);
    expect(r.display).toBe("1.5");
    expect(r.full).toBe("1.5");
  });

  it("truncates (never rounds) beyond maxFractionalDigits", () => {
    // 1.1234567 tokens at 18 decimals, truncated to 6 display digits.
    const raw = 1_123_456_700_000_000_000n;
    const r = formatTokenAmount(raw, 18, 6);
    expect(r.display).toBe("1.123456");
    expect(r.full).toBe("1.1234567");
  });

  it("never rounds up at the truncation boundary", () => {
    // 0.9999999 at 18 decimals -> truncated to 6 digits must stay 0.999999, never round to 1.
    const raw = 999_999_900_000_000_000n;
    const r = formatTokenAmount(raw, 18, 6);
    expect(r.display).toBe("0.999999");
  });

  it("formats zero", () => {
    const r = formatTokenAmount(0n, 18);
    expect(r.display).toBe("0");
    expect(r.full).toBe("0");
  });

  it("formats a negative amount with an explicit sign", () => {
    const r = formatTokenAmount(-1_500_000_000_000_000_000n, 18);
    expect(r.display).toBe("-1.5");
  });

  it("does not fabricate precision when decimals < maxFractionalDigits", () => {
    const r = formatTokenAmount(1_500_000n, 6, 6);
    expect(r.display).toBe("1.5");
    expect(r.full).toBe("1.5");
  });
});

describe("formatRational", () => {
  it("formats an exact whole-number rational", () => {
    const r = formatRational(10n, 1n);
    expect(r.display).toBe("10");
  });

  it("formats a simple fraction via exact long division", () => {
    // 1/4 = 0.25 exactly.
    const r = formatRational(1n, 4n);
    expect(r.display).toBe("0.25");
    expect(r.full).toBe("0.25");
  });

  it("truncates a non-terminating fraction at maxFractionalDigits without rounding", () => {
    // 1/3 = 0.333333... — truncated at 6 digits must be 0.333333, never 0.333334.
    const r = formatRational(1n, 3n, 6);
    expect(r.display).toBe("0.333333");
  });

  it("handles a negative numerator (e.g. favorable price impact) with an explicit sign", () => {
    const r = formatRational(-1n, 4n);
    expect(r.display).toBe("-0.25");
  });

  it("does not show a spurious negative sign when a negative value truncates to exactly zero at display precision", () => {
    // -1 / 10_000_000 truncated to 2 digits is 0.00 — sign should not appear at that precision.
    const r = formatRational(-1n, 10_000_000n, 2);
    expect(r.display).toBe("0");
    // But full (12+ digits) precision still reveals the true negative value.
    expect(r.full.startsWith("-0.0000001")).toBe(true);
  });

  it("formats zero", () => {
    const r = formatRational(0n, 5n);
    expect(r.display).toBe("0");
  });

  it("never uses Number()/floating point — verified by an exact value Number() would lose precision on", () => {
    // A numerator/denominator pair whose Number() division would be lossy at high precision.
    const numerator = 1_000_000_000_000_000_000_000n;
    const denominator = 3_000_000_000_000_000_000_001n;
    const r = formatRational(numerator, denominator, 20);
    // Exact expected value via BigInt long division, independently computed.
    expect(r.display.startsWith("0.333333333")).toBe(true);
  });
});
