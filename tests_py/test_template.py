"""ripple.template.yaml is linted with Switch's OWN linter (switch_core.template_lint) from the local Switch Console install."""
import glob
import json
import os
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENV = glob.glob(os.path.join(os.environ.get("APPDATA", ""), "switchdash", "local-switch-server", "native", "switch-core", "*", "venv", "Scripts", "python.exe"))
LINT = "import sys,json;from switch_core.template_lint import lint_template as l;r=l(open(sys.argv[1],encoding='utf-8').read());print(json.dumps({'errors':[str(e) for e in r.errors],'warnings':[str(w) for w in r.warnings]}))"


def test_template_is_version_2_with_resources():
    text = open(os.path.join(ROOT, "ripple.template.yaml"), encoding="utf-8").read()
    assert "\nversion: 2\n" in text and "\nresources:\n" in text and "type: room" in text and "type: agent" in text


@pytest.mark.skipif(not VENV, reason="Switch Console (switch-core venv) not installed on this machine")
def test_switch_linter_accepts_template():
    out = subprocess.run([VENV[0], "-c", LINT, os.path.join(ROOT, "ripple.template.yaml")], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout.strip().splitlines()[-1]) == {"errors": [], "warnings": []}
