"""The benchmark's metric math and cluster-bootstrap intervals (no Bitdeer, no MongoDB)."""
from redteam import bench


def row(i, label, family, decision, by=None, risk=None, group=None):
    return {"listing_id": f"L{i}", "group": group or f"G{i}", "label": label, "family": family,
            "decision": {"decision": decision, "decided_by": by, "risk_score": risk}}


def toy():
    rows = []
    i = 0
    for k in range(40):  # seen scams: 30 caught (10 by layer1, 20 by layer2), 10 bought
        dec, by = ("skip", "layer1") if k < 10 else (("skip", "layer2") if k < 30 else ("buy", None))
        rows.append(row(i, "scam", "too_cheap", dec, by, 0.9 if by == "layer2" else (0.2 if dec == "buy" else None),
                        group=f"B{k // 4}")); i += 1
    for k in range(10):  # held-out: 2 caught
        rows.append(row(i, "scam", "urgency_pressure", "skip" if k < 2 else "buy", "layer2" if k < 2 else None,
                        0.8 if k < 2 else 0.3)); i += 1
    for k in range(10):  # policy-bounded unknown_seller: 1 caught
        rows.append(row(i, "scam", "unknown_seller", "skip" if k < 1 else "buy", "layer2" if k < 1 else None,
                        0.7 if k < 1 else 0.3)); i += 1
    for k in range(50):  # honest: 3 policy blocks (layer1), 2 model blocks
        dec, by = ("skip", "layer1") if k < 3 else (("skip", "layer2") if k < 5 else ("buy", None))
        rows.append(row(i, "legit", "real" if k % 2 else "legit_plain", dec, by,
                        None if by == "layer1" else (0.85 if by == "layer2" else 0.1))); i += 1
    return rows


def test_metric_values():
    s = bench.summarize(toy(), boot=200)
    assert s["recall"]["value"] == 0.75 and s["recall"]["n"] == 40          # policy-bounded and held-out excluded
    assert s["held_out_recall"]["value"] == 0.2
    assert s["policy_bounded_recall"]["value"] == 0.1
    assert s["false_blocks"]["value"] == 0.1
    assert s["false_blocks_policy"]["value"] == 0.06
    assert round(s["false_blocks_model"]["value"], 3) == round(2 / 47, 3)    # legit rows reaching layer 2
    assert s["accuracy"]["value"] == round((30 + 45) / 90, 3)
    assert 0.5 < s["l2_risk_auc"]["value"] <= 1.0


def test_intervals_contain_the_estimate_and_widen_with_clustering():
    s = bench.summarize(toy(), boot=300)
    for k in ("accuracy", "recall", "false_blocks"):
        assert s[k]["lo"] <= s[k]["value"] <= s[k]["hi"], k
    # outcomes that move together within base listings (copies of one listing) must widen the interval
    independent = toy()
    for r in independent:
        if r["family"] == "too_cheap":
            r["group"] = r["listing_id"]  # every row its own base listing
    correlated = toy()
    caught = [r for r in correlated if r["family"] == "too_cheap" and r["decision"]["decision"] == "skip"]
    bought = [r for r in correlated if r["family"] == "too_cheap" and r["decision"]["decision"] == "buy"]
    for j, r in enumerate(caught):
        r["group"] = f"C{j // 10}"  # 3 bases, all copies caught
    for r in bought:
        r["group"] = "C3"  # 1 base, all copies bought
    narrow = bench.summarize(independent, boot=400)["recall"]
    wide = bench.summarize(correlated, boot=400)["recall"]
    assert narrow["value"] == wide["value"] == 0.75
    assert (wide["hi"] - wide["lo"]) > (narrow["hi"] - narrow["lo"])
