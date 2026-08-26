import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  IdentityNotVerifiedError,
  MissingIdentityBlockError,
  PoolIdentityMismatchError,
  UnexpectedPoolStateIdentifierShapeError,
  UnsupportedIdentityFamilyError,
} from "../errors";
import { readVerifiedUniswapV4PoolState } from "../read-uniswap-v4-state";
import {
  buildFakeRpc,
  IDENTITY_BLOCK,
  OTHER_POOL_ADDRESS,
  oversizedWord,
  POOL_ADDRESS,
  slot0V4Return,
  STATE_BLOCK,
  verifiedV3Identity,
  verifiedV4Identity,
} from "./fixtures";

describe("readVerifiedUniswapV4PoolState — precondition", () => {
  it("accepts a VERIFIED UNISWAP_V4 identity and proceeds to state RPC", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc();

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(calls.callCalls.length).toBeGreaterThan(0);
  });

  it("throws IdentityNotVerifiedError for a non-VERIFIED identity, before any state RPC call", async () => {
    const { pool, identity } = verifiedV4Identity({}, { status: "CONTRADICTED" });
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV4PoolState({ pool, identity, rpc })).rejects.toThrow(IdentityNotVerifiedError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnsupportedIdentityFamilyError for a VERIFIED UNISWAP_V3 identity, before any state RPC call", async () => {
    const { pool, identity } = verifiedV3Identity();
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV4PoolState({ pool, identity, rpc })).rejects.toThrow(UnsupportedIdentityFamilyError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws PoolIdentityMismatchError when identity.pool doesn't match the supplied pool, before any state RPC call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const mismatched = { ...pool, pairAddress: OTHER_POOL_ADDRESS };
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV4PoolState({ pool: mismatched, identity, rpc })).rejects.toThrow(PoolIdentityMismatchError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws MissingIdentityBlockError for a VERIFIED identity with a null blockNumber (defensive — unreachable via the real identity verifier)", async () => {
    const { pool, identity } = verifiedV4Identity({}, { blockNumber: null });
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV4PoolState({ pool, identity, rpc })).rejects.toThrow(MissingIdentityBlockError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });

  it("throws UnexpectedPoolStateIdentifierShapeError for a VERIFIED UNISWAP_V4 identity with a 20-byte pairAddress (defensive — unreachable via the real identity verifier)", async () => {
    const { pool, identity } = verifiedV4Identity({ pairAddress: POOL_ADDRESS });
    const { rpc, calls } = buildFakeRpc();

    await expect(readVerifiedUniswapV4PoolState({ pool, identity, rpc })).rejects.toThrow(UnexpectedPoolStateIdentifierShapeError);
    expect(calls.getBlockNumberCalls).toBe(0);
    expect(calls.callCalls).toHaveLength(0);
  });
});

describe("readVerifiedUniswapV4PoolState — block pinning", () => {
  it("calls getBlockNumber exactly once and pins both state reads to that exact block", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: async () => 999888n });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(calls.getBlockNumberCalls).toBe(1);
    expect(result.stateBlockNumber).toBe(999888n);
    expect(calls.callCalls.length).toBe(2);
    for (const c of calls.callCalls) expect(c.blockTag).toBe(999888n);
  });

  it("returns RPC_ERROR with a null stateBlockNumber when getBlockNumber itself fails, and never attempts a state call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ getBlockNumber: { error: new Error("boom") } });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.stateBlockNumber).toBeNull();
    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.kind).toBe("BLOCK_PIN_FAILURE");
    expect(calls.callCalls).toHaveLength(0);
  });

  it("pins state reads to a NEW block distinct from the identity verification block", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.identityVerificationBlock).toBe(IDENTITY_BLOCK);
    expect(result.stateBlockNumber).toBe(STATE_BLOCK);
    expect(result.identityVerificationBlock).not.toBe(result.stateBlockNumber);
  });
});

describe("readVerifiedUniswapV4PoolState — VERIFIED happy path", () => {
  it("returns a fully populated, correctly-typed state snapshot", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.family).toBe("UNISWAP_V4");
    expect(result.state).toBeDefined();
    expect(result.state?.sqrtPriceX96).toBe(1n << 96n);
    expect(result.state?.tick).toBe(12345);
    expect(result.state?.activeLiquidity).toBe(123456789n);
    expect(result.state?.protocolFee).toBe(0);
    expect(result.state?.lpFee).toBe(3000);
    expect(result.evidence.map((e) => e.kind)).toEqual(["SLOT0_V4_READ", "ACTIVE_LIQUIDITY_READ"]);
    expect(result.evidence.every((e) => e.outcome === "ok")).toBe(true);
  });
});

describe("readVerifiedUniswapV4PoolState — RPC failures", () => {
  it("returns RPC_ERROR when getSlot0() fails", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: { error: new Error("transport down") } });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.state).toBeUndefined();
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("rpc_error");
  });

  it("returns RPC_ERROR when getLiquidity() fails", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ liquidityV4: { error: new Error("transport down") } });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("RPC_ERROR");
    expect(result.evidence.find((e) => e.kind === "ACTIVE_LIQUIDITY_READ")?.outcome).toBe("rpc_error");
  });

  it("still fires both independent state reads even when one fails (matches the repo's established concurrent-read behavior)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc, calls } = buildFakeRpc({ slot0V4: { error: new Error("transport down") } });

    await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(calls.callCalls).toHaveLength(2);
  });
});

describe("readVerifiedUniswapV4PoolState — ABI / structural malformation", () => {
  it("returns INDETERMINATE for malformed (non-hex) getSlot0 data", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: "not-hex-at-all" as Hex });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for a truncated getSlot0 return (fewer than 4 words)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const full = slot0V4Return();
    const truncated = full.slice(0, full.length - 64) as Hex;
    const { rpc } = buildFakeRpc({ slot0V4: truncated });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for an oversized getSlot0 return (more than 4 words)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const oversized = (slot0V4Return() + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ slot0V4: oversized });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when sqrtPriceX96's high bits exceed uint160", async () => {
    const { pool, identity } = verifiedV4Identity();
    const dirty = (`0x${oversizedWord()}` + slot0V4Return().slice(2 + 64)) as Hex;
    const { rpc } = buildFakeRpc({ slot0V4: dirty });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE for a malformed (non-sign-extended) int24 tick", async () => {
    const { pool, identity } = verifiedV4Identity();
    const badTickWord = `1${"0".repeat(63)}`; // a large positive value, not a valid sign-extended int24
    const base = slot0V4Return();
    const malformed = (base.slice(0, 2 + 64) + badTickWord + base.slice(2 + 128)) as Hex;
    const { rpc } = buildFakeRpc({ slot0V4: malformed });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when protocolFee exceeds uint24", async () => {
    const { pool, identity } = verifiedV4Identity();
    const base = slot0V4Return();
    const malformed = (base.slice(0, 2 + 128) + oversizedWord() + base.slice(2 + 192)) as Hex;
    const { rpc } = buildFakeRpc({ slot0V4: malformed });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when lpFee exceeds uint24", async () => {
    const { pool, identity } = verifiedV4Identity();
    const base = slot0V4Return();
    const malformed = (base.slice(0, 2 + 192) + oversizedWord()) as Hex;
    const { rpc } = buildFakeRpc({ slot0V4: malformed });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "SLOT0_V4_READ")?.outcome).toBe("decode_error");
  });

  it("returns INDETERMINATE when liquidity() exceeds uint128", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ liquidityV4: `0x${oversizedWord()}` as Hex });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.evidence.find((e) => e.kind === "ACTIVE_LIQUIDITY_READ")?.outcome).toBe("decode_error");
  });

  it("accepts a valid negative tick", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ tick: -12345 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.state?.tick).toBe(-12345);
  });
});

describe("readVerifiedUniswapV4PoolState — semantic validation", () => {
  it("returns INDETERMINATE (not VERIFIED, not CONTRADICTED) when sqrtPriceX96 === 0 despite a structurally clean decode", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ sqrtPriceX96: 0n }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.state).toBeUndefined();
    const slot0Evidence = result.evidence.find((e) => e.kind === "SLOT0_V4_READ");
    expect(slot0Evidence?.outcome).toBe("semantic_error");
    expect(slot0Evidence?.detail).toMatch(/zero/i);
  });

  it("accepts lpFee at exactly the canonical MAX_LP_FEE bound (1_000_000)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ lpFee: 1_000_000 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.state?.lpFee).toBe(1_000_000);
  });

  it("returns INDETERMINATE with semantic_error when lpFee exceeds the canonical MAX_LP_FEE bound (1_000_001)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ lpFee: 1_000_001 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.state).toBeUndefined();
    const slot0Evidence = result.evidence.find((e) => e.kind === "SLOT0_V4_READ");
    expect(slot0Evidence?.outcome).toBe("semantic_error");
    expect(slot0Evidence?.detail).toMatch(/lpFee/);
  });

  it("accepts a packed protocolFee whose zero-for-one component is exactly at the canonical MAX_PROTOCOL_FEE bound (1000)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ protocolFee: 1000 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.state?.protocolFee).toBe(1000);
  });

  it("returns INDETERMINATE with semantic_error when protocolFee's zero-for-one component exceeds the canonical MAX_PROTOCOL_FEE bound (1001)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ protocolFee: 1001 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.state).toBeUndefined();
    const slot0Evidence = result.evidence.find((e) => e.kind === "SLOT0_V4_READ");
    expect(slot0Evidence?.outcome).toBe("semantic_error");
    expect(slot0Evidence?.detail).toMatch(/zero-for-one/);
  });

  it("accepts a packed protocolFee whose one-for-zero component is exactly at the canonical MAX_PROTOCOL_FEE bound (1000)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ protocolFee: 1000 << 12 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
    expect(result.state?.protocolFee).toBe(1000 << 12);
  });

  it("returns INDETERMINATE with semantic_error when protocolFee's one-for-zero component exceeds the canonical MAX_PROTOCOL_FEE bound (1001)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc({ slot0V4: slot0V4Return({ protocolFee: 1001 << 12 }) });

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("INDETERMINATE");
    expect(result.state).toBeUndefined();
    const slot0Evidence = result.evidence.find((e) => e.kind === "SLOT0_V4_READ");
    expect(slot0Evidence?.outcome).toBe("semantic_error");
    expect(slot0Evidence?.detail).toMatch(/one-for-zero/);
  });

  it("never exposes state for any semantically invalid fee case (lpFee and both protocolFee components)", async () => {
    const { pool, identity } = verifiedV4Identity();
    const cases = [
      slot0V4Return({ lpFee: 1_000_001 }),
      slot0V4Return({ protocolFee: 1001 }),
      slot0V4Return({ protocolFee: 1001 << 12 }),
    ];

    for (const slot0V4 of cases) {
      const { rpc } = buildFakeRpc({ slot0V4 });
      const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });
      expect(result.status).toBe("INDETERMINATE");
      expect(result.state).toBeUndefined();
    }
  });
});

describe("readVerifiedUniswapV4PoolState — semantics", () => {
  it("names the concentrated-liquidity field activeLiquidity, never total/executable/TVL terminology, and exposes exactly the 5 required fields", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.state).toBeDefined();
    const keys = Object.keys(result.state ?? {});
    expect(keys).toEqual(["sqrtPriceX96", "tick", "activeLiquidity", "protocolFee", "lpFee"]);
    expect(keys).not.toContain("totalLiquidity");
    expect(keys).not.toContain("executableLiquidity");
    expect(keys).not.toContain("tvl");
    expect(keys).not.toContain("tickSpacing");
    expect(keys).not.toContain("hooks");
  });
});

describe("readVerifiedUniswapV4PoolState — no getCode/getLogs usage", () => {
  it("never calls eth_getCode or eth_getLogs — only eth_blockNumber and eth_call", async () => {
    const { pool, identity } = verifiedV4Identity();
    const { rpc } = buildFakeRpc();

    // buildFakeRpc's getCode/getLogs stubs throw immediately if invoked —
    // a successful full run proves neither was called.
    const result = await readVerifiedUniswapV4PoolState({ pool, identity, rpc });

    expect(result.status).toBe("VERIFIED");
  });
});
