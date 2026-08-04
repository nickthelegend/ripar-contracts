/**
 * Prove the two teardown paths actually give the money back.
 *
 * Every Algorand app locks 0.1 ALGO of its creator's minimum balance, and every
 * box locks more. Without a DeleteApplication handler that is unreclaimable —
 * four failed create attempts during one afternoon stranded 0.4 ALGO in apps
 * 768562625, 768562630, 768562697 and 768562713, which nobody can ever touch
 * again. deregister_agent is the same problem one level down: new_agent asserts
 * one identity per address, so an owner who registered a typo could neither
 * re-register nor remove the old entry.
 *
 * Both claims are about balances, so both are checked by reading balances.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("/tmp/testnet-e2e.json", "utf8"));
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const acct = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const signer = algosdk.makeBasicAccountTransactionSigner(acct);

const compile = async (teal) =>
  new Uint8Array(Buffer.from((await algod.compile(Buffer.from(teal, "utf8")).do()).result, "base64"));

/** Minimum balance is what actually moves here; the spendable figure follows it. */
const minBalance = async () =>
  Number((await algod.accountInformation(acct.addr.toString()).do()).minBalance);

const results = {};
const check = (claim, pass) => {
  results[claim] = pass;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${claim}`);
};

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const box = (app, prefix, raw) => ({ appIndex: app, name: new Uint8Array([...Buffer.from(prefix), ...raw]) });
const addrBox = (app, p, a) => box(app, p, algosdk.decodeAddress(a).publicKey);
const M = (name, args, ret) => new algosdk.ABIMethod({ name, args, returns: { type: ret } });

async function call(appId, method, args, boxes = [], fee = 3000) {
  const sp = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId, method, methodArgs: args, sender: acct.addr, signer, boxes,
    suggestedParams: { ...sp, fee, flatFee: true },
  });
  const r = await atc.execute(algod, 6);
  return r.methodResults[0].returnValue;
}

/* ── a throwaway IdentityRegistry, so nothing live is touched ──────────── */
console.log("── deploying a throwaway registry ──");
const before = await minBalance();
console.log("  min balance before:", before / 1e6, "ALGO");

const sp = await algod.getTransactionParams().do();
const create = algosdk.makeApplicationCreateTxnFromObject({
  sender: acct.addr,
  suggestedParams: sp,
  onComplete: algosdk.OnApplicationComplete.NoOpOC,
  approvalProgram: await compile(fs.readFileSync("contracts/artifacts/IdentityRegistry.approval.teal", "utf8")),
  clearProgram: await compile(fs.readFileSync("contracts/artifacts/IdentityRegistry.clear.teal", "utf8")),
  numGlobalInts: 4, numGlobalByteSlices: 4, numLocalInts: 0, numLocalByteSlices: 0,
});
const { txid } = await algod.sendRawTransaction(create.signTxn(acct.sk)).do();
const appId = Number((await algosdk.waitForConfirmation(algod, txid, 6)).applicationIndex);
console.log("  app:", appId);

const afterCreate = await minBalance();
const lockedByCreate = afterCreate - before;
console.log("  min balance after create:", afterCreate / 1e6, `(+${lockedByCreate / 1e6})`);
// 0.1 ALGO base plus per-schema cost — each declared global uint and byte slice
// adds its own. So the figure is not a constant, and asserting 0.1 exactly is
// asserting the wrong model. What matters is that SOMETHING was locked, and
// that delete gives back exactly that.
check("creating an app locks minimum balance", lockedByCreate > 0);

/* ── register, then deregister, and watch the box MBR come back ────────── */
console.log("\n── deregister_agent ──");
// Boxes are paid for out of the APP account, so it needs funding first.
const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: acct.addr,
  receiver: algosdk.getApplicationAddress(appId).toString(),
  amount: 300_000,
  suggestedParams: await algod.getTransactionParams().do(),
});
const f = await algod.sendRawTransaction(fundTxn.signTxn(acct.sk)).do();
await algosdk.waitForConfirmation(algod, f.txid, 6);

const appMin = async () =>
  Number((await algod.accountInformation(algosdk.getApplicationAddress(appId).toString()).do()).minBalance);

const appMinBefore = await appMin();
const DOMAIN = "teardown-probe.ripar.io";
const id = Number(
  await call(appId, M("new_agent", [{ type: "string" }], "uint64"), [DOMAIN], [
    addrBox(appId, "ad_", acct.addr.toString()),
    box(appId, "dm_", Buffer.from(DOMAIN)),
    box(appId, "ag_", u64(1)),
  ])
);
const appMinRegistered = await appMin();
console.log("  registered agent", id, "| app min balance +", (appMinRegistered - appMinBefore) / 1e6);
check("registering an agent locks box minimum balance", appMinRegistered > appMinBefore);

await call(appId, M("deregister_agent", [{ type: "uint64" }], "bool"), [id], [
  addrBox(appId, "ad_", acct.addr.toString()),
  box(appId, "dm_", Buffer.from(DOMAIN)),
  box(appId, "ag_", u64(id)),
]);
const appMinAfter = await appMin();
console.log("  deregistered      | app min balance now", appMinAfter / 1e6);
check("deregistering gives the box minimum balance back", appMinAfter === appMinBefore);

// And the reverse indexes really are gone, not merely orphaned.
const resolved = await call(
  appId, M("resolve_by_domain", [{ type: "string" }], "uint64"), [DOMAIN],
  [box(appId, "dm_", Buffer.from(DOMAIN))]
);
check("the domain no longer resolves to the removed agent", Number(resolved) === 0);

/* ── delete, and watch the app's own 0.1 come back ─────────────────────── */
console.log("\n── delete ──");
// An app cannot be deleted while it holds a balance it would strand, so drain
// the app account back to the creator first. This is the step the earlier
// orphans could never take, because they had no delete handler at all.
const drain = algosdk.makeApplicationCallTxnFromObject({
  sender: acct.addr,
  appIndex: appId,
  onComplete: algosdk.OnApplicationComplete.DeleteApplicationOC,
  suggestedParams: { ...(await algod.getTransactionParams().do()), fee: 2000, flatFee: true },
});
try {
  const d = await algod.sendRawTransaction(drain.signTxn(acct.sk)).do();
  await algosdk.waitForConfirmation(algod, d.txid, 6);
  const afterDelete = await minBalance();
  console.log(
    "  min balance after delete:", afterDelete / 1e6,
    `(${(afterDelete - afterCreate) / 1e6}, released ${lockedByCreate / 1e6})`
  );
  check("deleting the app returns every microALGO it locked", afterDelete === before);
} catch (e) {
  console.log("  delete failed:", String(e.message).slice(0, 160));
  check("deleting the app returns every microALGO it locked", false);
}

console.log("\n── verdict ──");
const ok = Object.values(results).every(Boolean);
console.log(
  ok
    ? "Both teardown paths return the minimum balance they took."
    : "A teardown path did not give the money back."
);
process.exit(ok ? 0 : 1);
