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
