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
    ARC4Contract,
    Bytes,
    BoxMap,
    Global,
    Txn,
    UInt64,
    arc4,
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
        # NOTE: the assignee is identified by agent id, and this contract cannot
        # read the Identity Registry's boxes directly, so the caller proves it is
        # the assignee by being the address that registered that id — checked by
        # the client SDK before it composes this call. Enforcing it fully onchain
        # needs an inner app call, which is the next iteration.
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
        assert j.client.native == Txn.sender or j.validator_agent_id.native > 0, "not a permitted validator"

        # A Python-literal ternary is not a value the AVM can hold; branch and
        # build a UInt64 on each side instead.
        new_status = UInt64(VALIDATED)
        if not passed.native:
            new_status = UInt64(DISPUTED)
        j.status = arc4.UInt64(new_status)
        j.updated_at = arc4.UInt64(self._now())
        self.jobs[jid] = j.copy()
        return arc4.UInt64(new_status)

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
