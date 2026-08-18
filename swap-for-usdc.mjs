/**
 * Swap TestNet ALGO for circulating TestNet USDC on Tinyman.
 *
 * This exists because I spent most of a session asserting it was impossible.
 * Circle's faucet is the only *issuer* of TestNet USDC and it is reCAPTCHA-gated,
 * which I will not bypass — but issuance is not the only way to obtain an asset
 * that is already circulating. Tinyman runs a TestNet AMM, and there is a live
 * USDC/ALGO pool with real depth in it. A swap is permissionless, needs no
 * account and no human gate, and TestNet ALGO is free.
 *
 * The lesson is worth keeping next to the code: "the faucet is gated" is a fact
 * about the faucet, not about the asset.
 */
import algosdk from "algosdk";
import fs from "node:fs";
// CommonJS package: named ESM exports are not available, so destructure the
// default rather than importing names that do not exist at module scope.
// `SupportedNetwork` is not exported at all — the network is a plain string.
import tinyman from "@tinymanorg/tinyman-js-sdk";
const { Swap, SwapType, poolUtils } = tinyman;
const NETWORK = "testnet";
import { configPath } from "./config-path.mjs";

const USDC = 10458941;
const ALGO = 0;
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

const key = JSON.parse(fs.readFileSync(configPath("testnet-deployer.json"), "utf8"));
const acct = algosdk.mnemonicToSecretKey(key.mnemonic);
const address = acct.addr.toString();

const before = await algod.accountInformation(address).do();
const algoBefore = Number(before.amount);
const usdcBefore = Number((before.assets ?? []).find((a) => Number(a.assetId ?? a["asset-id"]) === USDC)?.amount ?? 0);
console.log(`\n  before: ${(algoBefore / 1e6).toFixed(3)} ALGO, ${(usdcBefore / 1e6).toFixed(2)} USDC`);

// Leave enough behind to stay above minimum balance and pay for the deploys and
// app calls this account still has to make. Swapping everything would trade one
// blocker for another.
const KEEP_MICRO = 3_000_000;
const spend = algoBefore - KEEP_MICRO;
if (spend < 500_000) throw new Error(`only ${(algoBefore / 1e6).toFixed(3)} ALGO — not enough to swap while keeping ${KEEP_MICRO / 1e6} in reserve`);

const pool = await poolUtils.v2.getPoolInfo({
  network: NETWORK,
  client: algod,
  asset1ID: USDC,
  asset2ID: ALGO,
});
console.log(`  pool ${pool.account?.address()?.toString().slice(0, 12) ?? "?"}… status ${pool.status}`);

const quote = await Swap.v2.getQuote({
  type: SwapType.FixedInput,
  amount: BigInt(spend),
  assetIn: { id: ALGO, decimals: 6 },
  assetOut: { id: USDC, decimals: 6 },
  network: NETWORK,
  pool,
  slippage: 0.05,
  isSwapRouterEnabled: false,
});
const q = quote.data.quote;
console.log(`  quote: ${(Number(q.assetInAmount) / 1e6).toFixed(3)} ALGO -> ${(Number(q.assetOutAmount) / 1e6).toFixed(2)} USDC`);

const txns = await Swap.v2.generateTxns({
  client: algod,
  quote,
  swapType: SwapType.FixedInput,
  slippage: 0.05,
  initiatorAddr: address,
});
// The SDK hands the initiator a list of {txn, signers} where txn is already an
// algosdk Transaction — decoding it as msgpack throws. A transaction the
// initiator must NOT sign (the pool's own logicsig legs) carries an empty
// signers array and is skipped.
const signed = await Swap.v2.signTxns({
  txGroup: txns,
  initiatorSigner: (group) =>
    Promise.resolve(
      group[0]
        .filter((t) => t.signers === undefined || t.signers.length > 0)
        .map((t) => t.txn.signTxn(acct.sk)),
    ),
});
const exec = await Swap.v2.execute({ client: algod, quote, txGroup: txns, signedTxns: signed });
console.log(`  swapped — tx ${exec.txnID}`);

const after = await algod.accountInformation(address).do();
const usdcAfter = Number((after.assets ?? []).find((a) => Number(a.assetId ?? a["asset-id"]) === USDC)?.amount ?? 0);
console.log(`  after:  ${(Number(after.amount) / 1e6).toFixed(3)} ALGO, ${(usdcAfter / 1e6).toFixed(2)} USDC`);
console.log(`  gained ${((usdcAfter - usdcBefore) / 1e6).toFixed(2)} USDC\n`);
