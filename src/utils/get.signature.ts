import bs58 from "bs58";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

export function getSignature(
  transaction: Transaction | VersionedTransaction
): string {
  const signature =
    "signature" in transaction
      ? transaction.signature
      : transaction.signatures[0];
  if (!signature) {
    throw new Error(
      "Missing transaction signature, the transaction was not signed by the fee payer"
    );
  }
  // Normalize Buffer -> Uint8Array to satisfy bs58.encode typings
  let sigBytes: Uint8Array | number[];
  // Node Buffer is also a Uint8Array subtype at runtime but TypeScript's lib
  // types may not consider it assignable to the expected ArrayBuffer shape.
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(signature as any)) {
    sigBytes = new Uint8Array(signature as any);
  } else {
    // Assume it's already a Uint8Array-like
    sigBytes = signature as unknown as Uint8Array;
  }

  return bs58.encode(sigBytes as any);
}