/**
 * Deploy the three registries with the authorisation holes closed, then prove
 * they are closed by attacking them.
 *
 * The three defects, all confirmed by an adversarial audit against the live
 * TestNet deployment:
 *
 *   ReputationRegistry.accept_feedback  read the amount off a real transfer but
 *     never checked WHERE it went, so one microUSDC moved between two addresses
 *     you own credited any agent id you named.
 *   ValidationRegistry.validation_response  authorised with
 *     `client == sender OR validator_agent_id > 0`, which is vacuous whenever a
 *     validator is named: any address could mark any job validated.
 *   ValidationRegistry.submit_result  did not check the submitter at all, with
 *     a comment saying the SDK would. A check in the SDK is not a check.
 *
 * All three now resolve the address through the IdentityRegistry by inner call,
 * because that is the one place an address-to-id binding is authenticated —
 * new_agent takes the owner from Txn.sender.
 *
 * The negative tests at the end are the point of this script. A deployment that
 * merely succeeds proves nothing about who is allowed to write.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("/tmp/testnet-e2e.json", "utf8"));
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

const deployer = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const other = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic); // the attacker
const ASSET = cfg.assetId;

const art = (name) =>
  JSON.parse(fs.readFileSync(`contracts/artifacts/${name}.arc56.json`, "utf8"));

const compile = async (teal) => {
  const r = await algod.compile(Buffer.from(teal, "utf8")).do();
  return new Uint8Array(Buffer.from(r.result, "base64"));
};

async function deploy(name) {
  const a = art(name);
  // Compile the TEAL source. arc56's `byteCode` field is ALREADY assembled, so
  // feeding it back to /compile assembles base64 as if it were source and
  // returns "unknown opcode" for every byte.
  const approval = await compile(fs.readFileSync(`contracts/artifacts/${name}.approval.teal`, "utf8"));
  const clear = await compile(fs.readFileSync(`contracts/artifacts/${name}.clear.teal`, "utf8"));

  const sp = await algod.getTransactionParams().do();
  const g = a.state?.schema?.global ?? { ints: 8, bytes: 8 };
  const txn = algosdk.makeApplicationCreateTxnFromObject({
    sender: deployer.addr,
    suggestedParams: sp,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram: approval,
    clearProgram: clear,
    numGlobalInts: (g.ints ?? 0) + 2,
    numGlobalByteSlices: (g.bytes ?? 0) + 2,
    numLocalInts: 0,
    numLocalByteSlices: 0,
  });
  const signed = txn.signTxn(deployer.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  const res = await algosdk.waitForConfirmation(algod, txid, 6);
  const appId = Number(res.applicationIndex);
  console.log(`  ${name.padEnd(19)} app ${appId}`);
  return appId;
}

/** Boxes come out of the APP account's balance, not the caller's. An unfunded
 *  app fails with a bare "account <addr>" error that names no cause. */
async function fund(appId, algos) {
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer.addr,
    receiver: algosdk.getApplicationAddress(appId).toString(),
    amount: Math.round(algos * 1e6),
    suggestedParams: sp,
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(deployer.sk)).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
}

const M = (name, args, ret) =>
  new algosdk.ABIMethod({ name, args, returns: { type: ret } });

async function call({ appId, method, args, sender = deployer, boxes = [], fee = 3000, foreignApps = [], assets = [], accounts = [], extra = [] }) {
  const sp = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  const signer = algosdk.makeBasicAccountTransactionSigner(sender);
  for (const t of extra) atc.addTransaction(t);
  atc.addMethodCall({
    appID: appId,
    method,
    methodArgs: args,
    sender: sender.addr,
    signer,
    boxes,
    appForeignApps: foreignApps,
    appForeignAssets: assets,
    appAccounts: accounts,
    suggestedParams: { ...sp, fee, flatFee: true },
  });
  const r = await atc.execute(algod, 6);
  return { value: r.methodResults[0].returnValue, txId: r.txIDs.at(-1) };
}

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const box = (app, prefix, raw) => ({ appIndex: app, name: new Uint8Array([...Buffer.from(prefix), ...raw]) });
const addrBox = (app, prefix, a) => box(app, prefix, algosdk.decodeAddress(a).publicKey);

console.log("── deploying ──");
const identity = await deploy("IdentityRegistry");
const reputation = await deploy("ReputationRegistry");
const validation = await deploy("ValidationRegistry");

console.log("\n── funding app accounts for box storage ──");
// Just enough MBR for the boxes each test writes. A box costs
// 2500 + 400*(len(name)+len(value)) microALGO, so an agent record is ~0.03.
await fund(identity, 0.5);
await fund(reputation, 0.4);
await fund(validation, 0.4);
console.log("  funded");

console.log("\n── bootstrapping ──");
await call({
  appId: reputation,
  method: M("bootstrap", [{ type: "uint64" }, { type: "uint64" }], "bool"),
  args: [identity, ASSET],
});
await call({
  appId: validation,
  method: M("bootstrap", [{ type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }], "bool"),
  // A 20-second dispute window, so the "validator never showed up" path is
  // observable inside one run. Production would be days.
  args: [identity, reputation, ASSET, 20],
});
// Named after both exist. The reputation registry is deployed first, so it
// cannot name the validation registry at bootstrap — and record_validation
// refuses every caller until this is set.
await call({
  appId: reputation,
  method: M("set_validation_app", [{ type: "uint64" }], "bool"),
  args: [validation],
});
// The app cannot receive the escrow asset until it has opted in, and it needs
// the 0.1 ALGO minimum balance for the holding first.
await fund(validation, 0.2);
await call({
  appId: validation,
  method: M("opt_in_asset", [], "bool"),
  fee: 4000,
  assets: [ASSET],
});
console.log(`  reputation -> identity ${identity}, asset ${ASSET}`);
console.log(`  validation -> identity ${identity}`);

console.log("\n── registering two agents ──");
const newAgent = M("new_agent", [{ type: "string" }], "uint64");

async function register(acct, domain, nextId) {
  const r = await call({
    appId: identity,
    method: newAgent,
    args: [domain],
    sender: acct,
    boxes: [
      addrBox(identity, "ad_", acct.addr.toString()),
      box(identity, "dm_", Buffer.from(domain)),
      box(identity, "ag_", u64(nextId)),
    ],
  });
  console.log(`  ${domain} -> agent ${r.value}`);
  return Number(r.value);
}

const serverId = await register(deployer, "ripar-agent.vercel.app", 1);
const clientId = await register(other, "client.ripar.io", 2);

/* ── the attacks ──────────────────────────────────────────────────────── */
console.log("\n── attacking the fixed contracts ──");
const results = {};
const attempt = async (label, fn, shouldFail = true) => {
  try {
    await fn();
    results[label] = !shouldFail;
    console.log(`  ${shouldFail ? "FAIL — allowed" : "PASS — allowed"}  ${label}`);
  } catch (e) {
    const msg = String(e?.message ?? "");
    const rejected = /logic eval error|assert/i.test(msg);
    results[label] = shouldFail && rejected;
    console.log(`  ${shouldFail && rejected ? "PASS — rejected" : "FAIL"}  ${label}`);
    if (!shouldFail) console.log("      " + msg.slice(0, 160));
  }
};

const acceptFeedback = M(
  "accept_feedback",
  [{ type: "axfer" }, { type: "uint64" }, { type: "uint64" }],
  "uint64"
);
const sp0 = await algod.getTransactionParams().do();

/** A transfer to whoever we like, from whoever we like. */
const transfer = (from, to, amount) =>
  algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: from.addr,
    receiver: to,
    amount,
    assetIndex: ASSET,
    suggestedParams: sp0,
  });

// 1. Pay somewhere else entirely, then claim credit for the server agent.
await attempt("a payment to a third party cannot credit an agent", async () => {
  const t = transfer(other, other.addr.toString(), 1000);
  await call({
    appId: reputation,
    method: acceptFeedback,
    args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(other) }, serverId, clientId],
    sender: other,
    fee: 5000,
    foreignApps: [identity],
    boxes: [box(reputation, "sc_", u64(serverId)), box(identity, "ag_", u64(serverId))],
  });
});

// 2. Pay the right agent, but claim the payment came from someone it did not.
await attempt("a payment from the wrong client is refused", async () => {
  const t = transfer(deployer, deployer.addr.toString(), 1000);
  await call({
    appId: reputation,
    method: acceptFeedback,
    args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(deployer) }, serverId, clientId],
    fee: 5000,
    foreignApps: [identity],
    boxes: [box(reputation, "sc_", u64(serverId)), box(identity, "ag_", u64(serverId))],
  });
});

// 3. The real thing: client pays server, credit follows.
await attempt(
  "a real client-to-server payment DOES credit",
  async () => {
    const t = transfer(other, deployer.addr.toString(), 10_000);
    const r = await call({
      appId: reputation,
      method: acceptFeedback,
      args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(other) }, serverId, clientId],
      sender: other,
      fee: 6000,
      foreignApps: [identity],
      boxes: [
        box(reputation, "sc_", u64(serverId)),
        box(identity, "ag_", u64(serverId)),
        box(identity, "ag_", u64(clientId)),
      ],
    });
    console.log("      jobs_paid now:", r.value);
  },
  false
);

/* ── validation authorisation ─────────────────────────────────────────── */
const postJob = M(
  "post_job",
  [{ type: "byte[]" }, { type: "uint64" }, { type: "uint64" }],
  "uint64"
);
const assignJob = M("assign_job", [{ type: "uint64" }, { type: "uint64" }], "bool");
const submitResult = M("submit_result", [{ type: "uint64" }, { type: "byte[]" }], "bool");
const validationResponse = M("validation_response", [{ type: "uint64" }, { type: "bool" }], "uint64");

const specHash = new Uint8Array(32).fill(7);
const jobRes = await call({
  appId: validation,
  method: postJob,
  args: [specHash, 1_000_000, clientId],
  boxes: [box(validation, "jb_", u64(1))],
});
const jobId = Number(jobRes.value);
console.log(`\n  posted job ${jobId} (validator = agent ${clientId})`);

await call({
  appId: validation,
  method: assignJob,
  args: [jobId, serverId],
  boxes: [box(validation, "jb_", u64(jobId))],
});

// 4. Someone who is not the assignee tries to submit.
await attempt("only the assigned agent may submit a result", async () => {
  await call({
    appId: validation,
    method: submitResult,
    args: [jobId, new Uint8Array(32).fill(9)],
    sender: other,
    fee: 5000,
    foreignApps: [identity],
    boxes: [box(validation, "jb_", u64(jobId)), box(identity, "ag_", u64(serverId))],
  });
});

// The real assignee submits.
await attempt(
  "the assignee CAN submit",
  async () => {
    await call({
      appId: validation,
      method: submitResult,
      args: [jobId, new Uint8Array(32).fill(9)],
      fee: 5000,
      foreignApps: [identity],
      boxes: [box(validation, "jb_", u64(jobId)), box(identity, "ag_", u64(serverId))],
    });
  },
  false
);

// 5. The old hole: a stranger marking a job validated.
await attempt("a stranger cannot mark a job validated", async () => {
  await call({
    appId: validation,
    method: validationResponse,
    args: [jobId, true],
    sender: deployer, // the client, but a VALIDATOR was named — so not permitted
    fee: 5000,
    foreignApps: [identity],
    boxes: [box(validation, "jb_", u64(jobId)), box(identity, "ag_", u64(clientId))],
  });
});

// The named validator judges it.
await attempt(
  "the named validator CAN judge",
  async () => {
    const r = await call({
      appId: validation,
      method: validationResponse,
      args: [jobId, true],
      sender: other,
      // Two inner calls now: agent_address on identity, record_validation on
      // reputation. A short fee fails with a pooling error that reads like a
      // network problem.
      fee: 8000,
      foreignApps: [identity, reputation],
      boxes: [
        box(validation, "jb_", u64(jobId)),
        box(identity, "ag_", u64(clientId)),
        box(reputation, "sc_", u64(serverId)),
      ],
    });
    console.log("      status now:", r.value, "(3 = VALIDATED)");
  },
  false
);

/* ── escrow: the one place Ripar takes custody ────────────────────────── */
console.log("\n── escrow ──");

const fundJob = M("fund_job", [{ type: "axfer" }, { type: "uint64" }], "uint64");
const releaseEscrow = M("release_escrow", [{ type: "uint64" }], "uint64");
const refundEscrow = M("refund_escrow", [{ type: "uint64" }], "uint64");
const getEscrow = M("get_escrow", [{ type: "uint64" }], "uint64");
const setValidator = M("set_validator", [{ type: "uint64" }, { type: "uint64" }], "bool");

const appAddr = algosdk.getApplicationAddress(validation).toString();
const bal = async (a) => {
  const acc = await algod.accountInformation(a).do();
  const h = (acc.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET);
  return Number(h?.amount ?? 0);
};

// A second job, funded, so the money path is exercised end to end.
const spec2 = new Uint8Array(32).fill(11);
const job2 = Number(
  (await call({
    appId: validation,
    method: postJob,
    args: [spec2, 500_000, clientId],
    boxes: [box(validation, "jb_", u64(2))],
  })).value
);
console.log(`  posted job ${job2}`);

// A stranger cannot fund somebody else's job into escrow.
await attempt("only the client may fund their own job", async () => {
  const sp = await algod.getTransactionParams().do();
  const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: other.addr, receiver: appAddr, amount: 1000, assetIndex: ASSET, suggestedParams: sp,
  });
  await call({
    appId: validation, method: fundJob,
    args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(other) }, job2],
    sender: other, fee: 4000, assets: [ASSET],
    boxes: [box(validation, "jb_", u64(job2)), box(validation, "es_", u64(job2))],
  });
});

// The client funds it for real.
const merchantBefore = await bal(deployer.addr.toString());
await attempt("the client CAN fund their job", async () => {
  const sp = await algod.getTransactionParams().do();
  const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: deployer.addr, receiver: appAddr, amount: 500_000, assetIndex: ASSET, suggestedParams: sp,
  });
  const r = await call({
    appId: validation, method: fundJob,
    args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(deployer) }, job2],
    fee: 4000, assets: [ASSET],
    boxes: [box(validation, "jb_", u64(job2)), box(validation, "es_", u64(job2))],
  });
  console.log("      escrow held:", Number(r.value) / 1e6);
}, false);

const heldOnChain = await bal(appAddr);
console.log("  app account really holds:", heldOnChain / 1e6, "rUSDC");

// Releasing before the work passed must fail — the status gate, not a balance check.
await attempt("escrow cannot be released before the work passes", async () => {
  await call({
    appId: validation, method: releaseEscrow, args: [job2],
    fee: 5000, foreignApps: [identity], assets: [ASSET],
    accounts: [deployer.addr.toString()],
    boxes: [box(validation, "jb_", u64(job2)), box(validation, "es_", u64(job2)), box(identity, "ag_", u64(serverId))],
  });
});

// Drive job 2 to VALIDATED so release becomes legal.
await call({ appId: validation, method: assignJob, args: [job2, serverId], boxes: [box(validation, "jb_", u64(job2))] });
await call({
  appId: validation, method: submitResult, args: [job2, new Uint8Array(32).fill(12)],
  fee: 5000, foreignApps: [identity],
  boxes: [box(validation, "jb_", u64(job2)), box(identity, "ag_", u64(serverId))],
});
await call({
  appId: validation, method: validationResponse, args: [job2, true],
  sender: other, fee: 8000, foreignApps: [identity, reputation],
  boxes: [
    box(validation, "jb_", u64(job2)),
    box(identity, "ag_", u64(clientId)),
    box(reputation, "sc_", u64(serverId)),
  ],
});

// A stranger cannot release inside the dispute window.
await attempt("a stranger cannot release inside the dispute window", async () => {
  await call({
    appId: validation, method: releaseEscrow, args: [job2],
    sender: other, fee: 5000, foreignApps: [identity], assets: [ASSET],
    accounts: [deployer.addr.toString()],
    boxes: [box(validation, "jb_", u64(job2)), box(validation, "es_", u64(job2)), box(identity, "ag_", u64(serverId))],
  });
});

// The client can, immediately. The assignee is agent 1, whose address is the
// deployer — so the money comes back to where it started, which is fine: what
// is being proved is that the CONTRACT moved it, not who ended up with it.
const assigneeBefore = await bal(deployer.addr.toString());
await attempt("the client CAN release once the work passed", async () => {
  const r = await call({
    appId: validation, method: releaseEscrow, args: [job2],
    fee: 5000, foreignApps: [identity], assets: [ASSET],
    accounts: [deployer.addr.toString()],
    boxes: [box(validation, "jb_", u64(job2)), box(validation, "es_", u64(job2)), box(identity, "ag_", u64(serverId))],
  });
  console.log("      released:", Number(r.value) / 1e6, "rUSDC");
}, false);

const assigneeAfter = await bal(deployer.addr.toString());
const appAfter = await bal(appAddr);
console.log("  assignee gained:", (assigneeAfter - assigneeBefore) / 1e6);
console.log("  app account now :", appAfter / 1e6);

// And it cannot be released twice: the box is cleared before the transfer.
await attempt("escrow cannot be released twice", async () => {
  await call({
    appId: validation, method: releaseEscrow, args: [job2],
    fee: 5000, foreignApps: [identity], assets: [ASSET],
    accounts: [deployer.addr.toString()],
    boxes: [box(validation, "jb_", u64(job2)), box(validation, "es_", u64(job2)), box(identity, "ag_", u64(serverId))],
  });
});

// set_validator is client-only and open-only.
await attempt("a stranger cannot rename the validator", async () => {
  await call({
    appId: validation, method: setValidator, args: [job2, serverId],
    sender: other, boxes: [box(validation, "jb_", u64(job2))],
  });
});

results["the escrow really moved on chain"] =
  heldOnChain >= 500_000 && assigneeAfter - assigneeBefore === 500_000 && appAfter === 0;
console.log(
  `  ${results["the escrow really moved on chain"] ? "PASS" : "FAIL"}  the escrow really moved on chain`
);

/* ── the verdict has to reach the score ────────────────────────────────── */
console.log("\n── does a verdict reach the score? ──");
const scoreBox = await algod
  .getApplicationBoxByName(reputation, new Uint8Array([...Buffer.from("sc_"), ...u64(serverId)]))
  .do()
  .then((b) => Buffer.from(b.value))
  .catch(() => null);

if (scoreBox) {
  const validated = Number(scoreBox.readBigUInt64BE(24));
  const disputed = Number(scoreBox.readBigUInt64BE(32));
  console.log(`  score: validated ${validated}, disputed ${disputed}`);
  // Two jobs were judged and passed in this run. Before record_validation was
  // wired through, both counters sat at 0 while the jobs read VALIDATED — and
  // a reader comparing the two had no way to tell which number was wrong.
  results["a passing verdict reaches the agent's score"] = validated === 2 && disputed === 0;
  console.log(
    `  ${results["a passing verdict reaches the agent's score"] ? "PASS" : "FAIL"}  a passing verdict reaches the agent's score`
  );
} else {
  results["a passing verdict reaches the agent's score"] = false;
  console.log("  FAIL  no score box at all");
}

// And nobody but the ValidationRegistry may write one.
await attempt("an address cannot record a verdict directly", async () => {
  await call({
    appId: reputation,
    method: M("record_validation", [{ type: "uint64" }, { type: "bool" }], "bool"),
    args: [serverId, true],
    sender: other,
    boxes: [box(reputation, "sc_", u64(serverId))],
  });
});

console.log("\n── verdict ──");
const ok = Object.values(results).every(Boolean);
for (const [k, v] of Object.entries(results)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);

const out = {
  network: "testnet",
  deployer: deployer.addr.toString(),
  registries: { identity, reputation, validation },
  agents: { server: serverId, client: clientId },
  asset: ASSET,
};
fs.writeFileSync("/tmp/registries-v2.json", JSON.stringify(out, null, 2));
console.log("\n" + JSON.stringify(out, null, 2));
process.exit(ok ? 0 : 1);
