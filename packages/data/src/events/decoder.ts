import { BorshEventCoder } from "@coral-xyz/anchor";
import type { ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { NewLiquidityEvent, NewSwap } from "@agentic-dlmm/db";
import { dlmm, DLMM_PROGRAM_ID } from "../sdk.js";

/** Anchor event-CPI instruction tag (sha256("anchor:event")[0..8]). */
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

const coder = new BorshEventCoder(dlmm.IDL as never);

interface RawEvent {
  name: string;
  ordinal: number;
  data: Record<string, unknown>;
}

export interface DecodedTx {
  swaps: NewSwap[];
  liquidityEvents: NewLiquidityEvent[];
}

function asBigint(v: unknown): bigint {
  // anchor decodes u64/u128 as BN
  return BigInt((v as { toString(): string }).toString());
}

function asString(v: unknown): string {
  return (v as { toString(): string }).toString();
}

/** Extract every lb_clmm event from a parsed transaction's inner instructions. */
export function extractRawEvents(tx: ParsedTransactionWithMeta): RawEvent[] {
  const out: RawEvent[] = [];
  let ordinal = 0;
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (!("data" in ix)) continue; // parsed (system/token) instruction
      const pix = ix as PartiallyDecodedInstruction;
      if (pix.programId.toBase58() !== DLMM_PROGRAM_ID) continue;
      let data: Buffer;
      try {
        data = Buffer.from(bs58.decode(pix.data));
      } catch {
        continue;
      }
      if (data.length < 16 || !data.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
      const decoded = coder.decode(data.subarray(8).toString("base64"));
      if (!decoded) continue;
      out.push({ name: decoded.name, ordinal: ordinal++, data: decoded.data as Record<string, unknown> });
    }
  }
  return out;
}

/**
 * Decode a transaction into DB rows. `contextPool` disambiguates events that
 * carry no lbPair field (PositionClose, CompositionFee).
 * Emits both v2 and legacy variants deduped: Swap is dropped when Swap2Evt is
 * present, ClaimFee dropped when ClaimFee2 is present.
 */
export function decodeDlmmTransaction(
  tx: ParsedTransactionWithMeta,
  sig: string,
  contextPool: string,
): DecodedTx {
  const swaps: NewSwap[] = [];
  const liquidityEvents: NewLiquidityEvent[] = [];
  if (!tx.meta || tx.meta.err) return { swaps, liquidityEvents };
  const slot = tx.slot;
  const blockTs = new Date((tx.blockTime ?? 0) * 1000);

  const events = extractRawEvents(tx);
  const hasSwap2 = events.some((e) => e.name === "Swap2Evt");
  const hasClaimFee2 = events.some((e) => e.name === "ClaimFee2");

  for (const ev of events) {
    const d = ev.data;
    const common = { sig, eventOrdinal: ev.ordinal, slot, blockTs };
    switch (ev.name) {
      case "Swap2Evt": {
        swaps.push({
          ...common,
          pool: asString(d.lb_pair),
          swapForY: d.swap_for_y as boolean,
          startBin: Number(d.start_bin_id),
          endBin: Number(d.end_bin_id),
          amountIn: asBigint(d.amount_in),
          amountOut: asBigint(d.amount_out),
          feeBps: Number(asBigint(d.fee_bps)),
          fee: asBigint(d.mm_fee) + asBigint(d.limit_order_fee),
          mmFee: asBigint(d.mm_fee),
          protocolFee: asBigint(d.protocol_fee),
          limitOrderFee: asBigint(d.limit_order_fee),
          hostFee: asBigint(d.host_fee),
          feesOnInput: d.fees_on_input as boolean,
          feesOnTokenX: d.fees_on_token_x as boolean,
        });
        break;
      }
      case "Swap": {
        if (hasSwap2) break; // duplicate of Swap2Evt
        swaps.push({
          ...common,
          pool: asString(d.lb_pair),
          swapForY: d.swap_for_y as boolean,
          startBin: Number(d.start_bin_id),
          endBin: Number(d.end_bin_id),
          amountIn: asBigint(d.amount_in),
          amountOut: asBigint(d.amount_out),
          feeBps: Number(asBigint(d.fee_bps)),
          fee: asBigint(d.fee),
          mmFee: null,
          protocolFee: asBigint(d.protocol_fee),
          limitOrderFee: null,
          hostFee: asBigint(d.host_fee),
          feesOnInput: null,
          feesOnTokenX: null,
        });
        break;
      }
      case "AddLiquidity":
      case "RemoveLiquidity": {
        const amounts = d.amounts as unknown[];
        liquidityEvents.push({
          ...common,
          pool: asString(d.lb_pair),
          kind: ev.name === "AddLiquidity" ? "add" : "remove",
          position: asString(d.position),
          owner: asString(d.from),
          amountX: asBigint(amounts[0]),
          amountY: asBigint(amounts[1]),
          activeBin: Number(d.active_bin_id),
        });
        break;
      }
      case "Rebalancing": {
        liquidityEvents.push({
          ...common,
          pool: asString(d.lb_pair),
          kind: "rebalance",
          position: asString(d.position),
          owner: asString(d.owner),
          amountX: asBigint(d.x_added_amount) - asBigint(d.x_withdrawn_amount),
          amountY: asBigint(d.y_added_amount) - asBigint(d.y_withdrawn_amount),
          activeBin: Number(d.active_bin_id),
          raw: {
            xWithdrawn: asString(d.x_withdrawn_amount),
            xAdded: asString(d.x_added_amount),
            yWithdrawn: asString(d.y_withdrawn_amount),
            yAdded: asString(d.y_added_amount),
            xFee: asString(d.x_fee_amount),
            yFee: asString(d.y_fee_amount),
            oldMinId: Number(d.old_min_id),
            oldMaxId: Number(d.old_max_id),
            newMinId: Number(d.new_min_id),
            newMaxId: Number(d.new_max_id),
          },
        });
        break;
      }
      case "PositionCreate": {
        liquidityEvents.push({
          ...common,
          pool: asString(d.lb_pair),
          kind: "position_create",
          position: asString(d.position),
          owner: asString(d.owner),
          amountX: null,
          amountY: null,
          activeBin: null,
        });
        break;
      }
      case "PositionClose": {
        liquidityEvents.push({
          ...common,
          pool: contextPool,
          kind: "position_close",
          position: asString(d.position),
          owner: asString(d.owner),
          amountX: null,
          amountY: null,
          activeBin: null,
        });
        break;
      }
      case "ClaimFee":
      case "ClaimFee2": {
        if (ev.name === "ClaimFee" && hasClaimFee2) break; // duplicate
        liquidityEvents.push({
          ...common,
          pool: asString(d.lb_pair),
          kind: "claim_fee",
          position: asString(d.position),
          owner: asString(d.owner),
          amountX: asBigint(d.fee_x),
          amountY: asBigint(d.fee_y),
          activeBin: ev.name === "ClaimFee2" ? Number(d.active_bin_id) : null,
        });
        break;
      }
      case "CompositionFee": {
        liquidityEvents.push({
          ...common,
          pool: contextPool,
          kind: "composition_fee",
          position: null,
          owner: asString(d.from),
          amountX: asBigint(d.token_x_fee_amount),
          amountY: asBigint(d.token_y_fee_amount),
          activeBin: Number(d.bin_id),
        });
        break;
      }
      default:
        break;
    }
  }
  return { swaps, liquidityEvents };
}
