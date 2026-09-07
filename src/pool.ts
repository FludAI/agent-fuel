import { BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Swap as SwapEvent } from "../generated/WNewsUsdcPool/UniswapV3Pool";
import { MetricsSnapshot, Pool, Swap, Wallet } from "../generated/schema";

// Verified on-chain: token0 = USDC (6 decimals), token1 = wNEWS (18 decimals).
const POOL_ID = "0x2dd7792966535333bae2f063bdf179f1bed220a4";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WNEWS = "0xed14e4978938ab2b474cdda9213e3caa4edd76ba";
const FEE_TIER = 3000;
const CREATED_AT = 45499342;

const USDC_SCALE = BigDecimal.fromString("1000000"); // 1e6
const WNEWS_SCALE = BigDecimal.fromString("1000000000000000000"); // 1e18
// spot (USDC per wNEWS, human units) = 1e12 * 2^192 / sqrtPriceX96^2
const PRICE_NUMERATOR = BigDecimal.fromString(
  // 1e12 * 2^192
  "6277101735386680763835789423207666416102355444464034512896000000000000"
);
const CREDIBILITY_IMPACT_CAP_BPS = 500; // a sell "prints under 5%"

function loadPool(block: BigInt): Pool {
  let pool = Pool.load(POOL_ID);
  if (pool == null) {
    pool = new Pool(POOL_ID);
    pool.token0 = changetype<Bytes>(Bytes.fromHexString(USDC));
    pool.token1 = changetype<Bytes>(Bytes.fromHexString(WNEWS));
    pool.feeTier = FEE_TIER;
    pool.createdAtBlock = BigInt.fromI32(CREATED_AT);
    pool.swapCount = BigInt.zero();
    pool.lastSpot = BigDecimal.zero();
  }
  return pool;
}

function loadWallet(addr: string, block: BigInt): Wallet {
  let w = Wallet.load(addr);
  if (w == null) {
    w = new Wallet(addr);
    // Public subgraph: no wallet is ever classified here.
    w.ownerClass = "UNCLASSIFIED";
    w.swapCount = BigInt.zero();
    w.firstSeenBlock = block;
  }
  return w;
}

function spotFromSqrtPrice(sqrtPriceX96: BigInt): BigDecimal {
  let sq = sqrtPriceX96.times(sqrtPriceX96).toBigDecimal();
  if (sq.equals(BigDecimal.zero())) {
    return BigDecimal.zero();
  }
  return PRICE_NUMERATOR.div(sq);
}

export function handleSwap(event: SwapEvent): void {
  let pool = loadPool(event.block.number);
  pool.swapCount = pool.swapCount.plus(BigInt.fromI32(1));
  let poolPrevSpot = pool.lastSpot;

  let wallet = loadWallet(event.params.sender.toHexString(), event.block.number);
  wallet.swapCount = wallet.swapCount.plus(BigInt.fromI32(1));
  wallet.save();

  // amount0/amount1 are pool-perspective deltas: positive = into the pool.
  let usdcDelta = event.params.amount0.toBigDecimal().div(USDC_SCALE);
  let wnewsDelta = event.params.amount1.toBigDecimal().div(WNEWS_SCALE);
  let spotAfter = spotFromSqrtPrice(event.params.sqrtPriceX96);

  // Impact of this print: move vs the previous swap's spot, however long
  // ago it was (sparse pool: bucket-local comparison would zero most prints).
  let hour = event.block.timestamp.toI64() / 3600;
  let bucketId = hour.toString();
  let snap = MetricsSnapshot.load(bucketId);
  let prevSpot = poolPrevSpot.gt(BigDecimal.zero()) ? poolPrevSpot : spotAfter;

  let impactBps = 0;
  if (prevSpot.gt(BigDecimal.zero())) {
    let move = spotAfter.minus(prevSpot).div(prevSpot).times(BigDecimal.fromString("10000"));
    let moveStr = move.toString();
    let moveF = parseFloat(moveStr);
    impactBps = i32(Math.abs(moveF));
  }

  let swap = new Swap(event.transaction.hash.toHexString() + "-" + event.logIndex.toString());
  swap.timestamp = event.block.timestamp;
  swap.block = event.block.number;
  swap.sender = wallet.id;
  swap.recipient = event.params.recipient;
  swap.usdcDelta = usdcDelta;
  swap.wnewsDelta = wnewsDelta;
  swap.spotAfter = spotAfter;
  swap.printImpactBps = impactBps;
  swap.save();

  pool.lastSpot = spotAfter;
  pool.save();

  if (snap == null) {
    snap = new MetricsSnapshot(bucketId);
    snap.timestamp = BigInt.fromI64(hour * 3600);
    snap.spotHigh = spotAfter;
    snap.spotLow = spotAfter;
    snap.volumeUsdc = BigDecimal.zero();
    snap.swapCount = 0;
    snap.credibility = BigDecimal.zero();
    snap.maxSellImpactBps = 0;
  }
  snap.spot = spotAfter;
  if (spotAfter.gt(snap.spotHigh)) snap.spotHigh = spotAfter;
  if (spotAfter.lt(snap.spotLow)) snap.spotLow = spotAfter;
  let usdcAbs = usdcDelta.lt(BigDecimal.zero()) ? usdcDelta.neg() : usdcDelta;
  snap.volumeUsdc = snap.volumeUsdc.plus(usdcAbs);
  snap.swapCount = snap.swapCount + 1;

  // A sell of wNEWS = wNEWS into pool (wnewsDelta > 0), USDC out.
  // Credibility: largest sell notional this hour that printed under the cap.
  let isSell = wnewsDelta.gt(BigDecimal.zero());
  if (isSell) {
    if (impactBps > snap.maxSellImpactBps) snap.maxSellImpactBps = impactBps;
    if (impactBps < CREDIBILITY_IMPACT_CAP_BPS && usdcAbs.gt(snap.credibility)) {
      snap.credibility = usdcAbs;
    }
  }
  snap.save();
}
