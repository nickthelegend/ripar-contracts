#!/usr/bin/env python3
"""No inner call may be opened inside an already-open inner transaction.

`itxn_begin` cannot nest. If a subroutine that opens its own inner transaction
is called while one is already open, the AVM rejects the whole group at runtime
with "itxn_begin without itxn_submit".

Nothing catches this earlier. It type-checks, it compiles, it deploys, and every
test that does not actually move money passes. release_partial shipped with it:

    itxn.AssetTransfer(
        asset_receiver=self._agent_address(j.server_agent_id),   # <- inner call
        ...                                                       #    inside the
    ).submit()                                                    #    argument list

`_agent_address` resolves an id through the IdentityRegistry by inner call, so
that argument opens a second itxn inside the first. Resolving it into a local
one line earlier is the whole fix, and the two versions look almost identical in
review. release_escrow avoided it only by accident — there the same resolution is
an argument to a subroutine, which finishes before the itxn opens.

Reads the compiled TEAL rather than the Python, because this is a property of
what the compiler emitted and the source form that causes it is not obviously
different from the form that does not.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ARTIFACTS = Path(__file__).resolve().parent.parent / "contracts" / "artifacts"


def subroutines_that_open_itxn(text: str) -> set[str]:
    """Labels whose body contains an itxn_begin."""
    found: set[str] = set()
    current: str | None = None
    opens = False
    for line in text.splitlines():
        stripped = line.strip()
        label = re.match(r"^(\w+):$", stripped)
        if label:
            if current and opens:
                found.add(current)
            current, opens = label.group(1), False
        elif stripped == "itxn_begin":
            opens = True
    if current and opens:
        found.add(current)
    return found


def offending_calls(text: str) -> list[tuple[int, str]]:
    """(line, target) for every callsub to an itxn-opening sub while one is open."""
    risky = subroutines_that_open_itxn(text)
    hits: list[tuple[int, str]] = []
    open_itxn = False
    for n, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if stripped == "itxn_begin":
            open_itxn = True
        elif stripped == "itxn_submit":
            open_itxn = False
        elif open_itxn and stripped.startswith("callsub "):
            target = stripped.split()[1]
            if target in risky:
                hits.append((n, target))
    return hits


def main() -> int:
    programs = sorted(ARTIFACTS.glob("*.approval.teal"))
    if not programs:
        print(f"::error::no approval programs under {ARTIFACTS}")
        return 1

    bad = False
    for path in programs:
        hits = offending_calls(path.read_text())
        if hits:
            bad = True
            for line, target in hits:
                print(f"::error file={path}::{path.name}:{line} calls {target} while an inner transaction is open.")
                print(f"::error::{target} opens its own itxn, so this fails at RUNTIME with 'itxn_begin without itxn_submit'.")
                print("::error::Resolve it into a local before the itxn, e.g. `payee = self._agent_address(id)`.")
        else:
            print(f"  ok  {path.name}: no inner call opened inside an open inner transaction")

    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
