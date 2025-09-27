declare module 'telegraf';
declare module '@solana/web3.js';
declare module 'dotenv';
declare module 'sqlite3';
declare module 'sqlite';
declare module 'fernet';
declare module 'node-schedule';
declare module 'binance-api-node';
// Keep generic ambient module declarations for local-only modules
declare module '*';

declare global {
	// Minimal placeholders to satisfy TypeScript in this workspace
	type QuoteRes = any;
	type TokenSecurityInfoDataType = any;
	type GasFeeEnum = number;
	type JitoFeeEnum = number;
}

export {};