"""Feature modules are checked statically before import, so coordinator-written code can't reach files, env or the
holdout that the red-team MCP server scores in-process."""
from pathlib import Path

import pytest

from gatepy import GATE_DIR
from gatepy.registry import discover
from gatepy.sandbox import FeaturePolicyError, check_dir, check_source

OK = '''
import math
import re
from calhacks_contracts import GateInput
from gatepy.registry import feature
from gatepy.clock import days_since
from features._text import normalize

WORDS = re.compile(r"[a-z]+")

@feature("ok_len", monotone=0)
def ok_len(x: GateInput) -> float:
    return math.log1p(len(WORDS.findall(normalize(x.listing.item.text))))
'''

ESCAPES = {
    "import os": "import os\n",
    "from os import environ": "from os import environ\n",
    "import pathlib": "import pathlib\n",
    "from importlib": "from importlib import import_module\n",
    "db access": "from calhacks_contracts.db import get_db\n",
    "families loader": "from calhacks_contracts.families import _load\n",
    "plain clock module": "import gatepy.clock\n",
    "open": "def f(x):\n    return open('k').read()\n",
    "eval": "def f(x):\n    return eval('1')\n",
    "getattr": "def f(x):\n    return getattr(x, 'a')\n",
    "__import__": "def f(x):\n    return __import__('os')\n",
    "dunder attr": "def f(x):\n    return x.__class__\n",
    "private attr": "import re\ndef f(x):\n    return re._compile\n",
    "format escape": "def f(x):\n    return '{0.__globals__}'.format(f)\n",
    "frame walk": "def f(x):\n    g = (i for i in [1])\n    return g.gi_frame.f_back\n",
    "pydantic parse_file": "from calhacks_contracts import GateInput\ndef f(x):\n    return GateInput.parse_file('k')\n",
    "re attribute": "import re\ndef f(x):\n    return re.enum\n",
    "typing eval": "from typing import get_type_hints\n",
    "global": "N = 0\ndef f(x):\n    global N\n    N = 1\n",
    "dunder def": "class A:\n    def __getattr__(self, n):\n        return n\n",
    "star import": "from features._text import *\n",
}


def test_existing_features_pass_the_policy():
    assert check_dir(GATE_DIR / "features") == []


def test_safe_feature_passes():
    assert check_source(OK) == []


@pytest.mark.parametrize("name", sorted(ESCAPES))
def test_escape_is_rejected(name):
    assert check_source(ESCAPES[name]), name


def test_bad_feature_file_is_never_imported(tmp_path):
    marker = tmp_path / "ran.txt"
    bad = GATE_DIR / "features" / "zz_sandbox_probe.py"
    bad.write_text(f"import pathlib\npathlib.Path({str(marker)!r}).write_text('x')\n", encoding="utf-8")
    try:
        with pytest.raises(FeaturePolicyError):
            discover()
        assert not marker.exists()
    finally:
        bad.unlink()
    assert discover()  # registry recovers once the file is gone


def test_gate_train_exits_2_on_policy_violation(tmp_path):
    from gatepy.train import main
    bad = GATE_DIR / "features" / "zz_sandbox_probe.py"
    bad.write_text("import os\n", encoding="utf-8")
    try:
        assert main(["--round", "1", "--out", str(tmp_path)]) == 2
    finally:
        bad.unlink()
        discover()
