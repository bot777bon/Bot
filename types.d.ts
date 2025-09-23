declare module 'telegraf';
declare module '@solana/web3.js';
declare module 'dotenv';
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