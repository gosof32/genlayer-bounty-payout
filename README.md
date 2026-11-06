# Bounty Payout

**Escrowed GitHub issue bounties that pay themselves out through GenLayer consensus.**

A sponsor locks GEN against one GitHub issue and a short list of plain-text acceptance criteria. A hunter claims it with a pull request. Anyone can then ask the validators to judge the claim. If the PR was merged into the right repository inside the bounty window, links the issue, carries the hunter's wallet address, and meets every acceptance criterion, the reward goes to the hunter in the same transaction. The sponsor can't veto an accepted claim, and no state leaves funds stuck.

The deterministic checks are done by contract code from the GitHub REST API. The LLM is used for one thing only: grading the PR against each acceptance criterion. Validators must agree on every hard fact exactly, and on every criterion's pass/fail.

---

## Why this is a primitive, not an LLM wrapper

| Concern | How the contract handles it |
|---|---|
| "Was it merged, into what, when?" | Read **deterministically** from `GET /repos/{owner}/{repo}/pulls/{n}`: `state`, `merged`, `base.repo.full_name`, `merged_at`, author login, merge and head SHAs. No model involved. |
| Proof of authorship | The PR body must contain the hunter's address (case-insensitive, not as a substring of a longer hex). Claiming someone else's PR is allowed but can never win. |
| Linking the issue | Contract regex on title + body: `#N`, `owner/repo#N`, or the issue URL (closing keywords recorded too). `#70` or `other/repo#7` don't count. |
| Subjective "is the work done?" | LLM grades title, body, changed files and truncated patches **per criterion** (pass/fail + reason). The overall verdict is computed by the contract: ACCEPT only if every criterion passed. |
| Validators see the same PR differently | Custom validator: hard facts must match **exactly**, rejection codes identical, per-criterion booleans identical. Reasons are free text and not compared. |
| Prompt injection in the PR | PR text is fenced as untrusted data, `<` `>` neutralized, size-capped. The model never sees or decides the hard facts. |
| GitHub down / rate-limited / model gives junk | `INCONCLUSIVE`: no state change, no attempt used, retry any time. A leader claiming INCONCLUSIVE is only believed if validators also fail. |
| PR still open | `NOT_READY`: no state change, no attempt used. |
| Stuck funds | Every path ends in `PAID`, `CANCELLED` or `REFUNDED`. Refunds can be triggered by anyone and always go to the sponsor. |
| Sponsor rug | The sponsor can't cancel while any claim is live, and nothing at all is possible once a claim is accepted. |
| Double payout | First accepted claim pays and flips the bounty to `PAID` in one transaction; every other open claim becomes `SUPERSEDED`. |
| Claim spam | `max_claims` caps claims *waiting for their first judgement*. Anyone can judge a pending claim, which frees its slot. |
| Griefing re-judges | First judgement: anyone. Re-judging a rejected claim: hunter only, and at most `max_attempts` substantive judgements per claim. |

Reusable pieces: `_hard_facts` / `_hard_codes` (deterministic PR checks), `_links_issue`, `_has_address`, `_parse_grading` (strict per-criterion model output), and `_agree` (the validator rule).

---

## State machine

```
Bounty
  create_bounty (sponsor, msg.value = reward)
        │
        ▼
      OPEN ─────── judge(claim) → ACCEPTED ───────────────► PAID      (reward → hunter)
        │
        ├── cancel_bounty (sponsor, no live claim) ────────► CANCELLED (reward → sponsor)
        │
        └── refund (anyone) after deadline if no live claim,
            or after judge_deadline regardless ────────────► REFUNDED  (reward → sponsor)

Claim
  submit_claim (before deadline)
        │
        ▼
     PENDING ── judge ──► ACCEPTED (paid)
        │          ├────► REJECTED ── judge by hunter (attempts left) ──► ACCEPTED / REJECTED
        │          ├────► NOT_READY      (PR still open: stays PENDING, no attempt used)
        │          └────► INCONCLUSIVE   (fetch / model error: stays PENDING, no attempt used)
        │
        └── another claim accepted ──► SUPERSEDED;  bounty cancelled/refunded ──► CLOSED
```

A claim is **live** while it is `PENDING`, or `REJECTED` with attempts left. Live claims block `cancel_bounty`, and block `refund` until `judge_deadline`.

Rejection codes: `NOT_MERGED` (closed without merge), `WRONG_REPO`, `MERGED_BEFORE_BOUNTY`, `MERGED_AFTER_DEADLINE`, `ISSUE_NOT_LINKED`, `MISSING_AUTHORSHIP`, `CRITERIA_NOT_MET`. If any hard code fires, the model is not consulted at all.

## How consensus is used

`judge(claim_id)` calls `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)`.

**Leader** (`_judge_once`):
1. `gl.nondet.web.get` on `api.github.com/repos/{o}/{r}/pulls/{n}` and `/pulls/{n}/files?per_page=100`.
2. Contract code extracts the hard facts: `state, merged, base_repo, merged_at, author, merge_sha, head_sha, links_issue, closing_keyword, has_address, files`.
3. Open PR → `NOT_READY`. Otherwise compute rejection codes (merged, base repo, `created_at ≤ merged_at ≤ deadline`, issue linked, address in body).
4. Only if no code fired: `gl.nondet.exec_prompt` grades each criterion and must return exactly one `{"pass": bool, "reason": str}` per criterion, in order. Anything else → `INCONCLUSIVE`.

**Validator** repeats the whole read and grading itself and votes yes only if:
1. the leader output is well formed (known kind, exact fact keys, bool/int types, known codes),
2. every hard fact is identical,
3. the rejection codes are identical,
4. every criterion has the same pass/fail (so the overall ACCEPT/REJECT matches too).

`INCONCLUSIVE` is accepted only when the validator is also inconclusive. A validator that can't read GitHub doesn't rubber-stamp a leader's ACCEPT.

**After consensus** (deterministic): the contract computes the verdict from the codes and booleans, stores the PR author login, `merged_at`, SHAs, codes, per-criterion results and reasons, and a SHA-256 `evidence_hash`, then pays or records the rejection.

Honest validators can disagree on a borderline criterion. They then fail to reach agreement and GenLayer's leader rotation / appeal takes over, rather than a coin-flip payout. Write criteria that are checkable from the PR (files, docs, tests), not taste.

---

## Contract API

### Write
| Method | Who | Notes |
|---|---|---|
| `create_bounty(repo, issue, title, criteria_json, deadline, judge_grace_hours, max_claims, max_attempts)` *payable* | sponsor | `msg.value` is the reward. Returns `bounty_id`. |
| `submit_claim(bounty_id, pr)` | hunter | `pr` is a number or `https://github.com/{repo}/pull/{n}`. Before `deadline`. One claim per address per bounty. |
| `judge(claim_id)` | anyone (re-judge: hunter) | Until `judge_deadline`. Returns `{status, codes, criteria, …}`. |
| `cancel_bounty(bounty_id)` | sponsor | Only while `OPEN` with no live claim. |
| `refund(bounty_id)` | anyone | After `deadline` if no live claim, or after `judge_deadline`. Pays the sponsor. |

### View
`get_bounty(id)`, `list_bounties(offset, limit)`, `get_claim(id)`, `get_claims(bounty_id)`, `get_claim_of(bounty_id, hunter)`, `get_stats()`.

### Parameters
| Field | Example | Meaning |
|---|---|---|
| `repo` / `issue` | `acme/widgets` / `7` | The issue the bounty is for. The PR must be merged into this repo. |
| `criteria_json` | `["Adds a --dry-run flag", "Includes a unit test for it"]` | 1-8 plain-text criteria, 3-200 chars each. |
| `deadline` | `2026-12-31T23:59:59Z` | ISO 8601 with zone. PRs must be merged and claims submitted by then. |
| `judge_grace_hours` | `72` | 0-336. Extra time after `deadline` to judge claims (a PR merged at 23:59 still gets judged). |
| `max_claims` | `3` | 1-20 claims waiting for their first judgement at once. |
| `max_attempts` | `2` | 1-5 substantive judgements per claim (NOT_READY / INCONCLUSIVE don't count). |

### Hunter checklist
In the PR: reference the issue (`Closes #7`) and put your wallet address in the body, e.g. `Bounty payout address: 0xAbc…`. Then `submit_claim` from that address and call `judge` once the PR is merged.

---

## Live on Studionet

Deployed and run end to end on GenLayer Studionet against the **real GitHub API**. All 17 contract transactions finalized with `MAJORITY_AGREE`: 10 succeeded and 7 were negative-path calls that reverted as expected.

Contract: `0xFb2372a7325F63Bb4f0a3330C075e9F58Fe7466A`

The demo bounty is real: issue [#1 "Add a CONTRIBUTING guide"](https://github.com/gosof32/genlayer-bounty-payout/issues/1) on this repository, claimed with [PR #2](https://github.com/gosof32/genlayer-bounty-payout/pull/2), which was opened and merged *after* the bounty was created and carries the demo hunter's throwaway address in its body. That is how the authorship proof works for any hunter; nothing is mocked or special-cased.

| Step | Result |
|---|---|
| Bounty #1: 100 units, 3 criteria on issue #1 | created `2026-11-06T07:22:17Z`, PR #2 merged `07:24:12Z` |
| Outsider claims PR #2 (someone else's PR) → `judge` | **REJECTED** `MISSING_AUTHORSHIP`, validators agreed, model not consulted |
| Sponsor tries to cancel while the hunter's claim is pending | reverts `[LOCKED]` |
| Hunter claims PR #2 → `judge` | **ACCEPTED**: validators read GitHub, all 3 criteria pass, 100 units paid; outsider claim → `SUPERSEDED` |
| Judge again / cancel / refund after payout | all revert `[CLOSED] bounty is PAID` |
| Bounty #2 (refund demo): refund before deadline / after deadline with no claims | reverts `[NOT_READY]` / **REFUNDED** to sponsor |
| Bounty #3 (cancel demo): outsider cancel / sponsor cancel | reverts `[FORBIDDEN]` / **CANCELLED**, 25 units back |
| `create_bounty` with no reward | reverts `[INVALID]` |

Key transactions:
- judge → REJECTED (outsider): `0xc67adad7a1f4e18c7bcd1c65fa8d3aedbcc631a0c068a2e89c4a58d2a5490c00`
- judge → ACCEPTED (hunter): `0xdfd51fbbb3f1e602f434cc31bd975fc8726ebed565525c3920b6dc3b359cf179`, payout transfer of 100 units to the hunter: `0x70075a1b0acfc7135ca6c698b4476bc9671ca341d2052943518f703348cbb974`
- refund #2: `0x700d5004ed26e849f2647bc934907f77e9d0e76f561b6fa57aafef34d5ad44ea`; cancel #3: `0x32fcef94da98f80285046b36df37bb8cb30db2a531348b6a8957801bbf833ca2`

Stored on the accepted claim: `pr_author` `gosof32`, `merged_at` `2026-11-06T07:24:12Z`, `merge_sha` `b80824e6…`, codes `[]`, and the evidence hash. The model's stored reasons for the accepted claim: "CONTRIBUTING.md is added at the repository root." / "Explains installation of dev requirements and running direct-mode tests with pytest." / "Explains how to run the Studionet lifecycle script (setup and judge)."

All transaction hashes, receipts, and the final contract state are in [`deployments/studionet.json`](deployments/studionet.json). To reproduce with throwaway keys:

```bash
npm install
node scripts/lifecycle-studionet.mjs setup        # deploys, opens bounties, prints the hunter address
# open + merge a PR on the bounty repo with "Closes #1" and that address in the body
PR=<number> node scripts/lifecycle-studionet.mjs judge
```

Set `BOUNTY_REPO=owner/repo` and `ISSUE=n` to run it against a repository you control.

---

## Tests

88 direct-mode tests with mocked GitHub API and LLM, so they need no node and are deterministic:

```bash
pip install -r requirements-dev.txt
pytest
```

They cover:
- creation validation (17 cases), escrow, pagination
- claims: number or URL, wrong repo, one per hunter, PR squatting can't block the author, the pending-claim cap, claims closing at the deadline
- judging: happy path payout, issue-link variants, not merged, wrong repo, missing / foreign / substring address, issue not linked, merged before the bounty, merged after the deadline, several codes at once, LLM rejection with reasons, open PR = NOT_READY, fetch errors and unusable model output = INCONCLUSIVE, prompt fencing
- re-judging: after a PR update, hunter-only, attempt limit, judging window
- payout safety: first accepted wins, others SUPERSEDED, no double payout, no cancel/refund after payout
- cancel and refund rules, including live claims blocking both
- the validator: agrees despite different reasons; rejects a criterion disagreement, a flipped verdict, same verdict for a different criterion, any fact mismatch (merged_at, head SHA, author), fabricated facts, a false INCONCLUSIVE, a result it can't verify, malformed output, unknown codes, wrong types, and a leader error
- pure helpers (issue links, address matching, bounded diff summary)

`genvm-lint check contracts/bounty_payout.py` passes (lint + SDK validation).

## Deploy

1. Open [GenLayer Studio](https://studio.genlayer.com) and paste `contracts/bounty_payout.py`.
2. Deploy (no constructor arguments).
3. Call `create_bounty` with the reward attached.

## Limits and design choices

- Public repositories only: validators read the unauthenticated GitHub API (60 requests/hour per IP). A judgement costs 2 requests per validator. Rate-limited reads come back `INCONCLUSIVE` and can be retried.
- The grader sees title, body, up to 60 changed files and truncated patches (1,200 chars per file, 8,000 total). Criteria that need the full codebase or running the code aren't a good fit.
- Authorship is "the PR body carries your address", which the PR author controls. The stored `pr_author` login is there for audit; a repo maintainer who edits a PR body could redirect a bounty, so use bounties on repos whose maintainers you trust.
- One reward per bounty, paid in full to the first accepted claim. Split or tiered rewards can be built by opening several bounties.
- A spammer can keep claims live and so delay a sponsor's cancel, but never past `judge_deadline`, after which anyone can refund.

## License

MIT
