// Parse any key type: base58, base64, hex, mnemonic, or JSON array
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { mnemonicToSeedSync } from 'bip39';

export function parseKey(input: string): any {
  // Try JSON array
  if (input.trim().startsWith('[')) {
    return loadKeypair(input);
  }
  // Try base64
  try {
    const buf = Buffer.from(input, 'base64');
    if (buf.length === 64) return Keypair.fromSecretKey(Uint8Array.from(buf));
  } catch {}
  // Try base58
  try {
    const buf = bs58.decode(input);
    if (buf.length === 64) return Keypair.fromSecretKey(Uint8Array.from(buf));
  } catch {}
  // Try hex
  try {
    if (/^[0-9a-fA-F]+$/.test(input) && input.length === 128) {
      const buf = Buffer.from(input, 'hex');
      return Keypair.fromSecretKey(Uint8Array.from(buf));
    }
  } catch {}
  // Try mnemonic (BIP39)
  try {
    if (input.split(' ').length >= 12) {
      const seed = mnemonicToSeedSync(input.trim());
      const key = nacl.sign.keyPair.fromSeed(Uint8Array.from(seed.slice(0, 32)));
      return Keypair.fromSecretKey(Uint8Array.from(key.secretKey));
    }
  } catch {}
  throw new Error('Invalid key format. Supported: base58, base64, hex, mnemonic, JSON array.');
}
import { Keypair, clusterApiUrl } from '@solana/web3.js';
import rpcPool from './utils/rpcPool';

// Load a keypair from an array, Uint8Array, or base64/JSON string
export function loadKeypair(secret: number[] | Uint8Array | string) {
  let key: Uint8Array;
  if (typeof secret === 'string') {
    // Accept base64 or JSON array string
    if (secret.startsWith('[')) {
      key = Uint8Array.from(JSON.parse(secret));
    } else {
      key = Uint8Array.from(Buffer.from(secret, 'base64'));
    }
  } else if (Array.isArray(secret)) {
    key = Uint8Array.from(secret);
  } else if (secret instanceof Uint8Array) {
    key = secret;
  } else {
    throw new Error('Invalid private key type. Must be array, Uint8Array, or base64 string.');
  }
  if (key.length < 32) throw new Error('Invalid private key length. Must be at least 32 bytes.');
  return Keypair.fromSecretKey(key);
}

// Generate a new keypair
export function generateKeypair() {
  return Keypair.generate();
}

// Export secret key as base64 string
export function exportSecretKey(keypair: any): string {
  return Buffer.from(keypair.secretKey).toString('base64');
}

// Create a Solana connection (Mainnet or Devnet)
export function getConnection() {
  // Prefer centralized RPC connection from rpcPool which applies rotation and backoff
  return rpcPool.getRpcConnection();
}