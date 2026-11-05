"""Gate Layer 2: features, training, evaluation and scoring. Layer 1 lives in gate/layer1 (TypeScript).

All data comes from MongoDB through calhacks_contracts.db.Repo; the contract models live in calhacks_contracts.
"""
import os
from pathlib import Path

GATE_DIR = Path(__file__).resolve().parents[1]
REPO = GATE_DIR.parent
CONTRACTS = Path(os.environ.get("CALHACKS_CONTRACTS", REPO / "contracts"))
MODELS = Path(os.environ.get("GATE_MODELS", GATE_DIR / "models"))
LAYER1_CLI = GATE_DIR / "layer1" / "src" / "cli.ts"
