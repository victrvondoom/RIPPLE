"""Write JSON Schemas for every contract model to contracts/schemas/ (consumed by TypeScript and docs).

  contracts-export           # write
  contracts-export --check   # exit 1 if the files on disk are out of date
"""
import argparse, json, sys

from calhacks_contracts import (
    AnswerKey, AttackSpec, CoordinatorOutput, GateDecision, GateInput, GateRequest, GenInfo, Listing, ListingMeta,
    RoundInput, RoundReport, SyntheticListing,
)
from calhacks_contracts.families import CONTRACTS_DIR

MODELS = [Listing, ListingMeta, SyntheticListing, AnswerKey, GenInfo, AttackSpec, RoundInput, RoundReport,
          CoordinatorOutput, GateRequest, GateInput, GateDecision]
OUT = CONTRACTS_DIR / "schemas"


def rendered() -> dict[str, str]:
    return {f"{m.__name__}.schema.json": json.dumps(m.model_json_schema(), indent=2, ensure_ascii=False) + "\n"
            for m in MODELS}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="contracts-export")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    files = rendered()
    if a.check:
        stale = [n for n, body in files.items()
                 if not (OUT / n).is_file() or (OUT / n).read_text(encoding="utf-8").replace("\r\n", "\n") != body]
        print(json.dumps({"stale": stale}))
        return 1 if stale else 0
    OUT.mkdir(exist_ok=True)
    for n, body in files.items():
        (OUT / n).write_text(body, encoding="utf-8", newline="\n")
    print(json.dumps({"written": sorted(files)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
