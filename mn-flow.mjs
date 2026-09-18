import a from "algosdk";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const cfgPath = path.join(os.homedir(), ".ripar", "mainnet.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const dep = a.mnemonicToSecretKey(cfg.merchant.mnemonic), DEP = dep.addr.toString();
const LEGEND = "LEGENDMQQJJWSQVHRFK36EP7GTM3MTI3VD3GN25YMKJ6MEBR35J4SBNVD4";
const ID = cfg.registries.identity, V = cfg.registries.validation, USDC = 31566704;
const algod = new a.Algodv2("", "https://mainnet-api.algonode.cloud", "");
if ((await algod.getTransactionParams().do()).genesisID !== "mainnet-v1.0") throw new Error("not mainnet");
const signer = a.makeBasicAccountTransactionSigner(dep);
const M = (n, ar, r) => new a.ABIMethod({ name: n, args: ar.map(t => ({ type: t })), returns: { type: r } });
const appAddr = a.getApplicationAddress(V).toString();
const vb = (nm, n) => ({ appIndex: V, name: new Uint8Array([...Buffer.from(nm), ...a.encodeUint64(n)]) });
const ab = (n) => ({ appIndex: ID, name: new Uint8Array([...Buffer.from("ag_"), ...a.encodeUint64(n)]) });
const STATE = "/tmp/ripar-mainnet-flow.json";
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
async function sp(f) { const p = await algod.getTransactionParams().do(); p.fee = f; p.flatFee = true; return p; }
async function pay(to, amt) { return { txn: a.makePaymentTxnWithSuggestedParamsFromObject({ sender: dep.addr, receiver: a.getApplicationAddress(to).toString(), amount: amt, suggestedParams: await sp(0) }), signer }; }
async function bal() { const i = await algod.accountInformation(DEP).do(); const u = (i.assets || []).find(x => Number(x.assetId) === USDC); return { algo: Number(i.amount), usdc: u ? Number(u.amount) : 0 }; }
async function step(label, fn) { const b = await bal(); const r = await fn(); const c = await bal(); console.log(`  ${label.padEnd(24)} ok   ${((b.algo - c.algo) / 1e6).toFixed(6)} ALGO`); return r; }
const BUDGET = 10_000; // 0.01 USDC — smallest clean proof: 2.5% of it is 250 micro

const stage = process.argv[2];
if (stage === "A") {
  if (!st.agentId) {
    st.domain = `mainnet-verify-${Date.now()}.ripar.io`;
    st.agentId = await step("new_agent (worker)", async () => {
      const atc = new a.AtomicTransactionComposer();
      atc.addMethodCall({ appID: ID, method: M("new_agent", ["pay", "string"], "uint64"), sender: dep.addr, signer, suggestedParams: await sp(6000),
        methodArgs: [await pay(ID, 95_000), st.domain],
        boxes: [ab(1), { appIndex: ID, name: new Uint8Array([...Buffer.from("dm_"), ...Buffer.from(st.domain)]) },
                { appIndex: ID, name: new Uint8Array([...Buffer.from("ad_"), ...a.decodeAddress(DEP).publicKey]) }] });
      return Number((await atc.execute(algod, 8)).methodResults[0].returnValue);
    });
    save(); console.log(`     agent ${st.agentId}  domain ${st.domain}`);
  }
  if (!st.jobId) {
    st.jobId = await step("post_job (0.01 USDC)", async () => {
      const atc = new a.AtomicTransactionComposer();
      atc.addMethodCall({ appID: V, method: M("post_job", ["pay", "byte[]", "uint64", "uint64"], "uint64"), sender: dep.addr, signer, suggestedParams: await sp(2000),
        methodArgs: [await pay(V, 70_000), new Uint8Array(32).fill(7), BUDGET, st.agentId], boxes: [vb("jb_", 1)] });
      return Number((await atc.execute(algod, 8)).methodResults[0].returnValue);
    });
    save(); console.log(`     job ${st.jobId}`);
  }
}
if (stage === "B") {
  const b = await bal();
  if (b.usdc < BUDGET) { console.log(`  waiting: deployer holds ${b.usdc / 1e6} USDC, needs ${BUDGET / 1e6}`); process.exit(3); }
  const J = st.jobId, AG = st.agentId;
  if (!st.funded) { await step("fund_job (real USDC)", async () => {
    const atc = new a.AtomicTransactionComposer();
    const x = { txn: a.makeAssetTransferTxnWithSuggestedParamsFromObject({ sender: dep.addr, receiver: appAddr, amount: BUDGET, assetIndex: USDC, suggestedParams: await sp(0) }), signer };
    atc.addMethodCall({ appID: V, method: M("fund_job", ["pay", "axfer", "uint64"], "uint64"), sender: dep.addr, signer, suggestedParams: await sp(3000),
      methodArgs: [await pay(V, 25_000), x, J], boxes: [vb("jb_", J), vb("es_", J)], appForeignAssets: [USDC] });
    return atc.execute(algod, 8); }); st.funded = true; save(); }
  if (!st.assigned) { await step("assign_job", async () => {
    const atc = new a.AtomicTransactionComposer();
    atc.addMethodCall({ appID: V, method: M("assign_job", ["uint64", "uint64", "uint64"], "bool"), sender: dep.addr, signer, suggestedParams: await sp(2000),
      methodArgs: [J, AG, 0], boxes: [vb("jb_", J), ab(AG)], appForeignApps: [ID] });
    return atc.execute(algod, 8); }); st.assigned = true; save(); }
  if (!st.submitted) { await step("submit_result", async () => {
    const atc = new a.AtomicTransactionComposer();
    atc.addMethodCall({ appID: V, method: M("submit_result", ["pay", "uint64", "byte[]"], "bool"), sender: dep.addr, signer, suggestedParams: await sp(3000),
      methodArgs: [await pay(V, 20_000), J, new Uint8Array(32).fill(9)], boxes: [vb("jb_", J), vb("rs_", J), ab(AG)], appForeignApps: [ID] });
    return atc.execute(algod, 8); }); st.submitted = true; save(); }
  if (!st.judged) { await step("verdict PASS", async () => {
    const atc = new a.AtomicTransactionComposer();
    atc.addMethodCall({ appID: V, method: M("validation_response", ["uint64", "bool", "uint64"], "uint64"), sender: dep.addr, signer, suggestedParams: await sp(3000),
      methodArgs: [J, true, AG], boxes: [vb("jb_", J), ab(AG)], appForeignApps: [ID] });
    return atc.execute(algod, 8); }); st.judged = true; save(); }

  // Access control on the withdrawal, BEFORE doing it: a stranger may not
  // release inside the dispute window. Simulated as LEGEND — real bytecode,
  // no signature, no cost.
  const relArgs = (sender, sgn) => ({ appID: V, method: M("release_escrow", ["uint64"], "uint64"), sender, signer: sgn,
    methodArgs: [J], boxes: [vb("jb_", J), vb("es_", J), ab(AG)], appForeignApps: [ID], appForeignAssets: [USDC], appAccounts: [DEP] });
  { const atc = new a.AtomicTransactionComposer(); atc.addMethodCall({ ...relArgs(LEGEND, a.makeEmptyTransactionSigner()), suggestedParams: await sp(5000) });
    const r = await atc.simulate(algod, new a.modelsv2.SimulateRequest({ txnGroups: [], allowEmptySignatures: true }));
    const fm = r.simulateResponse.txnGroups[0].failureMessage;
    console.log(`  stranger releases early      ${fm ? "REFUSED at pc=" + /pc=(\d+)/.exec(fm)?.[1] + "  (PASS)" : "ACCEPTED  *** FAIL ***"}`); }

  if (!st.released) {
    const out = await step("release_escrow", async () => {
      const atc = new a.AtomicTransactionComposer(); atc.addMethodCall({ ...relArgs(dep.addr, signer), suggestedParams: await sp(5000) });
      return atc.execute(algod, 8); });
    st.released = true; st.releaseTx = out.txIDs[0]; st.releaseRound = Number(out.confirmedRound); st.paid = Number(out.methodResults[0].returnValue); save();
  }
  console.log(`\n  release tx ${st.releaseTx} round ${st.releaseRound}, worker net ${st.paid}`);
}
