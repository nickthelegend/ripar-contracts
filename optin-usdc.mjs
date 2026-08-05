/**
 * Opt the agent's payTo account into the asset its own 402 quotes.
 *
 * api.ripar.io challenges callers for asset 10458941 — real TestNet USDC — but
 * KBDRZK…KEISKQ had never opted in to it. On Algorand an ASA transfer to a
 * non-opted-in account is rejected at consensus, so every honest payer who
 * followed that challenge got a failed transaction, and the indexer agreed:
 * zero USDC ever arrived.
 *
 * Confirmed against a node before writing this, by simulating the exact
 * transfer the live 402 asks for from the USDC reserve:
 *
 *   receiver error: must optin, asset 10458941 missing from KBDRZK…KEISKQ
 *
 * Costs 0.001 ALGO in fees and raises the account's minimum balance by 0.1
 * ALGO. That 0.1 is locked, not spent — closing the asset out returns it.
 *
 * Idempotent: an account already opted in is left alone rather than sent a
 * second zero transfer.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const USDC = 10_458_941;
const CONFIG = process.env.RIPAR_E2E_CONFIG ?? "/tmp/testnet-e2e.json";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const merchant = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);

const before = await algod.accountInformation(merchant.addr).do();
const holds = (id) => (before.assets ?? []).some((a) => Number(a.assetId ?? a["asset-id"]) === id);

console.log(`account       ${merchant.addr}`);
console.log(`balance       ${(Number(before.amount) / 1e6).toFixed(3)} ALGO`);
console.log(`min-balance   ${(Number(before.minBalance) / 1e6).toFixed(3)} ALGO`);

if (holds(USDC)) {
  console.log(`\nalready opted in to ${USDC}. Nothing to do.`);
  process.exit(0);
}

const spendable = (Number(before.amount) - Number(before.minBalance)) / 1e6;
if (spendable < 0.11) {
  console.error(`\nonly ${spendable.toFixed(3)} ALGO spendable; the opt-in needs 0.101. Refusing.`);
  process.exit(1);
}

// An opt-in is a zero-amount transfer to yourself. There is no other form.
const sp = await algod.getTransactionParams().do();
const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: merchant.addr,
  receiver: merchant.addr,
  amount: 0,
  assetIndex: USDC,
  suggestedParams: sp,
});

const { txid } = await algod.sendRawTransaction(txn.signTxn(merchant.sk)).do();
console.log(`\nopt-in submitted: ${txid}`);
const confirmed = await algosdk.waitForConfirmation(algod, txid, 6);
console.log(`confirmed in round ${confirmed.confirmedRound}`);

const after = await algod.accountInformation(merchant.addr).do();
console.log(`\nmin-balance   ${(Number(after.minBalance) / 1e6).toFixed(3)} ALGO  (+0.1 locked, recoverable)`);
console.log(`spendable     ${((Number(after.amount) - Number(after.minBalance)) / 1e6).toFixed(3)} ALGO`);
console.log(`opted in      ${(after.assets ?? []).map((a) => Number(a.assetId ?? a["asset-id"])).join(", ")}`);
