/**
 * Stand up a complete Ripar chain on LocalNet.
 *
 * TestNet work is gated on two faucets: ALGO from a dispenser and USDC from one
 * behind a login. That is fine for proving a deployment once and useless for
 * proving it repeatedly. LocalNet has neither gate, so the whole system —
 * registries, settlement asset, funded accounts — can be rebuilt from nothing
 * in about a minute and torn down without stranding anything.
 *
 * What this does NOT do is invent a chain that behaves differently. LocalNet
 * runs the same algod, the same AVM and the same consensus rules; a contract
 * that passes here fails on TestNet only for reasons of funding or state, not
 * of semantics.
 *
 * The settlement asset is created here rather than referenced by id. There is
 * no "real USDC" on a chain that started sixty seconds ago — asset ids are
 * per-chain, so 10458941 means nothing here. What matters is that ONE asset is
 * used by the 402 quote and by the registries alike, which is the property that
 * was broken on TestNet.
 *
 *   algokit localnet start
 *   node localnet-setup.mjs
 */
import algosdk from "algosdk";
import fs from "node:fs";

const ALGOD_URL = process.env.ALGOD_URL ?? "http://localhost";
const ALGOD_PORT = process.env.ALGOD_PORT ?? "4001";
const TOKEN = process.env.ALGOD_TOKEN ?? "a".repeat(64);
const KMD_PORT = process.env.KMD_PORT ?? "4002";
const OUT = process.env.RIPAR_E2E_CONFIG ?? "/tmp/localnet-e2e.json";

const algod = new algosdk.Algodv2(TOKEN, ALGOD_URL, ALGOD_PORT);
const kmd = new algosdk.Kmd(TOKEN, ALGOD_URL, KMD_PORT);

const send = async (txn, sk) => {
  const { txid } = await algod.sendRawTransaction(txn.signTxn(sk)).do();
  return algosdk.waitForConfirmation(algod, txid, 6);
};

/* ── a funded account to pay for everything ─────────────────────────────── */

const wallets = await kmd.listWallets();
const wallet = wallets.wallets.find((w) => w.name === "unencrypted-default-wallet");
if (!wallet) throw new Error("no unencrypted-default-wallet — is LocalNet running?");
const handle = (await kmd.initWalletHandle(wallet.id, "")).wallet_handle_token;
const addresses = (await kmd.listKeys(handle)).addresses;

let funder = null;
for (const addr of addresses) {
  const info = await algod.accountInformation(addr).do();
  if (Number(info.amount) > 100_000_000) {
    const { private_key } = await kmd.exportKey(handle, "", addr);
    funder = { addr, sk: private_key };
    break;
  }
}
if (!funder) throw new Error("no LocalNet account with a usable balance");
console.log(`funder    ${funder.addr.slice(0, 16)}…`);

/* ── the two roles every script expects ─────────────────────────────────── */

const payer = algosdk.generateAccount();
const merchant = algosdk.generateAccount();

for (const [role, acct] of [["payer", payer], ["merchant", merchant]]) {
  const sp = await algod.getTransactionParams().do();
  await send(
    algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: funder.addr,
      receiver: acct.addr,
      amount: 100_000_000, // 100 ALGO — box storage and app MBR come out of this
      suggestedParams: sp,
    }),
    funder.sk
  );
  console.log(`${role.padEnd(9)} ${String(acct.addr).slice(0, 16)}…  100 ALGO`);
}

/* ── the settlement asset ───────────────────────────────────────────────── */

const sp = await algod.getTransactionParams().do();
const created = await send(
  algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender: funder.addr,
    total: 1_000_000_000_000n,
    decimals: 6,
    defaultFrozen: false,
    unitName: "USDC",
    assetName: "USD Coin",
    manager: funder.addr,
    reserve: funder.addr,
    suggestedParams: sp,
  }),
  funder.sk
);
const assetId = Number(created.assetIndex);
console.log(`asset     ${assetId}  USDC, 6 decimals`);

// Opt both roles in, then fund the payer. An ASA transfer to an account that
// has not opted in is rejected at consensus, so this ordering is not optional.
for (const acct of [payer, merchant]) {
  const p = await algod.getTransactionParams().do();
  await send(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: acct.addr,
      receiver: acct.addr,
      amount: 0,
      assetIndex: assetId,
      suggestedParams: p,
    }),
    acct.sk
  );
}
// BOTH roles get a balance. The merchant is the payee for x402 calls, but it is
// also the CLIENT that posts and funds jobs — deploy-v2 has it escrow 0.4 USDC —
// so an opt-in alone leaves the deploy failing deep in the attack suite with
// "underflow on subtracting 400000 from sender amount 10000", which reads like a
// contract bug rather than an unfunded account.
for (const acct of [payer, merchant]) {
  const p2 = await algod.getTransactionParams().do();
  await send(
    algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: funder.addr,
      receiver: acct.addr,
      amount: 1_000_000_000, // 1,000 USDC
      assetIndex: assetId,
      suggestedParams: p2,
    }),
    funder.sk
  );
}
console.log(`          payer and merchant hold 1000.00 USDC each`);

/* ── what every other script reads ──────────────────────────────────────── */

fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      network: "localnet",
      assetId,
      // LocalNet stamps each block ~25s ahead of the last, so a window measured
      // in seconds closes before the next call lands. 300 leaves room for the
      // several blocks a job setup costs while staying observable in one run.
      disputeWindowSecs: 300,
      payer: { addr: payer.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(payer.sk) },
      merchant: { addr: merchant.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(merchant.sk) },
      funder: funder.addr.toString(),
    },
    null,
    2
  ) + "\n"
);

const params = await algod.getTransactionParams().do();
// CAIP-2 per the Algorand namespace profile: URL-safe base64 of the genesis
// hash, first 32 characters. Ripar registers the glob "algorand:*", so this is
// informational — but a facilitator has to advertise the exact string.
const caip2 =
  "algorand:" +
  Buffer.from(params.genesisHash).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").slice(0, 32);

console.log(`\nwrote ${OUT}`);
console.log(`genesis   ${params.genesisId ?? params["genesis-id"]}`);
console.log(`caip-2    ${caip2}`);
console.log(`\nexport RIPAR_E2E_CONFIG=${OUT}`);
console.log(`export ALGOD_URL=${ALGOD_URL} ALGOD_PORT=${ALGOD_PORT} ALGOD_TOKEN=${TOKEN.slice(0, 4)}…`);
