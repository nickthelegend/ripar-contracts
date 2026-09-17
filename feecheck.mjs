import a from "algosdk";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ripar", "testnet-e2e.json"), "utf8"));
const dep = a.mnemonicToSecretKey(cfg.merchant.mnemonic);
const other = a.mnemonicToSecretKey(cfg.payer.mnemonic);
const treasury = other.addr.toString();
const algod = new a.Algodv2("", "https://testnet-api.algonode.cloud", "");
const VALIDATION = 771911550, USDC = 10458941;
const M = new a.ABIMethod({ name: "set_fee", args: [{ type: "uint64" }, { type: "address" }], returns: { type: "bool" } });

async function sp(fee = 3000) { const p = await algod.getTransactionParams().do(); p.fee = fee; p.flatFee = true; return p; }

/** Run set_fee WITHOUT committing. Real deployed bytecode, real chain state, zero cost. */
async function sim(label, { sender, bps, dest, expect }) {
  const atc = new a.AtomicTransactionComposer();
  atc.addMethodCall({ appID: VALIDATION, method: M, sender: sender.addr,
    signer: a.makeBasicAccountTransactionSigner(sender), suggestedParams: await sp(),
    methodArgs: [bps, dest], appForeignAssets: [USDC], appAccounts: [dest] });
  try {
    const res = await atc.simulate(algod, new a.modelsv2.SimulateRequest({ txnGroups: [], allowEmptySignatures: true }));
    const ok = !res.simulateResponse.txnGroups[0].failureMessage;
    console.log(`  ${ok ? "ACCEPTED" : "rejected"}  ${label}`);
    if (!ok) console.log(`            blocked by: ${whichAssert(res.simulateResponse.txnGroups[0].failureMessage)}`);
    return ok;
  } catch (e) {
    const m = (e.message || String(e)).split("\n")[0];
    console.log(`  rejected  ${label}`);
    console.log(`            blocked by: ${whichAssert(m)}`);
    return false;
  }
}

// Which assert fired, by program counter. Without this the output is
// misleading: once fee_bps is non-zero the one-shot guard short-circuits every
// later assert, so a "251 bps rejected" line proves the ONE-SHOT guard, not the
// cap. Reporting those as cap coverage would be a lie told by a passing test.
const ASSERTS = { 3022: "creator-only", 3029: "one-shot (fee_bps == 0)" };
const whichAssert = (msg) => {
  const m = /pc=(\d+)/.exec(String(msg));
  return m ? (ASSERTS[m[1]] ?? `assert at pc=${m[1]}`) : "unknown";
};

const app = await algod.getApplicationByID(VALIDATION).do();
const feeNow = Number((app.params.globalState || []).find(kv => Buffer.from(kv.key, "base64").toString() === "fee_bps")?.value.uint ?? 0);
console.log(`\n── set_fee, simulated against LIVE app ${VALIDATION} (zero cost) ──`);
console.log(`   fee_bps is currently ${feeNow}.` + (feeNow ? " The one-shot guard fires FIRST, so cap and\n   treasury asserts are UNREACHABLE here and are not tested by this run." : ""));
console.log("");
const r1 = await sim("non-creator tries to set the fee", { sender: other, bps: 250, dest: treasury });
const r2 = await sim("fee above the 250 bps cap (251)", { sender: dep, bps: 251, dest: treasury });
const r3 = await sim("absurd fee (10000 bps = 100%)", { sender: dep, bps: 10000, dest: treasury });
const r4 = await sim("zero-address treasury", { sender: dep, bps: 250, dest: a.encodeAddress(new Uint8Array(32)) });
const r5 = await sim("treasury NOT opted into the escrow asset", { sender: dep, bps: 250, dest: a.generateAccount().addr.toString() });
const r6 = await sim("creator re-setting the fee (one-shot must refuse)", { sender: dep, bps: 250, dest: treasury });

console.log("\n  summary");
const rows = [["non-creator", r1, false], ["251 bps (over cap)", r2, false], ["10000 bps", r3, false],
              ["zero-address treasury", r4, false], ["un-opted-in treasury", r5, false], ["re-set (one-shot)", r6, false]];
let bad = 0;
for (const [n, got, want] of rows) { const pass = got === want; if (!pass) bad++;
  console.log(`    ${pass ? "PASS" : "FAIL"}  ${n.padEnd(28)} expected ${want ? "accept" : "reject"}, got ${got ? "accept" : "reject"}`); }
console.log(bad ? `\n  ${bad} unexpected\n` : "\n  all six refused.");
if (feeNow) console.log(`  HONEST SCOPE: with fee_bps=${feeNow}, only the creator-only and one-shot\n  asserts are actually exercised. The 250 cap, the zero-address check and the\n  treasury opt-in check sit BEHIND the one-shot guard and are covered by the\n  source audit and unit tests, not by this run.\n`);
