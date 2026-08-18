/**
 * Wait for the deployer to be funded, then finish the parts that need funds.
 *
 * Funding is the one step that cannot be automated here — a faucet needs a human
 * — so this closes the loop around it: it watches for the balance to land,
 * reports exactly what is still missing, and opts into USDC the moment there is
 * enough ALGO to pay for the opt-in's minimum balance increase.
 */
import algosdk from "algosdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const key = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ripar", "testnet-deployer.json"), "utf8"));
const acct = algosdk.mnemonicToSecretKey(key.mnemonic);
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const USDC = 10458941;

// Deploying three apps, funding their accounts and holding box MBR needs more
// than a token amount. This is the floor, not a comfortable margin.
const NEED_ALGO = 3.5e6;

const look = async () => {
  try {
    const a = await algod.accountInformation(acct.addr.toString()).do();
    const usdc = (a.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === USDC);
    return { algo: Number(a.amount), optedIn: Boolean(usdc), usdc: usdc ? Number(usdc.amount) : 0 };
  } catch {
    return { algo: 0, optedIn: false, usdc: 0 };   // account does not exist until funded
  }
};

console.log(`\n  watching ${acct.addr.toString()}\n`);
let optedIn = false;

for (let i = 0; i < 240; i++) {
  const s = await look();
  const algo = (s.algo / 1e6).toFixed(3);

  if (s.algo >= NEED_ALGO && !s.optedIn && !optedIn) {
    console.log(`  ${algo} ALGO landed — opting into USDC ${USDC}`);
    const sp = await algod.getTransactionParams().do();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: acct.addr, receiver: acct.addr, amount: 0, assetIndex: USDC, suggestedParams: sp,
    });
    const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
    await algosdk.waitForConfirmation(algod, txid, 6);
    console.log(`  opted in — ${txid}`);
    optedIn = true;
    continue;
  }

  if (s.optedIn && s.usdc > 0) {
    console.log(`\n  READY — ${algo} ALGO, ${(s.usdc / 1e6).toFixed(2)} USDC`);
    console.log(`  next: node deploy-v2.mjs\n`);
    process.exit(0);
  }

  const want = s.algo < NEED_ALGO ? `need ${(NEED_ALGO / 1e6).toFixed(1)} ALGO, have ${algo}`
             : !s.optedIn         ? "opting into USDC"
                                  : "need TestNet USDC";
  if (i % 6 === 0) console.log(`  ${want}`);
  await new Promise((r) => setTimeout(r, 5000));
}

console.log("\n  timed out after 20 minutes — rerun when you have sent the funds\n");
process.exit(1);
