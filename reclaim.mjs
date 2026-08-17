/**
 * Give back the minimum balance held by superseded deployments.
 *
 * Every app locks 0.1 ALGO plus per-schema cost plus 0.1 per extra program
 * page, and each redeploy strands another set. After nine deployments across
 * one afternoon the deployer had 5.5 ALGO of minimum balance and 0.1 spendable
 * — unable to deploy the very fix that would let it clean up.
 *
 * The AVM refuses to delete an app that still holds boxes, which is the right
 * default: a registry other contracts resolve against should not vanish under
 * them. So this deregisters the agents it controls first, then deletes.
 *
 * It NEVER touches an app passed in `keep`. The live registries are load-
 * bearing for the explorer, the MCP server, the agent card and the docs.
 */
import algosdk from "algosdk";
import fs from "node:fs";
import { configPath } from "./config-path.mjs";

const cfg = JSON.parse(fs.readFileSync(configPath("testnet-e2e.json"), "utf8"));
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);
const acct = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const other = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const signer = algosdk.makeBasicAccountTransactionSigner(acct);

/** The live set. Deleting any of these breaks four repos. */
const KEEP = new Set([768_633_998, 768_633_999, 768_634_000]);

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const addrBox = (a) => new Uint8Array([...Buffer.from("ad_"), ...algosdk.decodeAddress(a).publicKey]);

const balances = async () => {
  const i = await algod.accountInformation(acct.addr.toString()).do();
  return { amount: Number(i.amount), min: Number(i.minBalance), apps: (i.createdApps ?? []).map((a) => Number(a.id)) };
};

const before = await balances();
console.log("── before ──");
console.log("  balance   :", (before.amount / 1e6).toFixed(3), "ALGO");
console.log("  min balance:", (before.min / 1e6).toFixed(3));
console.log("  spendable :", ((before.amount - before.min) / 1e6).toFixed(3));
console.log("  apps      :", before.apps.length);

/** Box names an app still holds, so we know what blocks deletion. */
async function boxesOf(appId) {
  try {
    const r = await algod.getApplicationBoxes(appId).do();
    return (r.boxes ?? []).map((b) => new Uint8Array(Buffer.from(b.name)));
  } catch {
    return [];
  }
}

/** Try to empty an IdentityRegistry by deregistering the agents we control. */
async function deregisterAll(appId) {
  const boxes = await boxesOf(appId);
  const agentIds = boxes
    .filter((n) => Buffer.from(n.subarray(0, 3)).toString() === "ag_")
    .map((n) => Number(Buffer.from(n).readBigUInt64BE(3)));

  const method = new algosdk.ABIMethod({
    name: "deregister_agent",
    args: [{ type: "uint64", name: "agent_id" }],
    returns: { type: "bool" },
  });

  for (const id of agentIds) {
    // Whose agent is it? deregister_agent is owner-only, so the right key has
    // to sign — and we only hold two.
    let record;
    try {
      record = Buffer.from(
        (await algod.getApplicationBoxByName(appId, new Uint8Array([...Buffer.from("ag_"), ...u64(id)])).do()).value
      );
    } catch {
      continue;
    }
    const owner = [acct, other].find((a) =>
      record.includes(Buffer.from(algosdk.decodeAddress(a.addr.toString()).publicKey))
    );
    if (!owner) {
      console.log(`    agent ${id}: owned by an address we do not hold — cannot deregister`);
      continue;
    }
    // The domain box name is not derivable without decoding the record, so
    // pass every box this app holds that could belong to this agent.
    const all = await boxesOf(appId);
    try {
      const sp = await algod.getTransactionParams().do();
      const atc = new algosdk.AtomicTransactionComposer();
      atc.addMethodCall({
        appID: appId,
        method,
        methodArgs: [id],
        sender: owner.addr,
        signer: algosdk.makeBasicAccountTransactionSigner(owner),
        boxes: all.slice(0, 8).map((name) => ({ appIndex: appId, name })),
        suggestedParams: { ...sp, fee: 3000, flatFee: true },
      });
      await atc.execute(algod, 6);
      console.log(`    agent ${id}: deregistered`);
    } catch (e) {
      console.log(`    agent ${id}: ${String(e.message).slice(0, 90)}`);
    }
  }
}

console.log("\n── reclaiming ──");
let deleted = 0;
for (const appId of before.apps) {
  if (KEEP.has(appId)) {
    console.log(`  ${appId}: LIVE, kept`);
    continue;
  }
  let boxes = await boxesOf(appId);
  if (boxes.length) {
    console.log(`  ${appId}: ${boxes.length} box(es), trying to empty it`);
    await deregisterAll(appId);
    boxes = await boxesOf(appId);
  }
  if (boxes.length) {
    // Expected for the pre-delete-handler orphans and for registries whose
    // agents belong to keys we do not hold. Stated rather than retried.
    console.log(`  ${appId}: still holds ${boxes.length} box(es) — cannot delete`);
    continue;
  }
  try {
    const sp = await algod.getTransactionParams().do();
    const txn = algosdk.makeApplicationCallTxnFromObject({
      sender: acct.addr,
      appIndex: appId,
      onComplete: algosdk.OnApplicationComplete.DeleteApplicationOC,
      suggestedParams: { ...sp, fee: 2000, flatFee: true },
    });
    const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
    await algosdk.waitForConfirmation(algod, txid, 6);
    console.log(`  ${appId}: deleted`);
    deleted++;
  } catch (e) {
    // The four apps created before any contract had a delete handler land
    // here, permanently. Nothing can reach them.
    console.log(`  ${appId}: ${String(e.message).includes("logic eval") ? "no delete handler — stranded forever" : String(e.message).slice(0, 70)}`);
  }
}

const after = await balances();
console.log("\n── after ──");
console.log("  min balance:", (after.min / 1e6).toFixed(3), `(released ${((before.min - after.min) / 1e6).toFixed(3)})`);
console.log("  spendable  :", ((after.amount - after.min) / 1e6).toFixed(3));
console.log(`  deleted ${deleted} app(s)`);
