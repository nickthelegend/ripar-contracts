/**
 * Top up the registries' own app accounts.
 *
 * An app account — not the deployer — pays the minimum balance for every box
 * its contract writes. A box costs 2500 + 400×(name+value) microALGO, and that
 * cost is PERMANENT for as long as the box exists. So a registry that gets used
 * slowly runs itself out of headroom, and then simply stops accepting new
 * records.
 *
 * The failure is unhelpful in a specific way. algod reports:
 *
 *     account Q2BKBXIBA6TL… balance 1050000 below min 1096500 (1 assets)
 *
 * against an address that appears nowhere in the source, in a call that looks
 * like an authorisation problem. Nothing connects it to "post_job needs a box".
 *
 * This is not a leak and topping up is not a workaround: the ALGO is locked,
 * not spent, and deleting a box returns it. It is the running cost of a
 * registry that keeps its records.
 *
 *   node fund-app-accounts.mjs            # top each up to 1 ALGO of headroom
 *   node fund-app-accounts.mjs 2.5        # ...to 2.5 ALGO of headroom
 */
import algosdk from "algosdk";
import fs from "node:fs";

const TARGET_HEADROOM = Number(process.argv[2] ?? 1) * 1e6;
const CONFIG = process.env.RIPAR_E2E_CONFIG ?? "/tmp/testnet-e2e.json";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const funder = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const deployed = JSON.parse(fs.readFileSync(new URL("./DEPLOYED.json", import.meta.url), "utf8"));

const funderBefore = await algod.accountInformation(funder.addr).do();
let budget = Number(funderBefore.amount) - Number(funderBefore.minBalance);
console.log(`funder ${String(funder.addr).slice(0, 14)}…  ${(budget / 1e6).toFixed(3)} ALGO spendable`);
console.log(`target: ${(TARGET_HEADROOM / 1e6).toFixed(2)} ALGO of headroom per app account\n`);

let moved = 0;
for (const [name, info] of Object.entries(deployed.registries)) {
  const addr = algosdk.getApplicationAddress(info.appId).toString();
  const acct = await algod.accountInformation(addr).do();
  const headroom = Number(acct.amount) - Number(acct.minBalance);
  const need = TARGET_HEADROOM - headroom;

  if (need <= 0) {
    console.log(`  ok    ${name.padEnd(19)} ${addr.slice(0, 12)}…  ${(headroom / 1e6).toFixed(4)} ALGO headroom`);
    continue;
  }
  // Leave the funder able to pay its own fees rather than emptying it to hit
  // the target on the last app.
  if (need + 10_000 > budget) {
    console.log(
      `  SKIP  ${name.padEnd(19)} needs ${(need / 1e6).toFixed(4)} ALGO and the funder has ${(budget / 1e6).toFixed(4)}`
    );
    continue;
  }

  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: funder.addr,
    receiver: addr,
    amount: Math.ceil(need),
    suggestedParams: sp,
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(funder.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
  budget -= need + 1000;
  moved += need;

  const after = await algod.accountInformation(addr).do();
  console.log(
    `  sent  ${name.padEnd(19)} ${addr.slice(0, 12)}…  ` +
      `${(headroom / 1e6).toFixed(4)} → ${((Number(after.amount) - Number(after.minBalance)) / 1e6).toFixed(4)} ALGO`
  );
}

console.log(`\n${(moved / 1e6).toFixed(3)} ALGO moved. It is locked against box storage, not spent.`);
