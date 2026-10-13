"""Prepare a local migration from a packaged tool profile to a desktop profile.

This does not write AppData or call a model. The desktop restore step consumes
the prepared files after checking the backup's hashes and application state.
"""
import argparse
import copy
import hashlib
import json
import shutil
from pathlib import Path


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(desktop, generated, output):
    old = read(desktop / "library.json")
    incoming = read(generated / "library.json")
    inbox = read(desktop / "inbox.json")
    restored = read(generated / "inbox.json")
    if output.exists():
        raise ValueError("Use a new staging directory; existing data was retained")
    by_path = {s["path"]: s for s in old["sources"]}
    if len(by_path) != len(old["sources"]):
        raise ValueError("The desktop source list has duplicate paths; resolve before migration")
    merged = copy.deepcopy(old)
    merged_by_path = {s["path"]: s for s in merged["sources"]}
    source_ids = {}
    project_ids = {}
    extra_sources = []
    for source in incoming["sources"]:
        existing = merged_by_path.get(source["path"])
        if existing:
            if existing["hash"] != source["hash"]:
                raise ValueError("A source changed after generation; no files were restored")
            if (desktop / "sources" / (existing["id"] + ".txt")).read_bytes() != (
                generated / "sources" / (source["id"] + ".txt")
            ).read_bytes():
                raise ValueError("Extracted source text differs; manual reconciliation is required")
            source_ids[source["id"]] = existing["id"]
            # Restore the generated project grouping for flattened folder imports.
            if existing["project"] in ("", "texts"):
                existing["project"] = source["project"]
            project_ids.setdefault(source["project"], set()).add(existing["project"])
        else:
            merged["sources"].append(copy.deepcopy(source))
            merged_by_path[source["path"]] = merged["sources"][-1]
            source_ids[source["id"]] = source["id"]
            project_ids.setdefault(source["project"], set()).add(source["project"])
            extra_sources.append(source)

    def remap(value):
        if isinstance(value, list):
            for item in value:
                remap(item)
        elif isinstance(value, dict):
            if "sourceId" in value:
                value["sourceId"] = source_ids.get(value["sourceId"], value["sourceId"])
            if "sourceIds" in value:
                value["sourceIds"] = [source_ids.get(s, s) for s in value["sourceIds"]]
            if "question" in value and "project" in value:
                projects = project_ids.get(value["project"], set())
                if len(projects) == 1:
                    value["project"] = next(iter(projects))
            for child in value.values():
                remap(child)

    restored = copy.deepcopy(restored)
    remap(restored)
    existing_questions = {q["id"]: q for q in inbox["items"]}
    added = 0
    for q in restored["items"]:
        if q["id"] in existing_questions:
            if existing_questions[q["id"]] != q:
                raise ValueError("A question was edited on the desktop; no answer was overwritten")
        else:
            inbox["items"].append(q)
            existing_questions[q["id"]] = q
            added += 1
    for field in ("matches", "drafts"):
        existing = {json.dumps(v, sort_keys=True, ensure_ascii=False) for v in inbox.get(field, [])}
        inbox.setdefault(field, [])
        for value in restored.get(field, []):
            key = json.dumps(value, sort_keys=True, ensure_ascii=False)
            if key not in existing:
                inbox[field].append(value)
                existing.add(key)
    if inbox.get("editor") is None:
        inbox["editor"] = restored.get("editor")
    if inbox.get("cursor") is None:
        inbox["cursor"] = restored.get("cursor")
    merged["folders"] = list(dict.fromkeys(old.get("folders", []) + incoming.get("folders", [])))
    if old.get("buildModel") in (None, "", "current"):
        merged["buildModel"] = incoming.get("buildModel", "current")

    sources = {s["id"]: s for s in merged["sources"]}
    references = 0
    for q in inbox["items"]:
        for ref in q.get("references", []):
            source = sources.get(ref["sourceId"])
            if source is None or source["hash"] != ref["hash"]:
                raise ValueError("A question references missing or changed evidence")
            references += 1
    shutil.copytree(desktop, output, ignore=shutil.ignore_patterns(".diagnostics"))
    for source in extra_sources:
        file = source["id"] + ".txt"
        shutil.copy2(generated / "sources" / file, output / "sources" / file)
    for name, value in (("library.json", merged), ("inbox.json", inbox)):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = {"sources": len(sources), "pending": len(inbox["items"]), "addedQuestions": added,
              "remappedSources": len(source_ids), "referencesChecked": references,
              "sourceTextFilesUnchanged": not extra_sources, "bankEnabled": merged["enabled"]}
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop", type=Path)
    parser.add_argument("generated", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.desktop, args.generated, args.output), ensure_ascii=False))
