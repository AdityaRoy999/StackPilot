import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("github_revision", Path(__file__).resolve().parents[2] / "deployment-runtime/github_revision.py")
revision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(revision)


class RevisionTests(unittest.TestCase):
    def test_resolves_default_branch_to_full_commit(self):
        calls = []
        def fetch(path):
            calls.append(path)
            return {"default_branch": "trunk"} if not path else {"sha": "a" * 40}
        self.assertEqual(revision.resolve("owner/repo", "", fetch=fetch)["sha"], "a" * 40)
        self.assertEqual(calls, ["", "/commits/trunk"])

    def test_branch_with_slash_stays_in_one_url_segment(self):
        calls = []
        def fetch(path):
            calls.append(path)
            return {"sha": "b" * 40}
        revision.resolve("owner/repo", "feature/new-ui", fetch=fetch)
        self.assertEqual(calls, ["/commits/feature%2Fnew-ui"])

    def test_head_uses_repository_default_instead_of_guessing_main(self):
        result = revision.resolve("owner/repo", "HEAD", fetch=lambda path: {"default_branch": "master"} if not path else {"sha": "a" * 40})
        self.assertEqual(result["ref"], "master")

    def test_short_sha_is_canonicalized_and_checked(self):
        result = revision.resolve("owner/repo", "ABCDEF1", fetch=lambda _: {"sha": "abcdef1" + "0" * 33})
        self.assertEqual(result["sha"], "abcdef1" + "0" * 33)
        with self.assertRaises(ValueError):
            revision.resolve("owner/repo", "abcdef1", fetch=lambda _: {"sha": "b" * 40})

    def test_missing_or_malformed_commit_cannot_be_built(self):
        for value in ("main", "a" * 7, "a" * 41, ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                revision.resolve("owner/repo", "main", fetch=lambda _: {"sha": value})

    def test_bad_repository_cannot_redirect_credentials(self):
        for repo in ("https://elsewhere.test/repo", "owner/repo/extra", "owner/repo?token=x"):
            with self.subTest(repo=repo), self.assertRaises(ValueError):
                revision.resolve(repo, "main", "fixture-only", fetch=lambda _: self.fail("No request should run"))


if __name__ == "__main__":
    unittest.main()
