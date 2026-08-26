"""
IdentityRegistry, tested without a chain.

Every assertion below was previously provable only by deploying the contract and
spending ALGO against it — the attack suite in `deploy-v2.mjs` is a real network
run, so the guards it covers cost money and a LocalNet to exercise. These run in
milliseconds against `algorand-python-testing`, which executes the same Algorand
Python source the compiler consumes.

That distinction matters for the refusal cases in particular. "The contract
rejects this" is the half of the behaviour most likely to rot silently, because
nothing downstream breaks when a guard stops firing — the call simply starts
succeeding.
"""

import pytest
from algopy import OnCompleteAction, arc4
from algopy_testing import AlgopyTestContext, algopy_testing_context

from contracts.identity_registry import IdentityRegistry


@pytest.fixture()
def ctx():
    with algopy_testing_context() as c:
        yield c


@pytest.fixture()
def registry(ctx: AlgopyTestContext) -> IdentityRegistry:
    return IdentityRegistry()


def _register(ctx, registry, sender, domain: str):
    with ctx.txn.create_group(active_txn_overrides={"sender": sender}):
        return registry.new_agent(arc4.String(domain))


# --- registration ---------------------------------------------------------


def test_first_registration_takes_id_one(ctx, registry):
    agent_id = _register(ctx, registry, ctx.default_sender, "first.example")
    assert agent_id.native == 1
    assert registry.agent_count == 1


def test_ids_are_issued_sequentially_and_never_reused(ctx, registry):
    a = ctx.any.account()
    b = ctx.any.account()
    assert _register(ctx, registry, a, "a.example").native == 1
    assert _register(ctx, registry, b, "b.example").native == 2

    # Deregistering agent 1 must not free its id for reuse: a third
    # registration takes 3, not 1. Reused ids would let a new owner inherit
    # another agent's reputation history.
    with ctx.txn.create_group(active_txn_overrides={"sender": a}):
        registry.deregister_agent(arc4.UInt64(1))
    c = ctx.any.account()
    assert _register(ctx, registry, c, "c.example").native == 3


def test_the_registered_address_is_the_sender_not_an_argument(ctx, registry):
    """The whole anti-impersonation claim rests on this."""
    caller = ctx.any.account()
    agent_id = _register(ctx, registry, caller, "sender.example")
    with ctx.txn.create_group(active_txn_overrides={"sender": caller}):
        stored = registry.agent_address(agent_id)
    assert stored.native == caller


# --- registration refusals ------------------------------------------------


def test_one_identity_per_address(ctx, registry):
    caller = ctx.any.account()
    _register(ctx, registry, caller, "one.example")
    with pytest.raises(Exception, match="address already registered"):
        _register(ctx, registry, caller, "two.example")


def test_a_domain_cannot_be_claimed_twice(ctx, registry):
    _register(ctx, registry, ctx.any.account(), "taken.example")
    with pytest.raises(Exception, match="domain already registered"):
        _register(ctx, registry, ctx.any.account(), "taken.example")


def test_an_empty_domain_is_refused(ctx, registry):
    with pytest.raises(Exception, match="domain required"):
        _register(ctx, registry, ctx.any.account(), "")


# --- update ---------------------------------------------------------------


def test_only_the_agent_may_update_itself(ctx, registry):
    owner = ctx.any.account()
    stranger = ctx.any.account()
    agent_id = _register(ctx, registry, owner, "owned.example")

    with pytest.raises(Exception, match="only the agent may update itself"):
        with ctx.txn.create_group(active_txn_overrides={"sender": stranger}):
            registry.update_agent(agent_id, arc4.String("stolen.example"))


def test_update_cannot_take_a_domain_someone_else_holds(ctx, registry):
    a = ctx.any.account()
    b = ctx.any.account()
    first = _register(ctx, registry, a, "a.example")
    _register(ctx, registry, b, "b.example")

    with pytest.raises(Exception, match="domain already registered"):
        with ctx.txn.create_group(active_txn_overrides={"sender": a}):
            registry.update_agent(first, arc4.String("b.example"))


def test_updating_an_unknown_agent_is_refused(ctx, registry):
    with pytest.raises(Exception, match="unknown agent"):
        with ctx.txn.create_group(active_txn_overrides={"sender": ctx.any.account()}):
            registry.update_agent(arc4.UInt64(9999), arc4.String("ghost.example"))


# --- address rotation -----------------------------------------------------


def test_rotation_moves_control_and_keeps_the_id(ctx, registry):
    old = ctx.any.account()
    new = ctx.any.account()
    agent_id = _register(ctx, registry, old, "rotate.example")

    with ctx.txn.create_group(active_txn_overrides={"sender": old}):
        registry.rotate_address(agent_id, arc4.Address(new))

    with ctx.txn.create_group(active_txn_overrides={"sender": new}):
        assert registry.agent_address(agent_id).native == new
        # the reverse index must follow, or the agent becomes unresolvable
        assert registry.resolve_by_address(arc4.Address(new)).native == agent_id.native
        assert registry.resolve_by_address(arc4.Address(old)).native == 0


def test_only_the_current_address_may_rotate(ctx, registry):
    owner = ctx.any.account()
    stranger = ctx.any.account()
    agent_id = _register(ctx, registry, owner, "guard.example")

    with pytest.raises(Exception, match="only the current address may rotate"):
        with ctx.txn.create_group(active_txn_overrides={"sender": stranger}):
            registry.rotate_address(agent_id, arc4.Address(stranger))


def test_cannot_rotate_onto_an_address_that_controls_another_agent(ctx, registry):
    a = ctx.any.account()
    b = ctx.any.account()
    first = _register(ctx, registry, a, "x.example")
    _register(ctx, registry, b, "y.example")

    with pytest.raises(Exception, match="already controls another agent"):
        with ctx.txn.create_group(active_txn_overrides={"sender": a}):
            registry.rotate_address(first, arc4.Address(b))


def test_rotating_to_the_same_address_is_refused(ctx, registry):
    owner = ctx.any.account()
    agent_id = _register(ctx, registry, owner, "same.example")
    with pytest.raises(Exception, match="already the controlling address"):
        with ctx.txn.create_group(active_txn_overrides={"sender": owner}):
            registry.rotate_address(agent_id, arc4.Address(owner))


# --- deregistration -------------------------------------------------------


def test_only_the_controlling_address_may_deregister(ctx, registry):
    owner = ctx.any.account()
    stranger = ctx.any.account()
    agent_id = _register(ctx, registry, owner, "mine.example")

    with pytest.raises(Exception, match="only the controlling address may deregister"):
        with ctx.txn.create_group(active_txn_overrides={"sender": stranger}):
            registry.deregister_agent(agent_id)


def test_deregistration_frees_the_domain_and_the_address(ctx, registry):
    owner = ctx.any.account()
    agent_id = _register(ctx, registry, owner, "freed.example")
    with ctx.txn.create_group(active_txn_overrides={"sender": owner}):
        registry.deregister_agent(agent_id)

    # both reverse indexes must be cleared, or the domain is burned forever
    later = ctx.any.account()
    assert _register(ctx, registry, later, "freed.example").native == 2
    # and the original owner can register again
    assert _register(ctx, registry, owner, "again.example").native == 3


# --- resolution -----------------------------------------------------------


def test_resolution_round_trips_by_domain_and_address(ctx, registry):
    owner = ctx.any.account()
    agent_id = _register(ctx, registry, owner, "round.example")
    with ctx.txn.create_group(active_txn_overrides={"sender": owner}):
        assert registry.resolve_by_domain(arc4.String("round.example")).native == agent_id.native
        assert registry.resolve_by_address(arc4.Address(owner)).native == agent_id.native


def test_unknown_lookups_answer_zero_rather_than_failing(ctx, registry):
    """
    Zero is the contract's 'no such record'. It must be an answer, not an
    error — callers are documented to check it, and an exception here would
    make a negative lookup indistinguishable from an unreachable node.
    """
    with ctx.txn.create_group(active_txn_overrides={"sender": ctx.any.account()}):
        assert registry.resolve_by_domain(arc4.String("nobody.example")).native == 0
        assert registry.resolve_by_address(arc4.Address(ctx.any.account())).native == 0


def test_reading_an_unknown_agent_is_an_error(ctx, registry):
    """get_agent differs from resolve_*: there is no sentinel struct to return."""
    with pytest.raises(Exception, match="unknown agent"):
        with ctx.txn.create_group(active_txn_overrides={"sender": ctx.any.account()}):
            registry.get_agent(arc4.UInt64(4242))


# --- deletion -------------------------------------------------------------


def test_only_the_creator_may_delete(ctx, registry):
    """
    `delete` is a baremethod gated on DeleteApplication, so the on-completion
    has to be set or the call never reaches the guard at all — the harness
    fails earlier with an unrelated error and the test would pass for the
    wrong reason.
    """
    deleting = {"on_completion": OnCompleteAction.DeleteApplication}

    with pytest.raises(Exception, match="only the creator may delete"):
        with ctx.txn.create_group(
            active_txn_overrides={"sender": ctx.any.account(), **deleting}
        ):
            registry.delete()


def test_the_creator_may_delete(ctx, registry):
    """The positive half — a guard that refuses everyone is also broken."""
    with ctx.txn.create_group(
        active_txn_overrides={"sender": ctx.default_sender,
                              "on_completion": OnCompleteAction.DeleteApplication}
    ):
        registry.delete()
