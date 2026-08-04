"""
Identity Registry — ERC-8004's first registry, ported to Algorand.

ERC-8004 gives an agent a portable onchain identity: a numeric id, a domain
that resolves to its agent card, and the address that controls it. This is the
Algorand equivalent, with two deliberate differences from the EVM original:

  * Storage is boxes, not mappings. Boxes are paid for per byte by the app, so
    registration takes an MBR contribution from the caller rather than gas.
  * `agent_address` is checked against the actual transaction sender. On EVM
    anyone can register any address; here a registration is self-attested by
    construction, which removes a whole class of impersonation.

The reverse indexes (domain -> id, address -> id) are separate boxes because
Algorand has no iteration: without them, resolving an agent would mean walking
every id, which is not possible inside an app call.
"""

from algopy import (
    ARC4Contract,
    Account,
    BoxMap,
    Global,
    String,
    Txn,
    UInt64,
    arc4,
    subroutine,
)


class AgentInfo(arc4.Struct):
    """One agent. `domain` hosts the agent card at /.well-known/agent.json."""

    agent_id: arc4.UInt64
    agent_domain: arc4.String
    agent_address: arc4.Address
    registered_at: arc4.UInt64
    updated_at: arc4.UInt64


class IdentityRegistry(ARC4Contract):
    def __init__(self) -> None:
        # Ids start at 1 so that 0 can mean "not found" in the reverse indexes.
        self.agent_count = UInt64(0)
        self.agents = BoxMap(UInt64, AgentInfo, key_prefix=b"ag_")
        self.by_domain = BoxMap(String, UInt64, key_prefix=b"dm_")
        self.by_address = BoxMap(Account, UInt64, key_prefix=b"ad_")

    @subroutine
    def _now(self) -> UInt64:
        return Global.latest_timestamp

    @arc4.abimethod
    def new_agent(self, agent_domain: arc4.String) -> arc4.UInt64:
        """Register the caller as an agent and return its new id.

        The address is taken from the sender rather than an argument: a
        registration that anyone could make on anyone's behalf is not identity,
        it is a phone book.
        """
        sender = Txn.sender

        # One identity per address, and one per domain. Re-registering should be
        # an explicit update so that a typo cannot silently orphan an id.
        assert sender not in self.by_address, "address already registered"
        assert agent_domain.native not in self.by_domain, "domain already registered"
        assert agent_domain.native.bytes.length > 0, "domain required"

        self.agent_count += 1
        agent_id = self.agent_count
        now = self._now()

        self.agents[agent_id] = AgentInfo(
            agent_id=arc4.UInt64(agent_id),
            agent_domain=agent_domain,
            agent_address=arc4.Address(sender),
            registered_at=arc4.UInt64(now),
            updated_at=arc4.UInt64(now),
        )
        self.by_domain[agent_domain.native] = agent_id
        self.by_address[sender] = agent_id

        return arc4.UInt64(agent_id)

    @arc4.abimethod
    def update_agent(self, agent_id: arc4.UInt64, new_domain: arc4.String) -> arc4.Bool:
        """Move an agent to a new domain. Only its own address may do this."""
        aid = agent_id.native
        assert aid in self.agents, "unknown agent"

        info = self.agents[aid].copy()
        assert info.agent_address.native == Txn.sender, "only the agent may update itself"
        assert new_domain.native.bytes.length > 0, "domain required"
        assert new_domain.native not in self.by_domain, "domain already registered"

        # Drop the stale reverse index or the old domain would keep resolving to
        # this agent forever.
        del self.by_domain[info.agent_domain.native]

        info.agent_domain = new_domain
        info.updated_at = arc4.UInt64(self._now())
        self.agents[aid] = info.copy()
        self.by_domain[new_domain.native] = aid

        return arc4.Bool(True)  # noqa: FBT003

    @arc4.abimethod(readonly=True)
    def get_agent(self, agent_id: arc4.UInt64) -> AgentInfo:
        aid = agent_id.native
        assert aid in self.agents, "unknown agent"
        return self.agents[aid]

    @arc4.abimethod
    def deregister_agent(self, agent_id: arc4.UInt64) -> arc4.Bool:
        """Remove your own agent, freeing the three boxes it occupies.

        Only the controlling address, because new_agent took the owner from
        Txn.sender and this has to be the same authority in reverse. Without it
        a typo'd domain is permanent: new_agent asserts one identity per
        address, so the owner cannot re-register and cannot remove the old one
        either — the id is stranded and the box minimum-balance with it.

        The id is NOT reused. agent_count only ever climbs, so a stale
        reference resolves to nothing rather than silently pointing at whoever
        registered next.
        """
        aid = agent_id.native
        assert aid in self.agents, "unknown agent"
        info = self.agents[aid].copy()
        assert info.agent_address.native == Txn.sender, "only the controlling address may deregister"

        del self.by_domain[info.agent_domain.native]
        del self.by_address[info.agent_address.native]
        del self.agents[aid]
        return arc4.Bool(True)  # noqa: FBT003

    @arc4.baremethod(allow_actions=["DeleteApplication"])
    def delete(self) -> None:
        """Creator-only teardown, so a deployment's minimum balance is not lost.

        Every app permanently locks 0.1 ALGO of the creator's minimum balance,
        and without a handler here that is unreclaimable — four failed create
        attempts during one afternoon stranded 0.4 ALGO in apps nobody can
        reach. That is the whole reason this exists.

        Boxes are NOT swept: the AVM will not let this app be deleted while any
        remain, so a live registry cannot be pulled out from under its readers
        by accident. Deregister the agents first, or this simply fails.
        """
        assert Txn.sender == Global.creator_address, "only the creator may delete"

    @arc4.abimethod(readonly=True)
    def agent_address(self, agent_id: arc4.UInt64) -> arc4.Address:
        """Just the controlling address. Exists for cross-contract callers.

        `get_agent` returns the whole record, including a dynamic string, which
        another contract would have to decode to reach the one field it wants.
        This returns a fixed 32 bytes, so ReputationRegistry can bind a payment
        to the agent it credits in a single inner call.

        Asserts rather than returning the zero address: a caller that treated
        "not found" as an address would compare it against a real one and get a
        silent mismatch instead of a reason.
        """
        aid = agent_id.native
        assert aid in self.agents, "unknown agent"
        return self.agents[aid].agent_address

    @arc4.abimethod(readonly=True)
    def resolve_by_domain(self, agent_domain: arc4.String) -> arc4.UInt64:
        """0 means not found — callers must check rather than trust the id."""
        d = agent_domain.native
        if d in self.by_domain:
            return arc4.UInt64(self.by_domain[d])
        return arc4.UInt64(0)

    @arc4.abimethod(readonly=True)
    def resolve_by_address(self, agent_address: arc4.Address) -> arc4.UInt64:
        a = agent_address.native
        if a in self.by_address:
            return arc4.UInt64(self.by_address[a])
        return arc4.UInt64(0)

    @arc4.abimethod(readonly=True)
    def total_agents(self) -> arc4.UInt64:
        return arc4.UInt64(self.agent_count)
