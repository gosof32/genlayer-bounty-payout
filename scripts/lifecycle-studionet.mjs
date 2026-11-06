// End-to-end lifecycle of Bounty Payout on GenLayer Studionet, against the real GitHub API.
//
//   npm install
//   node scripts/lifecycle-studionet.mjs setup              # deploy + open bounties
//   (open and merge a real PR on the bounty repo whose body carries the hunter address)
//   PR=<number> node scripts/lifecycle-studionet.mjs judge  # claims, judging, payout, refund
//
// Why two phases: a claim only pays if the PR was merged AFTER the bounty was created and its
// body contains the hunter's wallet address. Throwaway keys are generated in `setup`
// (artifacts/keys.json, git-ignored) and the hunter address is printed so a real PR can carry it.
//
// Bounties opened in `setup` on BOUNTY_REPO (default gosof32/genlayer-bounty-payout), issue #ISSUE:
//   #1 main bounty: 3 acceptance criteria, deadline +3h, judge grace 3h, 2 attempts per claim
//   #2 refund demo: deadline +4 min, no claims -> refunded to the sponsor by anyone
//   #3 cancel demo: cancelled by the sponsor while no claim is pending
// `judge` phase:
//   outsider claims the same real PR -> judged by validators -> REJECTED (MISSING_AUTHORSHIP)
//   hunter claims the PR             -> judged by validators -> ACCEPTED, reward paid
//   negative paths: judging a paid bounty, cancelling a paid bounty, refunding before deadline
// Every transaction hash and its finalized status is written to deployments/studionet.json.

import fs from "node:fs";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const PHASE = process.argv[2];
const REPO = process.env.BOUNTY_REPO || "gosof32/genlayer-bounty-payout";
const ISSUE = Number(process.env.ISSUE || 1);
const WAIT = { status: "FINALIZED", retries: 400, interval: 3000 };
const UNIT = 1_000_000n; // contract amounts are plain integers; small units keep funding simple
const KEYS = new URL("../artifacts/keys.json", import.meta.url);
const OUT = new URL("../deployments/studionet.json", import.meta.url);

const client = createClient({ chain: studionet });
const json = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Map ? Object.fromEntries(x) : x)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");

const state = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { transactions: [] };
const log = state.transactions;

function describe(receipt) {
  const r = json(receipt);
  const leader = r.consensus_data?.leader_receipt?.[0] ?? r.consensus_data?.leader_receipt ?? {};
  const execution = leader.execution_result ?? r.txExecutionResultName ?? "UNKNOWN";
  const status = r.status_name ?? r.statusName ?? r.status;
  const consensus = r.result_name ?? r.resultName ?? r.result;
  let returnValue = leader.result?.payload?.readable ?? leader.result?.payload ?? null;
  if (returnValue && typeof returnValue !== "string") returnValue = JSON.stringify(returnValue);
  return { status, consensus, execution, ok: execution === "SUCCESS", returnValue };
}

// Studionet's RPC occasionally answers with an HTML error page; retry transient failures.
async function retry(fn, tries = 8) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      process.stdout.write(`(rpc retry ${i}: ${String(e.shortMessage || e.message).slice(0, 60)}) `);
      await sleep(5000 * i);
    }
  }
}

function save(extra = {}) {
  fs.mkdirSync(new URL("../deployments/", import.meta.url), { recursive: true });
  Object.assign(state, extra, { network: "studionet", rpc: "https://studio.genlayer.com/api", generated_at: new Date().toISOString() });
  fs.writeFileSync(OUT, JSON.stringify(json(state), null, 2) + "\n");
}

async function step(label, account, fn, expectOk = true, expectText = null) {
  process.stdout.write(`- ${label} ... `);
  const hash = await retry(() => fn(account));
  const receipt = await retry(() => client.waitForTransactionReceipt({ hash, ...WAIT }));
  const d = describe(receipt);
  log.push({ label, phase: PHASE, hash, from: account.address, ...d, expected_ok: expectOk });
  save();
  console.log(`${d.status}/${d.consensus}/${d.execution}${d.returnValue ? " " + String(d.returnValue).slice(0, 300) : ""}`);
  if (d.ok !== expectOk) throw new Error(`Unexpected outcome for "${label}": ${JSON.stringify(d)}`);
  if (expectText && !String(d.returnValue ?? "").includes(expectText)) throw new Error(`"${label}" did not return ${expectText}: ${d.returnValue}`);
  return { hash, receipt, d };
}

const write = (address, functionName, args, value = 0n) => (account) =>
  client.writeContract({ account, address, functionName, args, value });
const read = (address, functionName, args) => client.readContract({ address, functionName, args });

const CRITERIA = [
  "Adds a CONTRIBUTING.md file at the repository root",
  "CONTRIBUTING.md explains how to install the dev requirements and run the direct-mode tests with pytest",
  "CONTRIBUTING.md explains how to run the Studionet lifecycle script",
];

if (PHASE === "setup") {
  const keys = { sponsor: generatePrivateKey(), hunter: generatePrivateKey(), outsider: generatePrivateKey() };
  fs.mkdirSync(new URL("../artifacts/", import.meta.url), { recursive: true });
  fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2));
  const [sponsor, hunter, outsider] = [keys.sponsor, keys.hunter, keys.outsider].map((k) => createAccount(k));
  for (const a of [sponsor, hunter, outsider]) {
    await retry(() => client.request({ method: "sim_fundAccount", params: [a.address, 1_000_000_000_000] }));
  }
  // fresh run: clear the shared log array in place (state.transactions points at it)
  log.length = 0;
  const code = fs.readFileSync(new URL("../contracts/bounty_payout.py", import.meta.url), "utf8");
  const deploy = await step("deploy contract", sponsor, (account) => client.deployContract({ account, code, args: [] }));
  const address = deploy.receipt.data?.contract_address ?? deploy.receipt.recipient ?? deploy.receipt.to_address;
  console.log(`  contract: ${address}`);
  save({ contract: address, accounts: { sponsor: sponsor.address, hunter: hunter.address, outsider: outsider.address },
    bounty_repo: REPO, issue: ISSUE });

  const now = Date.now();
  const deadline1 = iso(new Date(now + 3 * 3600_000));
  const deadline2 = iso(new Date(now + 4 * 60_000));
  const deadline3 = iso(new Date(now + 24 * 3600_000));
  await step(`create_bounty #1 ${REPO}#${ISSUE} (100 units, 3 criteria)`, sponsor, write(address, "create_bounty", [
    REPO, ISSUE, "Add a CONTRIBUTING guide", JSON.stringify(CRITERIA), deadline1, 3, 3, 2,
  ], 100n * UNIT), true, "1");
  await step(`create_bounty #2 (refund demo, deadline ${deadline2})`, sponsor, write(address, "create_bounty", [
    REPO, ISSUE, "Refund demo: nobody claims this", JSON.stringify(["Adds a CONTRIBUTING.md file"]), deadline2, 0, 3, 1,
  ], 50n * UNIT), true, "2");
  await step("create_bounty #3 (cancel demo)", sponsor, write(address, "create_bounty", [
    REPO, ISSUE, "Cancel demo", JSON.stringify(["Adds a CONTRIBUTING.md file"]), deadline3, 0, 3, 1,
  ], 25n * UNIT), true, "3");
  await step("create_bounty with no reward (must be rejected)", sponsor, write(address, "create_bounty", [
    REPO, ISSUE, "No reward", JSON.stringify(["x criterion"]), deadline3, 0, 3, 1,
  ]), false);
  await step("cancel_bounty #3 by outsider (must be rejected)", outsider, write(address, "cancel_bounty", [3]), false);
  await step("cancel_bounty #3 by sponsor (no claim pending)", sponsor, write(address, "cancel_bounty", [3]));
  await step("refund #2 before deadline (must be rejected)", outsider, write(address, "refund", [2]), false);
  console.log(`\nHunter address for the PR body: ${hunter.address}`);
  console.log(`Open a PR on ${REPO} that closes #${ISSUE}, put the hunter address in its body, merge it, then run the judge phase.`);
} else if (PHASE === "judge") {
  const PR = Number(process.env.PR);
  if (!PR) throw new Error("set PR=<merged pull request number>");
  const keys = JSON.parse(fs.readFileSync(KEYS, "utf8"));
  const [sponsor, hunter, outsider] = [keys.sponsor, keys.hunter, keys.outsider].map((k) => createAccount(k));
  const address = state.contract;
  const prUrl = `https://github.com/${REPO}/pull/${PR}`;
  state.pr = prUrl;

  await step(`submit_claim #1 by outsider on ${prUrl} (squatting someone else's PR)`, outsider,
    write(address, "submit_claim", [1, prUrl]));
  await step("judge outsider claim (validators read GitHub; expect REJECTED: MISSING_AUTHORSHIP)", outsider,
    write(address, "judge", [1]), true, "MISSING_AUTHORSHIP");
  await step(`submit_claim #1 by hunter (PR ${PR})`, hunter, write(address, "submit_claim", [1, String(PR)]));
  await step("cancel_bounty #1 while hunter claim is pending (must be rejected)", sponsor, write(address, "cancel_bounty", [1]), false);
  await step("judge hunter claim (validators read GitHub + grade 3 criteria; expect ACCEPTED)", outsider,
    write(address, "judge", [2]), true, "ACCEPTED");
  await step("judge hunter claim again (must be rejected: bounty PAID)", hunter, write(address, "judge", [2]), false);
  await step("cancel_bounty #1 after payout (must be rejected)", sponsor, write(address, "cancel_bounty", [1]), false);
  await step("refund #1 after payout (must be rejected)", outsider, write(address, "refund", [1]), false);

  const b2 = await retry(() => read(address, "get_bounty", [2]));
  const wait = new Date(json(b2).deadline ?? json(b2).get?.("deadline")).getTime() - Date.now() + 20_000;
  if (wait > 0) { console.log(`  waiting ${Math.ceil(wait / 1000)}s for bounty #2 deadline...`); await sleep(wait); }
  await step("refund #2 after deadline, no claims (anyone may call; pays the sponsor)", outsider, write(address, "refund", [2]));

  save({ final_state: {
    bounties: json(await read(address, "list_bounties", [0, 10])),
    claims: json(await read(address, "get_claims", [1])),
  } });
  console.log("\nWrote deployments/studionet.json");
} else {
  console.log("usage: node scripts/lifecycle-studionet.mjs setup | judge");
}
