import json
import sys
from pathlib import Path

import pytest

GENVM_VERSION = "v0.2.16"  # matches the contract header
CONTRACT = str(Path(__file__).resolve().parents[2] / "contracts" / "bounty_payout.py")
GEN = 10**18

REPO = "acme/widgets"
ISSUE = 7
PR = 42
CRITERIA = [
    "Adds a --dry-run flag to the CLI",
    "Includes a unit test for the new flag",
    "Documents the flag in README.md",
]
BOUNTY_ARGS = dict(
    repo=REPO,
    issue=ISSUE,
    title="Add a dry-run mode to the widgets CLI",
    criteria_json=json.dumps(CRITERIA),
    deadline="2026-12-31T23:59:59Z",
    judge_grace_hours=72,
    max_claims=3,
    max_attempts=2,
)
CREATED = "2026-11-05T00:00:00Z"
MERGED_OK = "2026-11-20T10:15:00Z"


def hexaddr(a):
    return a.as_hex if hasattr(a, "as_hex") else str(a)


def pr_json(hunter="", *, number=PR, state="closed", merged=True, merged_at=MERGED_OK, base=REPO,
            title="Add --dry-run flag", body=None, author="octo-hunter", head_sha="a" * 40, merge_sha="b" * 40):
    if body is None:
        body = f"Closes #{ISSUE}.\n\nAdds `--dry-run`, a test and docs.\n\nBounty payout address: {hexaddr(hunter)}"
    return {
        "number": number,
        "state": state,
        "merged": merged,
        "merged_at": merged_at if merged else None,
        "title": title,
        "body": body,
        "user": {"login": author},
        "head": {"sha": head_sha},
        "merge_commit_sha": merge_sha if merged else None,
        "base": {"repo": {"full_name": base}},
    }


FILES = [
    {"filename": "cli.py", "status": "modified", "additions": 20, "deletions": 2, "patch": "+parser.add_argument('--dry-run')"},
    {"filename": "tests/test_cli.py", "status": "added", "additions": 15, "deletions": 0, "patch": "+def test_dry_run(): ..."},
    {"filename": "README.md", "status": "modified", "additions": 4, "deletions": 0, "patch": "+`--dry-run` prints actions"},
]


def grading(*passes, reason="ok"):
    return json.dumps({"criteria": [{"id": i + 1, "pass": p, "reason": f"{reason} {i + 1}"} for i, p in enumerate(passes)]})


def mock_github(vm, pr=None, files=None, llm=None, number=PR, pr_status=200, files_status=200):
    """pr: dict (PR payload) or None for 404; llm: JSON string answer."""
    base = rf"api\.github\.com/repos/{REPO}/pulls/{number}"
    if pr is None:
        vm.mock_web(base + "$", {"status": 404, "body": '{"message": "Not Found"}'})
    else:
        vm.mock_web(base + "$", {"status": pr_status, "body": json.dumps(pr)})
    vm.mock_web(base + r"/files", {"status": files_status, "body": json.dumps(FILES if files is None else files)})
    if llm is not None:
        vm.mock_llm(r"ACCEPTANCE CRITERIA", llm)


@pytest.fixture
def bp(direct_vm, direct_deploy):
    direct_vm.check_pickling = True
    direct_vm.warp(CREATED)
    return direct_deploy(CONTRACT, sdk_version=GENVM_VERSION)


@pytest.fixture
def module(bp):
    return sys.modules[type(bp).__module__]


@pytest.fixture
def bounty(direct_vm, bp, direct_alice):
    """Alice (sponsor) escrows 100 GEN."""
    with direct_vm.prank(direct_alice):
        direct_vm.value = 100 * GEN
        bid = bp.create_bounty(**BOUNTY_ARGS)
        direct_vm.value = 0
    return bid


@pytest.fixture
def claim(direct_vm, bp, bounty, direct_bob):
    """Bob (hunter) claims with PR #42."""
    with direct_vm.prank(direct_bob):
        return bp.submit_claim(bounty, str(PR))


def after_merge(vm):
    vm.warp("2026-11-21T00:00:00Z")
