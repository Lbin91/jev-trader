/**
 * Recent trade prints for a Kuru Spot v2 order book, via eth_getLogs on `TradesPacked`.
 *
 * Kuru's 15 Oct 2026 mainnet redeploy replaced the flat `Trade` event with packed records:
 *
 *   event TradesPacked(uint40 indexed accountId, address indexed executor, bytes32 clientOrderId,
 *                      uint24 effectiveTakerFeePps, address builder, uint24 builderFeePps,
 *                      bytes packedTrades)
 *
 * Each 64-byte record is two 256-bit words (verified against a live MON-USDC log; see
 * docs.kuru.io/indexing/order-book):
 *   word0: userId 255:216 · slotIdx 215:208 · makerFlags 207:200 · price 199:168 ·
 *          fillSize 167:72 · orderId 71:8 · operationIndex 7:0
 *   word1: updatedSize 255:160 · makerFeePps 159:136 · replacementSlot 135:128 · reserved · tradeId 63:0
 *
 * `makerFlags & 1` means the maker was buying, so the TAKER sold base (a print hit a bid).
 * Prices are pricePrecision-scaled; sizes are sizePrecision-scaled (base, pre-multiplier).
 *
 * In a dry run these prints also drive simulated maker fills (a taker crossing our resting
 * price would have taken us first). Live maker-fill detection needs the v2 account-id mapping
 * and is not wired up (live order placement is not ported either).
 */
import { rpc } from "./chain";
import { toFloat } from "./book";

export const TRADES_PACKED_SIG = "TradesPacked(uint40,address,bytes32,uint24,address,uint24,bytes)";
/** keccak256(TRADES_PACKED_SIG) — precomputed with ethers.utils.id. */
export const TRADES_PACKED_TOPIC0 = "0xd126230928993abffb76b037ac3715a8c9048d698c12fc0b17b0bc7647c81b79";

export interface TradePrint { block: number; price: number; size: number; side: "buy" | "sell" }

/** One of our resting orders got hit. `side` is OUR side (the maker's): a taker buy fills our ask, so side is "sell". */
export interface MakerFill { block: number; txHash: string; orderId: number; price: number; size: number; updatedSize: number; side: "buy" | "sell" }

export interface TradeSummary {
  count: number;
  buyMon: number;
  sellMon: number;
  /** taker buy volume minus taker sell volume (MON) */
  cvdMon: number;
  vwap: number | null;
  lastPrice: number | null;
  lastSide: "buy" | "sell" | null;
}

interface RawLog { blockNumber: string; logIndex: string; transactionHash: string; data: string; removed?: boolean }

const RING = 500;
const FIRST_LOOKBACK = 300;
/** rpc.monad.xyz rejects eth_getLogs spans > 100 blocks ("block range too large", -32602). */
const MAX_RANGE = 100;
/** Never replay more than this many blocks in one poll (10 sequential getLogs calls at MAX_RANGE). */
const MAX_CATCHUP = 1000;

export class TradeFeed {
  private readonly market: string;
  private readonly url: string;
  private readonly priceDec: number;
  private readonly sizeDec: number;
  private trades: TradePrint[] = [];
  private fresh: TradePrint[] = []; // appended since the last drainPrints()
  private inFlight = false;
  lastBlock = 0;

  /** `sizeDec`/`priceDec` = log10 of the market's size/pricePrecision (10 and 8 on MON-USDC v2). */
  constructor(opts: { market: string; url: string; sizeDec: number; priceDec?: number }) {
    this.market = opts.market;
    this.url = opts.url;
    this.priceDec = opts.priceDec ?? 8;
    this.sizeDec = opts.sizeDec;
  }

  /**
   * Fetch TradesPacked logs from lastBlock+1..block (first call: last 300 blocks) and append, in
   * chunks of MAX_RANGE. lastBlock advances per chunk, so a mid-way failure keeps what was fetched
   * and retries the rest next time. Never throws; drops the call if a poll is already in flight.
   */
  async poll(block: number): Promise<void> {
    if (this.inFlight) return;
    let from = this.lastBlock === 0 ? Math.max(1, block - FIRST_LOOKBACK + 1) : this.lastBlock + 1;
    if (from > block) return;
    if (block - from + 1 > MAX_CATCHUP) from = block - MAX_CATCHUP + 1;
    this.inFlight = true;
    try {
      while (from <= block) {
        const to = Math.min(block, from + MAX_RANGE - 1);
        const logs = await rpc<RawLog[]>("eth_getLogs", [{
          address: this.market,
          topics: [TRADES_PACKED_TOPIC0],
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        }], this.url);
        // getLogs returns in block/logIndex order; keep newest last.
        for (const log of logs) {
          if (log.removed) continue;
          for (const t of this.decode(log)) { this.trades.push(t); this.fresh.push(t); }
        }
        if (this.trades.length > RING) this.trades.splice(0, this.trades.length - RING);
        this.lastBlock = to;
        from = to + 1;
      }
    } catch {
      // lastBlock stays at the last fully fetched chunk; next poll retries from there
    } finally {
      this.inFlight = false;
    }
  }

  /** Every 64-byte record in one packed event is a fill on the tape (active or passive maker). */
  private decode(log: RawLog): TradePrint[] {
    const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
    if (data.length < 64 * 6) return []; // clientOrderId, fee, builder, fee, bytes offset+length, payload
    // (bytes32 clientOrderId, uint24 takerFeePps, address builder, uint24 builderFeePps, bytes packedTrades)
    const bytesOffset = Number(BigInt("0x" + data.slice(4 * 64, 5 * 64))); // static head is 4 words
    const at = bytesOffset * 2;
    const len = Number(BigInt("0x" + data.slice(at, at + 64)));
    const payload = data.slice(at + 64, at + 64 + len * 2);
    if (payload.length % 128 !== 0) return [];
    const block = parseInt(log.blockNumber, 16);
    const out: TradePrint[] = [];
    for (let i = 0; i * 128 < payload.length; i++) {
      const w0 = BigInt("0x" + payload.slice(i * 128, i * 128 + 64));
      const makerBuy = ((w0 >> 200n) & 1n) === 1n; // maker bought: the taker sold base
      const price = toFloat((w0 >> 168n) & 0xffffffffn, this.priceDec);
      const size = toFloat((w0 >> 72n) & ((1n << 96n) - 1n), this.sizeDec);
      if (size === 0) continue;
      out.push({ block, price, size, side: makerBuy ? "sell" : "buy" });
    }
    return out;
  }

  summary(lastBlocks: number, currentBlock: number): TradeSummary {
    const minBlock = currentBlock - lastBlocks;
    let count = 0, buyMon = 0, sellMon = 0, notional = 0;
    let lastPrice: number | null = null, lastSide: "buy" | "sell" | null = null;
    for (const t of this.trades) {
      if (t.block <= minBlock) continue;
      count++;
      if (t.side === "buy") buyMon += t.size; else sellMon += t.size;
      notional += t.size * t.price;
      lastPrice = t.price; lastSide = t.side;
    }
    const vol = buyMon + sellMon;
    return { count, buyMon, sellMon, cvdMon: buyMon - sellMon, vwap: vol > 0 ? notional / vol : null, lastPrice, lastSide };
  }

  /** Newest last. */
  recent(n: number): TradePrint[] {
    return this.trades.slice(-n);
  }

  /** Prints appended since the last call (oldest first). Used to simulate maker fills in a dry run. */
  drainPrints(): TradePrint[] {
    const out = this.fresh; this.fresh = []; return out;
  }

  /** Live maker fills are not detectable from v2 events without the account-id mapping; unused in a dry run. */
  drainFills(): MakerFill[] {
    return [];
  }
}
