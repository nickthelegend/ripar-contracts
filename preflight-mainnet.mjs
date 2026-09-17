/**
 * Refuse a MainNet deploy that would be wrong in a way nothing can undo.
 *
 * `bootstrap` asserts its fields are zero, so the escrow asset and the dispute
 * window are written exactly once per app id. A deploy that names the TestNet
 * asset on MainNet does not fail — it succeeds, mints three permanent app ids,
 * locks the creator's ALGO in minimum balance, and produces registries whose
 * escrow is denominated in an asset nobody on that network holds. The only
 * repair is to deploy again and repoint every repo.
 *
 * `set_fee` is worse: one-shot, and a treasury that has not opted into the
 * escrow asset makes release_escrow, refund_escrow and release_partial revert
 * forever, freezing every cent ever escrowed. The contract now checks the
 * opt-in itself — this checks it BEFORE any money is spent getting there.
 *
 * So this runs first, reads only, spends nothing, and exits non-zero on
 * anything that cannot be corrected later. It never prints a key.
 *
 *   ALGOD_URL=https://mainnet-api.algonode.cloud \
 *   RIPAR_CONFIG=mainnet.json node preflight-mainnet.mjs [treasuryAddress]
 */
import algosdk from "algosdk";
import fs from "node:fs";
import { configPath } from "./config-path.mjs";

const MAINNET_USDC = 31566704;
const MIN_DISPUTE_WINDOW = 3600;

// Deploy cost, itemised rather than guessed. Matches deploy-mainnet.mjs:
// three app creations at 0.1 creator MBR each, the three app-account box
// fundings, the 0.2 that covers the ValidationRegistry's USDC opt-in, and fees.
const COST = {
  "app creation MBR (3 x 0.1, locked while the apps exist)": 0.3,
  "identity app box funding": 0.35,
  "reputation app box funding": 0.25,
  "validation app box funding": 0.85,
  "validation USDC opt-in funding": 0.2,
  "transaction fees (~10, some with op-up)": 0.05,
};
const DEPLOY_ALGO = Object.values(COST).reduce((a, b) => a + b, 0);
// Phase 4 — register an agent, post and fund a job, release it, opt the
// treasury in. Separate because a deploy-only run does not need it.
const VERIFY_ALGO = 0.94;

const fail = [];
const warn = [];
const ok = [];

const url = process.env.ALGOD_URL;
if (!url) {
  console.error("ALGOD_URL is required — this script will not guess a network.");
  process.exit(2);
}
const algod = new algosdk.Algodv2(process.env.ALGOD_TOKEN ?? "", url, process.env.ALGOD_PORT ?? "");

const cfgName = process.env.RIPAR_CONFIG ?? "testnet-e2e.json";
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath(cfgName), "utf8"));
} catch (e) {
  console.error(`cannot read config ${cfgName}: ${e.message}`);
  process.exit(2);
}

// Which chain is actually on the other end of ALGOD_URL — asked, not inferred
// from the hostname, because a hostname is a string anyone can typo.
const params = await algod.getTransactionParams().do();
const genesis = params.genesisID;
const isMainnet = genesis === "mainnet-v1.0";
ok.push(`node ${url} is genesis ${genesis}`);

if (!isMainnet) {
  warn.push(`genesis is ${genesis}, not mainnet-v1.0 — mainnet-only checks are advisory here`);
}

// ── the irreversible ones ────────────────────────────────────────────────────
const asset = Number(cfg.assetId);
if (!asset) fail.push("config has no assetId");
else if (isMainnet && asset !== MAINNET_USDC) {
  fail.push(
    `assetId is ${asset}, but MainNet USDC is ${MAINNET_USDC}. bootstrap takes this ` +
      `ONCE — deploying with the wrong asset cannot be corrected, only redeployed.`
  );
} else {
  try {
    const a = await algod.getAssetByID(asset).do();
    const p = a.params;
    ok.push(`asset ${asset} = ${p.name} (${p.unitName}), ${p.decimals} decimals, on this chain`);
    if (Number(p.decimals) !== 6) fail.push(`asset ${asset} has ${p.decimals} decimals, expected 6`);
  } catch {
    fail.push(`asset ${asset} does not exist on ${genesis} — bootstrap would lock a dead asset id`);
  }
}

const win = Number(cfg.disputeWindowSecs ?? 0);
if (!win) fail.push("config has no disputeWindowSecs");
else if (isMainnet && win < MIN_DISPUTE_WINDOW)
  fail.push(`disputeWindowSecs is ${win}, below the ${MIN_DISPUTE_WINDOW}s floor; it is one-shot`);
else ok.push(`dispute window ${win}s`);

// ── the deployer, by address only ────────────────────────────────────────────
let deployerAddr = null;
try {
  deployerAddr = algosdk.mnemonicToSecretKey(cfg.merchant?.mnemonic ?? cfg.mnemonic).addr.toString();
} catch {
  fail.push(`config ${cfgName} has no readable deployer key (expected .merchant.mnemonic or .mnemonic)`);
}

let spendable = 0;
if (deployerAddr) {
  ok.push(`deployer ${deployerAddr}`);
  try {
    const acct = await algod.accountInformation(deployerAddr).do();
    const bal = Number(acct.amount) / 1e6;
    const min = Number(acct.minBalance ?? 0) / 1e6;
    spendable = bal - min;
    const need = DEPLOY_ALGO + VERIFY_ALGO;
    if (spendable < need)
      fail.push(
        `deployer holds ${spendable.toFixed(6)} spendable ALGO, needs ${need.toFixed(2)} ` +
          `(${DEPLOY_ALGO.toFixed(2)} deploy + ${VERIFY_ALGO.toFixed(2)} live verification)`
      );
    else ok.push(`deployer spendable ${spendable.toFixed(6)} ALGO covers ${need.toFixed(2)}`);

    const held = (acct.assets ?? []).find((x) => Number(x.assetId) === asset);
    if (!held) warn.push(`deployer is not opted into asset ${asset} — needed to fund a job in Phase 4`);
    else ok.push(`deployer holds ${(Number(held.amount) / 1e6).toFixed(6)} of asset ${asset}`);
  } catch {
    fail.push(`deployer account does not exist on ${genesis} (0 ALGO) — fund it first`);
  }
}

// ── the treasury, if one was named ───────────────────────────────────────────
const treasury = process.argv[2];
if (treasury) {
  if (!algosdk.isValidAddress(treasury)) fail.push(`treasury ${treasury} is not a valid Algorand address`);
  else {
    try {
      const t = await algod.accountInformation(treasury).do();
      const held = (t.assets ?? []).find((x) => Number(x.assetId) === asset);
      if (!held)
        fail.push(
          `treasury ${treasury} is NOT opted into asset ${asset}. set_fee is one-shot and the ` +
            `contract rejects an un-opted-in treasury — opt in before calling it.`
        );
      else ok.push(`treasury ${treasury} is opted into asset ${asset}`);
    } catch {
      fail.push(`treasury ${treasury} does not exist on ${genesis}`);
    }
  }
} else {
  warn.push("no treasury address given — set_fee is one-shot, so pass it here to have it checked");
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\n── preflight: ${cfgName} against ${genesis} ──\n`);
for (const l of ok) console.log(`  ok    ${l}`);
for (const l of warn) console.log(`  warn  ${l}`);
for (const l of fail) console.log(`  FAIL  ${l}`);

console.log("\n  estimated cost");
for (const [k, v] of Object.entries(COST)) console.log(`    ${v.toFixed(3)}  ${k}`);
console.log(`    ${DEPLOY_ALGO.toFixed(3)}  deploy subtotal`);
console.log(`    ${VERIFY_ALGO.toFixed(3)}  live fee + withdrawal verification`);
console.log(`    ${(DEPLOY_ALGO + VERIFY_ALGO).toFixed(3)}  TOTAL ALGO`);

if (fail.length) {
  console.log(`\n  ${fail.length} blocking problem(s). Nothing was sent.\n`);
  process.exit(1);
}
console.log(`\n  clear to deploy. Nothing was sent by this script.\n`);
