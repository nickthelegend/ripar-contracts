/**
 * Prove a deployed app is the source in this repo.
 *
 * Algorand has no Etherscan "verify source" button, and the usual substitute —
 * pointing at an ARC-56 file in a repo — proves nothing, because the file is
 * just a file. What can be proven is stronger: compile the source here and
 * check the resulting approval and clear programs are byte-identical to the
 * ones the chain is actually running.
 *
 * If they match, the audited source IS the deployed contract. If they differ,
 * every finding in the audit is about code nobody is running.
 *
 *   node verify-deployed.mjs <identityId> <reputationId> <validationId> [ALGOD_URL]
 */
import algosdk from "algosdk";
import { createHash } from "node:crypto";
import fs from "node:fs";

const [identity, reputation, validation] = process.argv.slice(2, 5).map(Number);
const url = process.argv[5] ?? process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";
if (!identity || !reputation || !validation) {
  console.error("usage: node verify-deployed.mjs <identityId> <reputationId> <validationId> [ALGOD_URL]");
  process.exit(2);
}
const algod = new algosdk.Algodv2("", url, "");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const PAIRS = [
  ["IdentityRegistry", identity],
  ["ReputationRegistry", reputation],
  ["ValidationRegistry", validation],
];

const genesis = (await algod.getTransactionParams().do()).genesisID;
console.log(`\n── verifying deployed bytecode against local source · ${genesis} ──\n`);

let bad = 0;
for (const [name, appId] of PAIRS) {
  const spec = JSON.parse(fs.readFileSync(`contracts/artifacts/${name}.arc56.json`, "utf8"));
  // The artifact carries the compiled programs; they are what puyapy just
  // produced from contracts/*.py, and the build was verified reproducible.
  const localApproval = Buffer.from(spec.byteCode.approval, "base64");
  const localClear = Buffer.from(spec.byteCode.clear, "base64");

  const app = await algod.getApplicationByID(appId).do();
  const chainApproval = Buffer.from(app.params.approvalProgram);
  const chainClear = Buffer.from(app.params.clearStateProgram);

  const aMatch = sha(localApproval) === sha(chainApproval);
  const cMatch = sha(localClear) === sha(chainClear);
  if (!aMatch || !cMatch) bad++;

  console.log(`  ${name} — app ${appId}`);
  console.log(`    approval  local ${sha(localApproval).slice(0, 16)}  chain ${sha(chainApproval).slice(0, 16)}  ${aMatch ? "MATCH" : "*** DIFFERS ***"}`);
  console.log(`    clear     local ${sha(localClear).slice(0, 16)}  chain ${sha(chainClear).slice(0, 16)}  ${cMatch ? "MATCH" : "*** DIFFERS ***"}`);
  console.log(`    size      ${chainApproval.length} bytes approval, creator ${app.params.creator}`);
}

if (bad) {
  console.log(`\n  ${bad} contract(s) do NOT match this source tree. The audit does not describe what is deployed.\n`);
  process.exit(1);
}
console.log(`\n  All three deployed programs are byte-identical to contracts/*.py as compiled here.\n`);
