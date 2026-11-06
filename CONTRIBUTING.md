# Contributing to Bounty Payout

Thanks for helping. This repository holds one GenLayer Intelligent Contract
(`contracts/bounty_payout.py`), its direct-mode tests, and a Studionet lifecycle script.

## Run the tests

You need Python 3.12.

```bash
pip install -r requirements-dev.txt   # genlayer-test 0.29.2, pytest, cloudpickle
pytest                                # runs tests/direct in direct mode, no node needed
```

The tests mock the GitHub API and the LLM, so they are deterministic and run in a few seconds.
Optionally lint the contract with `pip install genvm-linter && genvm-lint check contracts/bounty_payout.py`.

## Run the Studionet lifecycle

You need Node.js 20 or newer.

```bash
npm install
node scripts/lifecycle-studionet.mjs setup          # deploys, opens bounties, prints the hunter address
# open and merge a PR on the bounty repo that closes the issue and carries the hunter address
PR=<number> node scripts/lifecycle-studionet.mjs judge
```

The script uses throwaway keys funded with `sim_fundAccount` (stored in the git-ignored
`artifacts/keys.json`) and writes every transaction hash and status to `deployments/studionet.json`.

## Pull requests

- Keep the contract header (`# v0.2.16` and the `Depends` line) unchanged.
- Add or update a direct test for every behaviour change.
- If your PR claims a bounty, reference the issue (`Closes #N`) and put your wallet address in the PR body.
