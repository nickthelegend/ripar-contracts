import a from "algosdk";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ripar", "mainnet.json"), "utf8"));
const dep = a.mnemonicToSecretKey(cfg.merchant.mnemonic);
const DEP = dep.addr.toString();
const LEGEND = "LEGENDMQQJJWSQVHRFK36EP7GTM3MTI3VD3GN25YMKJ6MEBR35J4SBNVD4";
const V = cfg.registries.validation, USDC = 31566704;
const algod = new a.Algodv2("", "https://mainnet-api.algonode.cloud", "");
if ((await algod.getTransactionParams().do()).genesisID !== "mainnet-v1.0") throw new Error("not mainnet");
const M = new a.ABIMethod({ name: "set_fee", args: [{ type: "uint64" }, { type: "address" }], returns: { type: "bool" } });
// A signer that signs nothing: simulate accepts empty signatures, so any
// address can be the sender of a simulated call without its key.
const nosig = a.makeEmptyTransactionSigner();

async function build(sender, signer, bps, dest) {
  const p = await algod.getTransactionParams().do(); p.fee = 3000; p.flatFee = true;
  const atc = new a.AtomicTransactionComposer();
  atc.addMethodCall({ appID: V, method: M, sender, signer, suggestedParams: p, methodArgs: [bps, dest], appForeignAssets: [USDC], appAccounts: [dest] });
  return atc;
}
async function sim(label, sender, bps, dest, wantAccept) {
  const atc = await build(sender, nosig, bps, dest);
  const r = await atc.simulate(algod, new a.modelsv2.SimulateRequest({ txnGroups: [], allowEmptySignatures: true }));
  const fm = r.simulateResponse.txnGroups[0].failureMessage;
  const pc = fm ? (/pc=(\d+)/.exec(fm)?.[1] ?? "?") : "-";
  const ok = !fm === wantAccept;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(40)} ${fm ? `rejected at pc=${pc}` : "accepted"}`);
  return ok;
}

const app = await algod.getApplicationByID(V).do();
const fee0 = Number(app.params.globalState.find(kv => Buffer.from(kv.key, "base64").toString() === "fee_bps").value.uint);
console.log(`\n── set_fee on MAINNET app ${V}, fee_bps currently ${fee0} ──`);
console.log(`   simulated first (real bytecode, zero cost), then committed once\n`);
const zero = a.encodeAddress(new Uint8Array(32));
const fresh = a.generateAccount().addr.toString();
const res = [
  await sim("non-creator (LEGEND) sets the fee", LEGEND, 250, DEP, false),
  await sim("251 bps — one over the cap", DEP, 251, DEP, false),
  await sim("10000 bps — 100%", DEP, 10000, DEP, false),
  await sim("zero-address treasury", DEP, 250, zero, false),
  await sim("treasury not opted into USDC", DEP, 250, fresh, false),
  await sim("valid: creator, 250 bps, opted-in treasury", DEP, 250, DEP, true),
];
if (res.includes(false)) { console.log("\n  a guard behaved unexpectedly — NOT committing"); process.exit(1); }

if (process.argv[2] !== "--commit") { console.log("\n  dry run only (pass --commit to set the fee)"); process.exit(0); }
const atc = await build(dep.addr, a.makeBasicAccountTransactionSigner(dep), 250, DEP);
const out = await atc.execute(algod, 8);
console.log(`\n  COMMITTED set_fee(250, ${DEP.slice(0, 10)}…) round ${out.confirmedRound} txid ${out.txIDs[0]}`);

const after = await algod.getApplicationByID(V).do();
const g = k => after.params.globalState.find(kv => Buffer.from(kv.key, "base64").toString() === k).value;
console.log(`  on chain: fee_bps=${g("fee_bps").uint}  treasury=${a.encodeAddress(Uint8Array.from(Buffer.from(g("treasury").bytes, "base64")))}`);
await sim("re-set after commit (one-shot must refuse)", DEP, 250, DEP, false);
