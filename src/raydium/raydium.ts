import {
  getPdaPoolId,
  LiquidityPoolKeys,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  SPL_MINT_LAYOUT,
  Token,
  TokenAmount,
} from "@raydium-io/raydium-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { Connection, PublicKey, KeyedAccountInfo } from "@solana/web3.js";
import {
  RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
  OPENBOOK_PROGRAM_ID,
  RAYDIUM_LIQUIDITY_PROGRAM_ID_CLMM,
} from "./liquidity";
import { MinimalMarketLayoutV3 } from "./market";
import { MintLayout, TokenAccountLayout } from "./types";
import {
  connection,
  COMMITMENT_LEVEL,
  RPC_WEBSOCKET_ENDPOINT,
  PRIVATE_RPC_ENDPOINT,
  RAYDIUM_AMM_URL,
  private_connection,
  RAYDIUM_CLMM_URL,
} from "../config";
// Inlined minimal service implementations (no external files)
// These implementations are intentionally lightweight and in-memory
// to satisfy runtime behavior without adding new files.

class InMemoryStore<T> {
  private map = new Map<string, T>();
  async create(obj: any) {
    const key = obj.mint ? obj.mint.toString() : obj.poolId?.toString() || String(Date.now());
    this.map.set(key, obj);
    return obj;
  }
  async findLastOne(query: any) {
    if (query && query.mint) return this.map.get(query.mint.toString()) || null;
    if (query && query.poolId) return this.map.get(query.poolId.toString()) || null;
    // return last inserted
    const it = Array.from(this.map.values());
    return it.length ? it[it.length - 1] : null;
  }
  async findOneAndUpdate({ filter, data }: { filter: any; data: any }) {
    const key = filter.poolId || filter.mint;
    if (!key) return null;
    const existing = this.map.get(key.toString()) || {};
    const merged = { ...existing, ...data };
    this.map.set(key.toString(), merged as unknown as T);
    return merged;
  }
}

const OpenMarketService = new (class {
  private store = new InMemoryStore<any>();
  async create(obj: any) {
    return this.store.create(obj);
  }
})();

const TokenService = new (class {
  // Minimal token helpers. Real implementation should query on-chain or token-list.
  async fetchMetadataInfo(mint: string) {
    return { name: `TOK-${mint.slice(0, 6)}`, symbol: `T${mint.slice(0, 4)}` };
  }
  async getMintMetadata(_connection: any, _mint: any) {
    // Return a minimal parsed metadata structure used elsewhere
    return { parsed: { info: { decimals: 9 } }, program: "spl-token" };
  }
  async getMintInfo(mint: string) {
    return { overview: { name: `TOK-${mint.slice(0, 6)}`, symbol: `T${mint.slice(0, 4)}`, decimals: 9 }, secureinfo: { isToken2022: false } };
  }
  async getSOLPrice() {
    return 20; // fallback SOL price in USD
  }
  async getSPLPrice(_mint: string) {
    return 0.01; // placeholder
  }
})();

export const RaydiumTokenService: any = new (class {
  private store = new InMemoryStore<any>();
  async create(data: any) {
    return this.store.create(data);
  }
  async findLastOne(query: any) {
    return this.store.findLastOne(query);
  }
  async findOneAndUpdate({ filter, data }: { filter: any; data: any }) {
    return this.store.findOneAndUpdate({ filter, data });
  }
})();
import { redisClient } from "../utils";
import { syncAmmPoolKeys, syncClmmPoolKeys } from "./raydium.service";

const solanaConnection = new Connection(PRIVATE_RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export interface MinimalTokenAccountData {
  mint: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
}

const existingLiquidityPools: Set<string> = new Set<string>();
const existingOpenBookMarkets: Set<string> = new Set<string>();

async function initDB(): Promise<void> {
  initAMM();
  initCLMM();
}

async function initAMM(): Promise<void> {
  console.log(" - AMM Pool data fetching is started...");
  const ammRes = await fetch(RAYDIUM_AMM_URL);
  const ammData = await ammRes.json();
  console.log(" - AMM Pool data is fetched successfully...");

  const batchSize = 100; // Adjust this value based on your requirements
  const batches: Array<Array<any>> = [];

  for (let i = 0; i < ammData.length; i += batchSize) {
    batches.push(ammData.slice(i, i + batchSize));
  }

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (i: any) => {
        if (
          i.baseMint === NATIVE_MINT.toString() ||
          i.quoteMint === NATIVE_MINT.toString()
        ) {
          if (Number(i.liquidity) > 0) {
            const tokenMint =
              i.baseMint === NATIVE_MINT.toString() ? i.quoteMint : i.baseMint;
            // const tokenMetadata = await TokenService.fetchSimpleMetaData(tokenMint);

            const data = {
              // name: tokenMetadata.name,
              // symbol: tokenMetadata.symbol,
              mint: tokenMint,
              isAmm: true,
              poolId: i.ammId,
              creation_ts: Date.now(),
            };
            await RaydiumTokenService.create(data);
          }
        }
      })
    );
  }

  console.log(" - AMM Pool data is saved to MongoDB successfully...");
}

async function initCLMM(): Promise<void> {
  console.log(" - CLMM Pool data fetching is started...");
  const clmmRes = await fetch(RAYDIUM_CLMM_URL);
  const clmmData = await clmmRes.json();
  console.log(" - CLMM Pool data is fetched successfully...");

  // Normalize different response shapes from the CLMM endpoint.
  // Some responses have { success: false } or other wrappers. Accept either
  // an array directly or an object with a `data` array.
  const clmmArray: any[] = Array.isArray(clmmData)
    ? clmmData
    : Array.isArray((clmmData as any).data)
    ? (clmmData as any).data
    : [];

  if (!clmmArray.length) {
    console.log(' - CLMM Pool data empty or unavailable; skipping CLMM seeding.');
    return;
  }

  const batchSize = 100; // Adjust this value based on your requirements
  const batches: Array<Array<any>> = [];

  for (let i = 0; i < clmmArray.length; i += batchSize) {
    batches.push(clmmArray.slice(i, i + batchSize));
  }

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (i: any) => {
        if (
          i.mintA === NATIVE_MINT.toString() ||
          i.mintB === NATIVE_MINT.toString()
        ) {
          if (Number(i.tvl) > 0) {
            const tokenMint =
              i.mintA === NATIVE_MINT.toString() ? i.mintB : i.mintA;
            // const tokenMetadata = await TokenService.fetchSimpleMetaData(tokenMint);

            const data = {
              // name: tokenMetadata.name,
              // symbol: tokenMetadata.symbol,
              mint: tokenMint,
              isAmm: false,
              poolId: i.id,
              creation_ts: Date.now(),
            };
            await RaydiumTokenService.create(data);
          }
        }
      })
    );
  }
  console.log(" - CLMM Pool data is saved to MongoDB successfully...");
}

export async function saveTokenAccount(
  mint: PublicKey,
  accountData: MinimalMarketLayoutV3
) {
  const key = `openmarket_${mint}`;
  const res = await redisClient.get(key);
  if (res === "added") return;
  // const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };

  await redisClient.set(key, "added");
  await OpenMarketService.create(tokenAccount);
  return tokenAccount;
}

export async function checkMintable(
  vault: PublicKey
): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    // web3.js returns Buffer; some layouts expect Uint8Array — cast safely for TS
    const deserialize = MintLayout.decode(data as unknown as Uint8Array);
    return deserialize.mintAuthorityOption === 0;
  } catch (e) {
    console.debug(e);
    console.error({ mint: vault }, `Failed to check if mint is renounced`);
  }
}

export async function getTop10HoldersPercent(
  connection: Connection,
  mint: string,
  supply: number
  // excludeAddress: string
): Promise<number> {
  try {
    const accounts = await connection.getTokenLargestAccounts(
      new PublicKey(mint)
    );
    let sum = 0;
    let counter = 0;
    for (const account of accounts.value) {
      // if (account.address.toString() === excludeAddress) continue;
      if (!account.uiAmount) continue;
      if (counter >= 10) break;
      counter++;
      sum += account.uiAmount;
    }
    return sum / supply;
  } catch (e) {
    return 0;
  }
}

export async function processOpenBookMarket(
  updatedAccountInfo: KeyedAccountInfo
) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(
      updatedAccountInfo.accountInfo.data
    );

    // to be competitive, we collect market data before buying the token...
    // if (existingTokenAccounts.has(accountData.baseMint.toString())) {
    //   return;
    // }

    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
    console.debug(e);
    console.error({ mint: accountData?.baseMint }, `Failed to process market`);
  }
}

export const runListener = async () => {
  // initDB();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);

  const ammSubscriptionId = solanaConnection.onLogs(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async ({ logs, err, signature }) => {
      if (err) return;
      if (logs && logs.some((log) => log.includes("initialize2"))) {
        // console.log(`https://solscan.io/tx/${signature}`)
        fetchRaydiumMints(
          signature,
          RAYDIUM_LIQUIDITY_PROGRAM_ID_V4.toString(),
          true
        );
      }
    },
    COMMITMENT_LEVEL
  );

  const clmmSubscriptionId = solanaConnection.onLogs(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_CLMM,
    async ({ logs, err, signature }) => {
      if (err) return;
      if (logs && logs.some((log) => log.includes("OpenPositionV2"))) {
        fetchRaydiumMints(
          signature,
          RAYDIUM_LIQUIDITY_PROGRAM_ID_CLMM.toString(),
          false
        );
      }
    },
    COMMITMENT_LEVEL
  );

  async function fetchRaydiumMints(
    txId: string,
    instructionName: string,
    isAmm: boolean
  ) {
    try {
      const tx = await connection.getParsedTransaction(txId, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });

      //@ts-ignore
      const accounts = tx?.transaction.message.instructions.find((ix) => ix.programId.toString() === instructionName)?.accounts as PublicKey[];
      if (!accounts) {
        console.log("No accounts found in the transaction.");
        return;
      }
      const poolIdIndex = isAmm ? 4 : 5;
      const tokenAIndex = isAmm ? 8 : 21;
      const tokenBIndex = isAmm ? 9 : 20;

      const poolId = accounts[poolIdIndex];
      const existing = existingLiquidityPools.has(poolId.toString());

      if ((tx?.blockTime && tx?.blockTime < runTimestamp) || existing) return;
      existingLiquidityPools.add(poolId.toString());
      const tokenAaccount =
        accounts[tokenAIndex].toString() === NATIVE_MINT.toString()
          ? accounts[tokenBIndex]
          : accounts[tokenAIndex];
      const tokenBaccount =
        accounts[tokenBIndex].toString() === NATIVE_MINT.toString()
          ? accounts[tokenBIndex]
          : accounts[tokenAIndex];
      if (tokenBaccount.toString() !== NATIVE_MINT.toString()) return;
      const key = `raydium_mint_${poolId.toString()}`;
      const res = await redisClient.get(key);
      if (res === "added") return;

      const displayData = {
        "TxID:": `https://solscan.io/tx/${txId}`,
        "PoolID:": poolId.toString(),
        "TokenA:": tokenAaccount.toString(),
        "TokenB:": tokenBaccount.toString(),
      };

      console.log(` - New ${isAmm ? "AMM" : "CLMM"} Found`);
      console.table(displayData);

      const tokenMetadata = await TokenService.fetchMetadataInfo(
        tokenAaccount.toString()
      );
      // const mintable = mintOption !== true;
      const data = {
        name: tokenMetadata.name,
        symbol: tokenMetadata.symbol,
        mint: tokenAaccount.toString(),
        isAmm,
        poolId,
        creation_ts: Date.now(),
      };
      await redisClient.set(key, "added");
      await RaydiumTokenService.create(data);
      if (isAmm) {
        await syncAmmPoolKeys(poolId.toString());
      } else {
        await syncClmmPoolKeys(poolId.toString());
      }
    } catch (e) {
      console.log("Error fetching transaction:", e);
      return;
    }
  }

  // const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
  //   OPENBOOK_PROGRAM_ID,
  //   async (updatedAccountInfo) => {
  //     const key = updatedAccountInfo.accountId.toString();
  //     const existing = existingOpenBookMarkets.has(key);
  //     if (!existing) {
  //       existingOpenBookMarkets.add(key);
  //       const _ = processOpenBookMarket(updatedAccountInfo);
  //     }
  //   },
  //   COMMITMENT_LEVEL,
  //   [
  //     { dataSize: MARKET_STATE_LAYOUT_V3.span },
  //     {
  //       memcmp: {
  //         offset: MARKET_STATE_LAYOUT_V3.offsetOf("quoteMint"),
  //         bytes: NATIVE_MINT.toString(),
  //       },
  //     },
  //   ]
  // );

  console.info(`Listening for raydium AMM changes: ${ammSubscriptionId}`);
  console.info(`Listening for raydium CLMM changes: ${clmmSubscriptionId}`);
  // console.info(`Listening for open book changes: ${openBookSubscriptionId}`);
  // Here, we need to remove this mint from snipe List
  // in our database
  // ------>
};

// Export seeding helpers for external use
export { initAMM, initCLMM, initDB };

// export const getPrice = async (shitTokenAddress: string) => {
//   const response = await fetch(
//     "https://api.raydium.io/v2/main/price"
//   );
//   const tokenPrices = await response.json();
//   const solprice = tokenPrices[shitTokenAddress];
//   // Buy rate
//   const estimateRate = await estimateSwapRate(1, shitTokenAddress, false);
//   if (!estimateRate) return 0;
//   const tokenprice = estimateRate / solprice;
//   return tokenprice;
// };
