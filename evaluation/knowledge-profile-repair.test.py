"""Verify preservation and evidence remapping in the local desktop recovery."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("repair", Path(__file__).parents[1] / "scripts/repair-knowledge-profile.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class ProfileRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.desktop = self.root / "desktop"
        self.generated = self.root / "generated"
        self.output = self.root / "prepared"
        for directory, id_, project in ((self.desktop, "desktop-id", "texts"), (self.generated, "generated-id", "project-a")):
            (directory / "sources").mkdir(parents=True)
            (directory / "sources" / (id_ + ".txt")).write_text("source evidence", encoding="utf-8")
            self.write(directory, "library.json", {"sources": [{"id": id_, "path": "same-document", "hash": "same-hash", "project": project}], "folders": ["same-folder"], "buildModel": "current" if directory == self.desktop else "pro", "enabled": False})
            self.write(directory, "inbox.json", {"items": [], "matches": [], "drafts": [], "editor": None, "cursor": None})
        self.question = {"id": "q-id", "question": "Explain the implementation", "project": "project-a", "answer": "Original editable answer", "status": "draft", "references": [{"sourceId": "generated-id", "hash": "same-hash", "quote": "source evidence"}], "missing": ["Verify own contribution"]}
        self.write(self.generated, "inbox.json", {"items": [self.question], "matches": [], "drafts": [], "editor": None, "cursor": None})

    @staticmethod
    def write(root, name, value):
        (root / name).write_text(json.dumps(value), encoding="utf-8")

    def test_remaps_evidence_and_retains_text_ids_and_verification_flags(self):
        before = (self.desktop / "inbox.json").read_bytes()
        result = repair.prepare(self.desktop, self.generated, self.output)
        question = repair.read(self.output / "inbox.json")["items"][0]
        self.assertEqual(question["references"][0]["sourceId"], "desktop-id")
        self.assertEqual(question["answer"], self.question["answer"])
        self.assertEqual(question["missing"], self.question["missing"])
        self.assertEqual(result["pending"], 1)
        self.assertFalse(result["bankEnabled"])
        self.assertEqual((self.desktop / "inbox.json").read_bytes(), before)
        self.assertEqual((self.output / "sources/desktop-id.txt").read_text(), "source evidence")

    def test_retains_desktop_edits_instead_of_overwriting(self):
        edited = {**self.question, "answer": "Desktop edited answer"}
        edited["references"] = [{"sourceId": "desktop-id", "hash": "same-hash", "quote": "source evidence"}]
        self.write(self.desktop, "inbox.json", {"items": [edited]})
        with self.assertRaisesRegex(ValueError, "edited"):
            repair.prepare(self.desktop, self.generated, self.output)
        self.assertFalse(self.output.exists())
        self.assertEqual(repair.read(self.desktop / "inbox.json")["items"][0]["answer"], "Desktop edited answer")

    def test_changed_material_aborts_before_any_staged_write(self):
        lib = repair.read(self.desktop / "library.json")
        lib["sources"][0]["hash"] = "new-hash"
        self.write(self.desktop, "library.json", lib)
        with self.assertRaisesRegex(ValueError, "changed"):
            repair.prepare(self.desktop, self.generated, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
