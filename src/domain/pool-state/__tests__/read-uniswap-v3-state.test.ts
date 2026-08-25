import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  IdentityNotVerifiedError,
  MissingIdentityBlockError,
  PoolIdentityMismatchError,
  UnexpectedPoolStateIdentifierShapeError,
  UnsupportedIdentityFamilyError,
} from "../errors";
import { readVerifiedUniswapV3PoolState } from "../read-uniswap-v3-state";
import {
  buildFakeRpc,
  IDENTITY_BLOCK,
  OTHER_POOL_ADDRESS,
  oversizedWord,
  slot0Return,
  STATE_BLOCK,
  tickSpacingReturn,
  V4_POOL_ID,
  verifiedV3Identity,
} from "./fixtures";

describe("readVerifiedUniswapV3PoolState — precondition", () => {
  it("accepts a VERIFIED UNISWAP_V3 identity and proceeds to state RPC", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(calls.callCalls.length).toBeGreaterThan(0);
  });

  it("throws IdentityNotVerifiedError for a non-VERIFIED identity, before any state RPC call", async () => {
    const { pool, identity } = verifiedV3Identity({}, { status: "CONTRADICTED" });
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV3PoolState({ pool, identity, rpc })).rejects.toThrow(IdentityNotVerifiedError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnsupportedIdentityFamilyError for a VERIFIED UNISWAP_V4 identity, before any state RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const v4Identity = { ...identity, family: "UNISWAP_V4" as const };
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV3PoolState({ pool, identity: v4Identity, rpc })).rejects.toThrow(UnsupportedIdentityFamilyError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws PoolIdentityMismatchError when identity.pool doesn't match the supplied pool, before any state RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const mismatched = { ...pool, pairAddress: OTHER_POOL_ADDRESS };
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV3PoolState({ pool: mismatched, identity, rpc })).rejects.toThrow(PoolIdentityMismatchError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnexpectedPoolStateIdentifierShapeError for a VERIFIED UNISWAP_V3 identity with a 32-byte pairAddress (defensive — unreachable via the real identity verifier)", async () => {
    const { pool, identity } = verifiedV3Identity({ pairAddress: V4_POOL_ID });
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV3PoolState({ pool, identity, rpc })).rejects.toThrow(UnexpectedPoolStateIdentifierShapeError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingIdentityBlockError for a VERIFIED identity with a null blockNumber (defensive — unreachable via the real identity verifier)", async () => {
    const { pool, identity } = verifiedV3Identity({}, { blockNumber: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV3PoolState({ pool, identity, rpc })).rejects.toThrow(MissingIdentityBlockError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("readVerifiedUniswapV3PoolState — block pinning", () => {
  it("calls getBlockNumber exactly once and pins every state read to that exact block", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 999888n });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.stateBlockNumber).toBe(999888n);
    expect(calls.callCalls.length).toBe(4);
    for (const c of calls.callCalls) expect(c.blockTag).toBe(999888n);
  });

  it("returns RPC_ERROR with a null stateBlockNumber when getBlockNumber itself fails, and never attempts a state call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.stateBlockNumber).toBeNull();
    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("BLOCK_PIN_FAILURE");
    expect(calls.callCalls).toHaveLength(0);
  });

  it("pins state reads to a NEW block distinct from the identity verification block", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.stateBlockNumber).toBe(STATE_BLOCK);
    expect(result.identityVerificationBlock).not.toBe(result.stateBlockNumber);
  });
});

describe("readVerifiedUniswapV3PoolState — VERIFIED happy path", () => {
  it("returns a fully populated, correctly-typed state snapshot", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.family).toBe("UNISWAP_V3");
    expect(result.state).toBeDefined();
    expect(result.state?.sqrtPriceX96).toBe(1n << 96n);
    expect(result.state?.tick).toBe(12345);
    expect(result.state?.activeLiquidity).toBe(123456789n);
    expect(result.state?.fee).toBe(3000);
    expect(result.state?.tickSpacing).toBe(60);
    expect(result.evidence.map((e) => e.kind)).toEqual(["SLOT0_READ", "ACTIVE_LIQUIDITY_READ", "FEE_READ", "TICK_SPACING_READ"]);
    expect(result.evidence.every((e) => e.outcome === "ok")).toBe(true);
  });
});

describe("readVerifiedUniswapV3PoolState — RPC failures", () => {
  it("returns RPC_ERROR when slot0() fails", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ slot0: { error: new Error("transport down") } });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.state).toBeUndefined();
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("rpc_error");
  });

  it("returns RPC_ERROR when liquidity() fails", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ liquidity: { error: new Error("transport down") } });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "ACTIVE_LIQUIDITY_READ")?.outcome).toBe("rpc_error");
  });

  it("returns RPC_ERROR when fee() fails", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ fee: { error: new Error("transport down") } });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "FEE_READ")?.outcome).toBe("rpc_error");
  });

  it("returns RPC_ERROR when tickSpacing() fails", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ tickSpacing: { error: new Error("transport down") } });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "TICK_SPACING_READ")?.outcome).toBe("rpc_error");
  });

  it("still fires all 4 independent state reads even when one fails (matches the repo's established concurrent-read behavior — see strategies/uniswap-v3.ts)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc({ slot0: { error: new Error("transport down") } });

    await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(calls.callCalls).toHaveLength(4);
  });
});

describe("readVerifiedUniswapV3PoolState — ABI / structural malformation", () => {
  it("returns INDETERMINATE for malformed (non-hex) slot0 data", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ slot0: "not-hex-at-all" as Hex });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for a truncated slot0 return (fewer than 7 words)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const full = slot0Return();
    const truncated = full.slice(0, full.length - 64) as Hex;
    const { rpc } = buildFakeRpc({ slot0: truncated });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for an oversized slot0 return (more than 7 words)", async () => {
    const { pool, identity } = verifiedV3Identity();
    const oversized = (slot0Return() + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ slot0: oversized });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when sqrtPriceX96's high bits exceed uint160", async () => {
    const { pool, identity } = verifiedV3Identity();
    const dirty = (`0x${oversizedWord()}` + slot0Return().slice(2 + 64)) as Hex;
    const { rpc } = buildFakeRpc({ slot0: dirty });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for a malformed (non-sign-extended) int24 tick", async () => {
    const { pool, identity } = verifiedV3Identity();
    const badTickWord = `1${"0".repeat(63)}`; // a large positive value, not a valid sign-extended int24
    const base = slot0Return();
    const malformed = (base.slice(0, 2 + 64) + badTickWord + base.slice(2 + 128)) as Hex;
    const { rpc } = buildFakeRpc({ slot0: malformed });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when observationIndex exceeds uint16", async () => {
    const { pool, identity } = verifiedV3Identity();
    const base = slot0Return();
    const malformed = (base.slice(0, 2 + 128) + oversizedWord() + base.slice(2 + 192)) as Hex;
    const { rpc } = buildFakeRpc({ slot0: malformed });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when feeProtocol exceeds uint8", async () => {
    const { pool, identity } = verifiedV3Identity();
    const base = slot0Return();
    const malformed = (base.slice(0, 2 + 320) + oversizedWord() + base.slice(2 + 384)) as Hex;
    const { rpc } = buildFakeRpc({ slot0: malformed });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when unlocked (bool) is neither 0 nor 1", async () => {
    const { pool, identity } = verifiedV3Identity();
    const base = slot0Return();
    const malformed = (base.slice(0, 2 + 384) + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ slot0: malformed });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when liquidity() exceeds uint128", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ liquidity: `0x${oversizedWord()}` as Hex });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "ACTIVE_LIQUIDITY_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when fee() exceeds uint24", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ fee: `0x${oversizedWord()}` as Hex });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "FEE_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for a malformed (non-sign-extended) tickSpacing", async () => {
    const { pool, identity } = verifiedV3Identity();
    const badWord = `0x1${"0".repeat(63)}` as Hex; // large positive value, not a valid sign-extended int24
    const { rpc } = buildFakeRpc({ tickSpacing: badWord });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "TICK_SPACING_READ")?.outcome).toBe("decode_error");
  });

  it("accepts a valid negative tickSpacing", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ tickSpacing: tickSpacingReturn(-60) });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.state?.tickSpacing).toBe(-60);
  });

  it("accepts a valid negative tick", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc({ slot0: slot0Return({ tick: -12345 }) });

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.state?.tick).toBe(-12345);
  });
});

describe("readVerifiedUniswapV3PoolState — semantics", () => {
  it("names the concentrated-liquidity field activeLiquidity, never total/executable/TVL terminology", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.state).toBeDefined();
    const keys = Object.keys(result.state ?? {});
    expect(keys).toEqual(["sqrtPriceX96", "tick", "activeLiquidity", "fee", "tickSpacing"]);
    expect(keys).not.toContain("totalLiquidity");
    expect(keys).not.toContain("executableLiquidity");
    expect(keys).not.toContain("tvl");
  });
});

describe("readVerifiedUniswapV3PoolState — no getCode/getLogs usage", () => {
  it("never calls eth_getCode or eth_getLogs — only eth_blockNumber and eth_call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc } = buildFakeRpc();

    // buildFakeRpc's getCode/getLogs stubs throw immediately if invoked —
    // a successful full run proves neither was called.
    const result = await readVerifiedUniswapV3PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
  });
});
