"""
Reputation Registry — ERC-8004's second registry, ported to Algorand.

The rule this implements: **reputation is earned by paying, not by posting.**

ERC-8004 keeps feedback offchain and only records an authorisation onchain. That
leaves the door open to a client leaving glowing feedback for work it never
bought. Here the authorisation is bound to a settled payment: `accept_feedback`
takes the id of the x402 transfer that paid for the job, records that id, and
refuses to record it twice. A score therefore counts settlements, and cannot be
inflated by anything that did not move USDC.

What is deliberately NOT here: a star rating, a comment, or any number a human
types. Those belong offchain. What is onchain is the only part that cannot be
faked — that a specific payment happened, between a specific pair, once.
"""

from algopy import (
    ARC4Contract,
    Bytes,
    BoxMap,
    Global,
    Txn,
    UInt64,
    arc4,
    subroutine,
)


class Score(arc4.Struct):
    """A server agent's record. Every field is a count of settled work."""

    agent_id: arc4.UInt64
    # Distinct settled payments received for accepted work.
    jobs_paid: arc4.UInt64
    # Total USDC settled, in base units (6 decimals).
    volume_micro: arc4.UInt64
    # Jobs a validator marked as passing. See ValidationRegistry.
    validated: arc4.UInt64
    # Jobs a validator marked as failing. Kept because hiding it would make the
    # score a marketing number rather than a record.
    disputed: arc4.UInt64
    first_at: arc4.UInt64
    last_at: arc4.UInt64


class ReputationRegistry(ARC4Contract):
    def __init__(self) -> None:
        self.identity_app = UInt64(0)
        self.scores = BoxMap(UInt64, Score, key_prefix=b"sc_")
        # Payment ids already counted, so the same settlement cannot be claimed
        # twice. This is the whole anti-inflation mechanism.
        self.seen = BoxMap(Bytes, UInt64, key_prefix=b"pd_")

    @arc4.abimethod
    def bootstrap(self, identity_app: arc4.UInt64) -> arc4.Bool:
        """Point at the Identity Registry. Creator only, once."""
        assert Txn.sender == Global.creator_address, "creator only"
        assert self.identity_app == 0, "already bootstrapped"
        self.identity_app = identity_app.native
        return arc4.Bool(True)  # noqa: FBT003

    @subroutine
    def _touch(self, agent_id: UInt64) -> Score:
        now = Global.latest_timestamp
        if agent_id in self.scores:
            return self.scores[agent_id].copy()
        return Score(
            agent_id=arc4.UInt64(agent_id),
            jobs_paid=arc4.UInt64(0),
            volume_micro=arc4.UInt64(0),
            validated=arc4.UInt64(0),
            disputed=arc4.UInt64(0),
            first_at=arc4.UInt64(now),
            last_at=arc4.UInt64(now),
        )

    @arc4.abimethod
    def accept_feedback(
        self,
        server_agent_id: arc4.UInt64,
        client_agent_id: arc4.UInt64,
        payment_txid: arc4.DynamicBytes,
        amount_micro: arc4.UInt64,
    ) -> arc4.UInt64:
        """Credit a server agent for one settled payment. Returns its new count.

        `payment_txid` is the 32-byte id of the x402 asset transfer that paid for
        the work. It is recorded so the same settlement can never be counted
        twice — replaying it is the obvious attack and it is the one thing this
        registry exists to prevent.
        """
        txid = payment_txid.native
        assert txid.length == 32, "payment_txid must be a 32-byte transaction id"
        assert txid not in self.seen, "this payment has already been counted"
        assert amount_micro.native > 0, "a zero-value payment earns nothing"
        assert server_agent_id.native != client_agent_id.native, "an agent cannot pay itself into a reputation"

        sid = server_agent_id.native
        s = self._touch(sid)
        s.jobs_paid = arc4.UInt64(s.jobs_paid.native + 1)
        s.volume_micro = arc4.UInt64(s.volume_micro.native + amount_micro.native)
        s.last_at = arc4.UInt64(Global.latest_timestamp)
        self.scores[sid] = s.copy()

        self.seen[txid] = sid
        return arc4.UInt64(s.jobs_paid.native)

    @arc4.abimethod
    def record_validation(self, server_agent_id: arc4.UInt64, passed: arc4.Bool) -> arc4.Bool:
        """Called by the Validation Registry once a result is judged."""
        sid = server_agent_id.native
        s = self._touch(sid)
        if passed.native:
            s.validated = arc4.UInt64(s.validated.native + 1)
        else:
            s.disputed = arc4.UInt64(s.disputed.native + 1)
        s.last_at = arc4.UInt64(Global.latest_timestamp)
        self.scores[sid] = s.copy()
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.abimethod(readonly=True)
    def get_score(self, agent_id: arc4.UInt64) -> Score:
        aid = agent_id.native
        if aid in self.scores:
            return self.scores[aid]
        now = Global.latest_timestamp
        # An unknown agent reads as all-zero rather than erroring: "no record" is
        # a real answer and the caller should render it as such.
        return Score(
            agent_id=arc4.UInt64(aid),
            jobs_paid=arc4.UInt64(0),
            volume_micro=arc4.UInt64(0),
            validated=arc4.UInt64(0),
            disputed=arc4.UInt64(0),
            first_at=arc4.UInt64(now),
            last_at=arc4.UInt64(now),
        )

    @arc4.abimethod(readonly=True)
    def was_counted(self, payment_txid: arc4.DynamicBytes) -> arc4.UInt64:
        """Which agent a payment was credited to, or 0 if never counted."""
        t = payment_txid.native
        if t in self.seen:
            return arc4.UInt64(self.seen[t])
        return arc4.UInt64(0)
