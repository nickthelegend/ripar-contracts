"""
Validation Registry — ERC-8004's third registry, plus the job board.

ERC-8004 splits this into request and response: a client asks a validator to
judge some work, the validator answers, and the answer is onchain. That is kept
here, and a job lifecycle is added around it, because a validation with no job
attached is an opinion about nothing.

The lifecycle is deliberately narrow:

    open -> assigned -> submitted -> validated | disputed

A job can only be assigned to an agent that exists in the Identity Registry, only
the assignee can submit, and only the named validator can judge. Escrow is
recorded here but held by the client until release, so this contract never has
custody of anyone's USDC — the same non-custodial rule the rest of Ripar follows.
"""

from algopy import (
    Account,
    ARC4Contract,
    Asset,
    Bytes,
    BoxMap,
    Global,
    Txn,
    UInt64,
    arc4,
    gtxn,
    itxn,
    subroutine,
)

# Status values. Plain ints because AVM has no enums and a typed wrapper would
# cost a box read to interpret.
OPEN = 0
ASSIGNED = 1
SUBMITTED = 2
VALIDATED = 3
DISPUTED = 4
CANCELLED = 5


class Job(arc4.Struct):
    job_id: arc4.UInt64
    client: arc4.Address
    # 0 until assigned.
    server_agent_id: arc4.UInt64
    # Who may judge the result. 0 means the client judges it themselves.
    validator_agent_id: arc4.UInt64
    # Budget in USDC base units. Held by the client, not by this app.
    budget_micro: arc4.UInt64
    # sha256 of the job specification, so the terms cannot be edited after bids.
    spec_hash: arc4.DynamicBytes
    # sha256 of the delivered result, set on submit.
    result_hash: arc4.DynamicBytes
    status: arc4.UInt64
    created_at: arc4.UInt64
    updated_at: arc4.UInt64


class ValidationRegistry(ARC4Contract):
    def __init__(self) -> None:
        self.job_count = UInt64(0)
        self.jobs = BoxMap(UInt64, Job, key_prefix=b"jb_")
        # The IdentityRegistry this contract trusts to say which address
        # controls an agent id. validation_response resolves the named
        # validator through it, so a verdict cannot be written by a stranger.
        self.identity_app = UInt64(0)

        # Escrow, in its own box map rather than a field on Job.
        #
        # A budget and an escrow are different facts with different lifetimes:
        # a budget is what the client says the work is worth, escrow is what
        # they have actually handed over. Keeping them apart also leaves the
        # jb_ box layout untouched, so every decoder that already reads it
        # keeps working.
        #
        # Zero or absent means nothing is held, which is the honest default:
        # posting a job commits no money until fund_job runs.
        self.escrow = BoxMap(UInt64, UInt64, key_prefix=b"es_")

        # The asset escrow is denominated in. Fixed at bootstrap for the same
        # reason the ReputationRegistry fixes its own: an escrow the caller
        # chose the asset for can be funded with something worthless.
        self.escrow_asset = UInt64(0)

        # How long a submitted result may sit unjudged before the assignee can
        # claim the escrow anyway. Without it a validator who simply never
        # shows up freezes the worker's money for good.
        self.dispute_window = UInt64(0)

    @arc4.abimethod
    def bootstrap(
        self,
        identity_app: arc4.UInt64,
        escrow_asset: arc4.UInt64,
        dispute_window_secs: arc4.UInt64,
    ) -> arc4.Bool:
        """Point this registry at an IdentityRegistry and fix the escrow terms.

        All three are fixed rather than passed per call: a validator address
        resolved through a registry the caller chose is a validator address the
        caller invented, an escrow whose asset the caller picks can be funded
        with something worthless, and a dispute window set per job is a window
        the client can set to zero.
        """
        assert Txn.sender == Global.creator_address, "only the creator may bootstrap"
        assert self.identity_app == 0, "already bootstrapped"
        assert identity_app.native > 0, "identity app id required"
        assert escrow_asset.native > 0, "escrow asset required"
        assert dispute_window_secs.native > 0, "a zero dispute window would let anyone claim instantly"
        self.identity_app = identity_app.native
        self.escrow_asset = escrow_asset.native
        self.dispute_window = dispute_window_secs.native
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.abimethod
    def opt_in_asset(self) -> arc4.Bool:
        """Let this app hold the escrow asset. Creator-only, once.

        An Algorand account cannot receive an ASA it has not opted into, so
        without this every fund_job would fail at the transfer with an error
        that says nothing about the cause. The app account needs 0.1 ALGO of
        minimum balance for the holding before this will succeed.
        """
        assert Txn.sender == Global.creator_address, "only the creator may opt in"
        assert self.escrow_asset > 0, "bootstrap first"
        itxn.AssetTransfer(
            xfer_asset=self.escrow_asset,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0,
        ).submit()
        return arc4.Bool(True)  # noqa: FBT003

    @subroutine
    def _now(self) -> UInt64:
        return Global.latest_timestamp

    @arc4.abimethod
    def post_job(
        self,
        spec_hash: arc4.DynamicBytes,
        budget_micro: arc4.UInt64,
        validator_agent_id: arc4.UInt64,
    ) -> arc4.UInt64:
        """Open a job. The spec is committed by hash so it cannot change later."""
        assert spec_hash.native.length == 32, "spec_hash must be a sha256 digest"
        assert budget_micro.native > 0, "a job with no budget attracts no bids"

        self.job_count += 1
        jid = self.job_count
        now = self._now()

        self.jobs[jid] = Job(
            job_id=arc4.UInt64(jid),
            client=arc4.Address(Txn.sender),
            server_agent_id=arc4.UInt64(0),
            validator_agent_id=validator_agent_id,
            budget_micro=budget_micro,
            spec_hash=spec_hash.copy(),
            result_hash=arc4.DynamicBytes(Bytes(b"")),
            status=arc4.UInt64(OPEN),
            created_at=arc4.UInt64(now),
            updated_at=arc4.UInt64(now),
        )
        return arc4.UInt64(jid)

    @arc4.abimethod
    def assign_job(self, job_id: arc4.UInt64, server_agent_id: arc4.UInt64) -> arc4.Bool:
        """Give the job to an agent. Client only, and only while still open."""
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert j.client.native == Txn.sender, "only the client may assign"
        assert j.status.native == OPEN, "job is no longer open"
        assert server_agent_id.native > 0, "agent id required"

        j.server_agent_id = server_agent_id
        j.status = arc4.UInt64(ASSIGNED)
        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.abimethod
    def submit_result(self, job_id: arc4.UInt64, result_hash: arc4.DynamicBytes) -> arc4.Bool:
        """The assignee commits its result by hash. The payload stays offchain."""
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        assert result_hash.native.length == 32, "result_hash must be a sha256 digest"

        j = self.jobs[jid].copy()
        assert j.status.native == ASSIGNED, "job is not awaiting a result"

        # Only the assignee may submit. This was previously left to the client
        # SDK, with a note saying an inner app call was "the next iteration" —
        # which meant anyone could commit a result hash against anyone's job and
        # move it to SUBMITTED, and the real assignee could then never submit.
        # A check that lives in the SDK is not a check.
        assignee_addr, _txn = arc4.abi_call[arc4.Address](
            "agent_address(uint64)address",
            j.server_agent_id,
            app_id=self.identity_app,
        )
        assert Txn.sender == assignee_addr.native, "only the assigned agent may submit a result"

        j.result_hash = result_hash.copy()
        j.status = arc4.UInt64(SUBMITTED)
        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.abimethod
    def validation_response(self, job_id: arc4.UInt64, passed: arc4.Bool) -> arc4.UInt64:
        """Judge a submitted result. Returns the resulting status."""
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert j.status.native == SUBMITTED, "nothing has been submitted to judge"

        # Either the named validator's controlling address, or the client when no
        # validator was named. Anyone else judging would make the verdict noise.
        #
        # This used to read `client == sender OR validator_agent_id > 0`, which
        # is vacuous the moment a validator IS named: the second clause is true
        # regardless of who is calling, so any address could mark any submitted
        # job validated. An "or" over a fact about the JOB can never authorise
        # the SENDER.
        #
        # Resolved against the IdentityRegistry, because that is the only place
        # an address-to-id binding is authenticated.
        if j.validator_agent_id.native > 0:
            validator_addr, _txn = arc4.abi_call[arc4.Address](
                "agent_address(uint64)address",
                j.validator_agent_id,
                app_id=self.identity_app,
            )
            assert Txn.sender == validator_addr.native, "only the named validator may judge this job"
        else:
            assert j.client.native == Txn.sender, "only the client may judge a job with no validator"

        # A Python-literal ternary is not a value the AVM can hold; branch and
        # build a UInt64 on each side instead.
        new_status = UInt64(VALIDATED)
        if not passed.native:
            new_status = UInt64(DISPUTED)
        j.status = arc4.UInt64(new_status)
        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.UInt64(new_status)

    @subroutine
    def _agent_address(self, agent_id: arc4.UInt64) -> Account:
        """Resolve an agent id to its controlling address, or fail.

        One place, because three methods need it and a resolution that silently
        returned the zero address would compare equal to nothing and authorise
        nobody — or, worse, pay nobody.
        """
        addr, _txn = arc4.abi_call[arc4.Address](
            "agent_address(uint64)address",
            agent_id,
            app_id=self.identity_app,
        )
        return addr.native

    @subroutine
    def _pay_escrow(self, job_id: UInt64, to: Account) -> UInt64:
        """Send the whole escrow for a job and zero the record. Returns the amount.

        The box is cleared BEFORE the transfer is submitted. If it were cleared
        after, a failed inner transaction would leave the ledger claiming money
        this app no longer intends to hold — and if the clear itself failed,
        the escrow could be paid twice. Ordering it this way makes double
        payment impossible: the second call finds nothing to send.
        """
        assert job_id in self.escrow, "nothing is escrowed for this job"
        amount = self.escrow[job_id]
        assert amount > 0, "nothing is escrowed for this job"
        del self.escrow[job_id]

        itxn.AssetTransfer(
            xfer_asset=self.escrow_asset,
            asset_receiver=to,
            asset_amount=amount,
            fee=0,
        ).submit()
        return amount

    @arc4.abimethod
    def fund_job(self, payment: gtxn.AssetTransferTransaction, job_id: arc4.UInt64) -> arc4.UInt64:
        """Move the budget into escrow. Returns the total now held.

        The transfer is a TRANSACTION IN THIS GROUP, so the amount is read off
        something the AVM has already validated rather than taken as a number
        the caller supplies — the same rule that stopped reputation being
        minted from bytes.

        This is the one place Ripar takes custody, and it is opt-in: a job runs
        perfectly well unfunded, with the budget as a stated intention. What
        funding buys is that the assignee can see the money exists before doing
        the work.
        """
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert j.client.native == Txn.sender, "only the client may fund their own job"
        assert j.status.native == OPEN or j.status.native == ASSIGNED, "job is past funding"

        assert payment.asset_receiver == Global.current_application_address, "escrow must be paid to this app"
        assert payment.sender == Txn.sender, "the funder must be the client"
        assert payment.xfer_asset.id == self.escrow_asset, "escrow is denominated in one asset; this is not it"
        assert payment.asset_amount > 0, "a zero transfer escrows nothing"

        held = payment.asset_amount
        if jid in self.escrow:
            held += self.escrow[jid]
        self.escrow[jid] = held

        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.UInt64(held)

    @arc4.abimethod
    def release_escrow(self, job_id: arc4.UInt64) -> arc4.UInt64:
        """Pay the assignee once the work passed. Returns the amount sent.

        Callable by the client, and — after the dispute window — by anyone.
        That second path is the point: a validator who never returns would
        otherwise freeze the worker's money for good, and a lock with no key is
        not escrow, it is confiscation. The window starts when the verdict was
        written, so a validator who does show up is never pre-empted.
        """
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert j.status.native == VALIDATED, "escrow is released on a passing verdict"

        past_window = Global.latest_timestamp > j.updated_at.native + self.dispute_window
        assert j.client.native == Txn.sender or past_window, "only the client may release before the dispute window closes"

        paid = self._pay_escrow(jid, self._agent_address(j.server_agent_id))
        return arc4.UInt64(paid)

    @arc4.abimethod
    def refund_escrow(self, job_id: arc4.UInt64) -> arc4.UInt64:
        """Return the escrow to the client. Returns the amount sent.

        Only on a failed verdict or a cancelled job, and payable to the client
        whoever calls it — the destination is read off the job rather than from
        the sender, so triggering a refund can never redirect one.
        """
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert (
            j.status.native == DISPUTED or j.status.native == CANCELLED
        ), "escrow is refunded on a failed verdict or a cancelled job"

        paid = self._pay_escrow(jid, j.client.native)
        return arc4.UInt64(paid)

    @arc4.abimethod(readonly=True)
    def get_escrow(self, job_id: arc4.UInt64) -> arc4.UInt64:
        """What is actually held for a job. 0 for an unfunded one."""
        jid = job_id.native
        if jid in self.escrow:
            return arc4.UInt64(self.escrow[jid])
        return arc4.UInt64(0)

    @arc4.abimethod
    def set_validator(self, job_id: arc4.UInt64, validator_agent_id: arc4.UInt64) -> arc4.Bool:
        """Name or change the validator, while the job is still open.

        Only while OPEN. Once an agent has been assigned, changing who judges
        the work is changing the terms after the fact — the assignee took the
        job partly on who would be marking it.
        """
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert j.client.native == Txn.sender, "only the client may name the validator"
        assert j.status.native == OPEN, "the validator is fixed once the job is assigned"

        j.validator_agent_id = validator_agent_id
        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.baremethod(allow_actions=["DeleteApplication"])
    def delete(self) -> None:
        """Creator-only teardown. See IdentityRegistry.delete for why.

        The AVM refuses while boxes remain, so live jobs and outstanding escrow
        both block this — money cannot be stranded by deleting the app that
        holds it.
        """
        assert Txn.sender == Global.creator_address, "only the creator may delete"

    @arc4.abimethod
    def cancel_job(self, job_id: arc4.UInt64) -> arc4.Bool:
        """Withdraw an unassigned job. Once assigned, it must run its course."""
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        j = self.jobs[jid].copy()
        assert j.client.native == Txn.sender, "only the client may cancel"
        assert j.status.native == OPEN, "an assigned job cannot be cancelled"
        j.status = arc4.UInt64(CANCELLED)
        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.abimethod(readonly=True)
    def get_job(self, job_id: arc4.UInt64) -> Job:
        jid = job_id.native
        assert jid in self.jobs, "unknown job"
        return self.jobs[jid]

    @arc4.abimethod(readonly=True)
    def total_jobs(self) -> arc4.UInt64:
        return arc4.UInt64(self.job_count)
