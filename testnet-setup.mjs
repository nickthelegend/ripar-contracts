/**
 * Build the two-account TestNet config deploy-v2 expects, from the one funded key.
 *
 * deploy-v2 needs a merchant and a payer, and the payer doubles as the attacker
 * in the negative tests — so it must be a genuinely different account, not the
 * same key twice, or every "attacker cannot do X" assertion passes for the wrong
 * reason.
 *
 * The faucet funds one address, so the second is derived here and funded from
 * the first, then opted into USDC. Everything below is a real signed TestNet
 * transaction.
 */
import algosdk from "algosdk";
import fs from "node:fs";
import { configPath } from "./config-path.mjs";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const USDC = 10458941;
const OUT = configPath("testnet-e2e.json");

const deployer = JSON.parse(fs.readFileSync(configPath("testnet-deployer.json"), "utf8"));
const merchant = algosdk.mnemonicToSecretKey(deployer.mnemonic);

// Reuse the payer across runs. Generating a fresh one each time would strand the
// ALGO sent to the last one, which is the exact failure that lost the first
// deployer.
let payer;
if (fs.existsSync(OUT)) {
  const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
  if (prev?.payer?.mnemonic) {
    payer = algosdk.mnemonicToSecretKey(prev.payer.mnemonic);
    console.log(`  reusing payer ${payer.addr.toString()}`);
  }
}
if (!payer) {
  payer = algosdk.generateAccount();
  console.log(`  new payer ${payer.addr.toString()}`);
}

const info = async (a) => {
  try { return await algod.accountInformation(a).do(); } catch { return null; }
};
const send = async (txn, sk, what) => {
  const { txid } = await algod.sendRawTransaction(txn.signTxn(sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 8);
  console.log(`  ${what} — ${txid}`);
  return txid;
};

const m = await info(merchant.addr.toString());
console.log(`  merchant ${merchant.addr.toString()} — ${(Number(m.amount) / 1e6).toFixed(3)} ALGO`);

// Enough to exist, opt into USDC, and sign a handful of app calls.
const PAYER_ALGO = 2_000_000;
const p = await info(payer.addr.toString());
if (!p || Number(p.amount) < PAYER_ALGO) {
  const sp = await algod.getTransactionParams().do();
  await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: merchant.addr, receiver: payer.addr, amount: PAYER_ALGO, suggestedParams: sp,
  }), merchant.sk, `funded payer with ${(PAYER_ALGO / 1e6).toFixed(1)} ALGO`);
}

const holds = (acct) => (acct?.assets ?? []).some((x) => Number(x.assetId ?? x["asset-id"]) === USDC);
for (const [who, acct] of [["merchant", merchant], ["payer", payer]]) {
  if (holds(await info(acct.addr.toString()))) { console.log(`  ${who} already holds USDC`); continue; }
  const sp = await algod.getTransactionParams().do();
  await send(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: acct.addr, receiver: acct.addr, amount: 0, assetIndex: USDC, suggestedParams: sp,
  }), acct.sk, `${who} opted into USDC`);
}

const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
fs.writeFileSync(OUT, JSON.stringify({
  ...prev,
  network: "testnet",
  assetId: USDC,
  // Long enough that a demo can show a job sitting in dispute, short enough that
  // the release path is reachable in the same session.
  disputeWindowSecs: 300,
  merchant: { address: merchant.addr.toString(), mnemonic: deployer.mnemonic },
  payer: { address: payer.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(payer.sk) },
}, null, 2) + "\n", { mode: 0o600 });
fs.chmodSync(OUT, 0o600);

console.log(`\n  wrote ${OUT}`);
