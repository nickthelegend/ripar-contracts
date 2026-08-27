# ripar-contracts

The on-chain half of [Ripar](https://ripar.io): three registries that give an
agent an identity, a reputation nobody can type by hand, and an escrow that pays
out on a verdict.

They are a port of the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
identity / reputation / validation triad to Algorand, written in Algorand Python
and compiled with PuyaPy.

## Deployed

**TestNet — live and in use**

| Registry | App ID | What it holds |
| --- | --- | --- |
| Identity | [`769444119`](https://lora.algokit.io/testnet/application/769444119) | one `ag_` box per agent: id, domain, controlling address |
| Reputation | [`769444120`](https://lora.algokit.io/testnet/application/769444120) | one `sc_` box per agent: jobs paid, volume, verdicts |
| Validation | [`769444121`](https://lora.algokit.io/testnet/application/769444121) | jobs, bids and escrow, settled in USDC `10458941` |

**MainNet — not deployed yet.** This section will carry the app ids and an
explorer link when it is. It does not carry placeholders in the meantime.

## The escrow, end to end

```
post_job ──▶ place_bid ──▶ accept_bid ──▶ fund_job ──▶ submit_result
                                                            │
                                              validation_response
                                                            │
                                            ┌───────────────┴───────────────┐
                                       VALIDATED                       DISPUTED
                                            │                               │
                                    release_escrow                  refund_escrow
                                     (or release_partial)            (to the client)
```

Money only moves on the last step, and only in the direction the verdict points.

### The liveness escape

A validator who stops answering must not be able to freeze a worker's money.
Once `dispute_window` has passed since a result was submitted, **anyone** may
call `expire_verdict` to mark the job validated, and **anyone** may then call
`release_escrow`. The worker does not need the validator's cooperation to be paid.

TestNet runs a 300-second window so the test suite does not have to wait.
MainNet is configured for 259200 seconds (72 hours).

## The protocol fee

**Currently zero. Nothing is being skimmed.** `fee_bps` is `0` and `treasury` is
the zero address on the live registry — you can verify that yourself in the
global state at the link above.

If it is ever set:

- **`set_fee(fee_bps, treasury)` is creator-only and works exactly once.** There is no setter to raise it later. A fee that can move after work is accepted is a fee the assignee never agreed to.
- **It is capped at 250 basis points (2.5%).** The contract refuses 251.
- **It is taken on release, not on funding.** The client escrows exactly the budget they agreed to; the fee comes out of the settlement.
- **It applies identically to `release_escrow` and `release_partial`.** (It did not, until an audit found the whole escrow could be drained fee-free by asking for it in parts.)
- **The treasury must already hold the escrow asset.** An Algorand account cannot receive an ASA it has not opted into, and the fee transfer is an inner transaction of the payout — so a treasury that never opted in would make every payout fail forever, unfixably, because `set_fee` is one-shot. The contract now checks this before accepting the address.

Every payout emits an ARC-28 `EscrowPaid` event carrying the job id, the payee,
the amount paid and the fee taken, so treasury income is attributable to a job
without replaying box state.

## Getting what you are owed

There is no "withdraw" button, because Ripar never holds your money.

- **For a paid HTTP call (x402):** settlement is a direct USDC transfer from the caller to your payout address. It is already yours the moment the transaction confirms. Nothing to withdraw.
- **For an escrowed job:** the client calls `release_escrow` on a passing verdict, or `release_partial` for a milestone. If the validator has gone quiet, wait out the dispute window and call `expire_verdict` then `release_escrow` yourself — neither requires the client or the validator.
- **For a bid you no longer want:** `withdraw_bid`, callable only by the bidder.

## Build and test

```bash
python -m puyapy contracts/validation_registry.py \
  contracts/identity_registry.py \
  contracts/reputation_registry.py \
  --out-dir "$(pwd)/contracts/artifacts"

pytest tests/          # 43 tests, no chain required
```

The suite runs against `algorand-python-testing`, so the time-dependent guards —
the dispute window, `expire_verdict` — are asserted on both sides of the boundary
in the same millisecond instead of costing a real 300 seconds each.

**`--out-dir` must be absolute.** PuyaPy resolves it relative to the source file,
so a relative path silently writes to `contracts/contracts/artifacts/` and leaves
the real artifacts stale — which is how a deploy can ship a contract that does
not match the source it was audited from.

## Deploying

```bash
RIPAR_CONFIG=mainnet.json \
RIPAR_NETWORK=mainnet \
ALGOD_URL=https://mainnet-api.algonode.cloud \
node deploy-mainnet.mjs
```

Copy `mainnet-config.example.json` to `~/.ripar/mainnet.json` and fill in the
mnemonic yourself. **The default config is a TestNet one** carrying asset
`10458941` and a 300-second window; `bootstrap` takes both permanently and cannot
be re-run, so pointing it at MainNet would mint a registry settling in an asset
nobody holds on that chain.

Measured cost to deploy all three: **~1.41 ALGO** (1.206 of that is app-creation
minimum balance — measured on chain, not estimated from the schema, because the
schema formula under-counts it).
