import fs from "node:fs";
/**
 * Where the e2e account keys live.
 *
 * NOT /tmp. These files hold the MNEMONIC of the account that creates the
 * registries and receives every payment, and macOS prunes /tmp without warning.
 * That is not hypothetical: the TestNet deployer key for
 * KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ was lost exactly
 * this way, mid-session, with no backup. Those registries can no longer be
 * redeployed or re-bootstrapped by anyone, and the balance in that account is
 * stranded for good — `bootstrap` is one-shot and the creator is the only
 * account that could ever have replaced them.
 *
 * ~/.ripar survives a reboot, sits outside every repo so it cannot be
 * committed, and is created 0700.
 */
import os from "node:os";
import path from "node:path";

export function configPath(name = "testnet-e2e.json") {
  if (process.env.RIPAR_E2E_CONFIG) return process.env.RIPAR_E2E_CONFIG;
  const dir = path.join(os.homedir(), ".ripar");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, name);
}
