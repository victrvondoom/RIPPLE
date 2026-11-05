"""Schema 2: what the Factory coordinator receives (`RoundInput`) and passes on (`AttackSpec`, `RoundReport`).

The coordinator LLM only writes `CoordinatorOutput` (its diagnosis and changes). Code fills in the metrics, the
promotion decision and the cost when it assembles the `RoundReport`, so the headline numbers can't be invented.
"""
import math
from typing import Literal

from pydantic import Field

from calhacks_contracts._base import AttackerKnowledge, Label, Strict
from calhacks_contracts.gate import Reason
from calhacks_contracts.listing import Listing


class Budget(Strict):
    usd: float = Field(ge=0)
    tokens: int = Field(ge=0)
    minutes: float = Field(ge=0)


class AttackSpec(Strict):
    """An order for test listings, sent to the Bitdeer attack factory."""
    spec_id: str
    family: str = Field(description="Scam family from families.json, or 'legit_hard'")
    n: int = Field(ge=1, le=500)
    legit_ratio: float = Field(ge=0, le=1)
    mode: Literal["mutate_real", "generate"]
    base_listing_ids: list[str] = []
    target_weakness: str | None = None
    attacker_knowledge: AttackerKnowledge = "blind"
    model: str | None = None
    temperature: float | None = Field(default=None, ge=0, le=2)


class Rate(Strict):
    value: float
    lo: float
    hi: float
    k: int
    n: int


def rate(k: int, n: int, z: float = 1.96) -> Rate:
    """k/n with a Wilson 95% interval. n == 0 gives value 0 and the full [0, 1] interval."""
    if n == 0:
        return Rate(value=0.0, lo=0.0, hi=1.0, k=0, n=0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return Rate(value=p, lo=max(0.0, c - h), hi=min(1.0, c + h), k=k, n=n)


class HoldoutTotals(Strict):
    """Totals only, never rows (C3)."""
    model_id: str
    recall: Rate
    fpr: Rate
    layer2_fpr: Rate | None = Field(default=None, description="False blocks among legit rows that pass Layer 1")
    policy_bounded_recall: Rate | None = Field(default=None, description="Policy-bounded families, reported apart")


class Miss(Strict):
    """A validation listing the Gate got wrong, with the Gate's reasons."""
    listing: Listing
    label: Label
    family: str
    decision: Literal["buy", "skip"]
    decided_by: Literal["layer1", "layer2"] | None
    top_reasons: list[Reason] = []


class RoundInput(Strict):
    round: int = Field(ge=0)
    budget: Budget
    current_model_id: str | None
    last_report: "RoundReport | None" = None
    coverage: dict[str, int] = Field(default_factory=dict, description="Listing count per family so far")
    misses: list[Miss] = []
    holdout_totals: HoldoutTotals | None = None
    feature_list: list[str] = []


class FailureCluster(Strict):
    cause: str
    family: str | None = None
    count: int = Field(ge=0)
    example_ids: list[str] = []


class FeatureChange(Strict):
    feature: str
    action: Literal["add", "modify", "remove"]
    rationale: str


class RoundMetrics(Strict):
    layer1_catches: int
    layer2_recall: Rate
    fpr_real: Rate = Field(description="False blocks on real listings")
    per_family: dict[str, Rate]
    adaptive_recall: Rate | None = Field(default=None, description="Recall on white_box attacks")
    recall: Rate = Field(description="Full Gate recall on synthetic scams, excluding policy-bounded families")
    fpr: Rate = Field(description="Full Gate false-block rate on all legit listings")
    policy_bounded_recall: Rate | None = Field(
        default=None, description="Skip rate on policy-bounded scam families (families.json policy_bounded), "
                                  "reported apart from recall")
    layer2_fpr: Rate | None = Field(
        default=None, description="False blocks among legit listings that pass Layer 1: the trained model's own "
                                  "mistakes. Layer 1 policy blocks (e.g. unknown wallets over the cap) are excluded")


class PromotionDecision(Strict):
    action: Literal["promote", "revert"]
    reason: str


class Cost(Strict):
    usd: float = Field(ge=0)
    tokens: int = Field(ge=0)


class CoordinatorOutput(Strict):
    """The part of the round report the coordinator LLM writes itself (structured output)."""
    failures_by_cluster: list[FailureCluster]
    feature_changes: list[FeatureChange]
    train_params: dict = Field(default_factory=dict)
    notes: str | None = None


class RoundReport(Strict):
    round: int
    session_id: str | None
    failures_by_cluster: list[FailureCluster]
    feature_changes: list[FeatureChange]
    train_params: dict
    metrics: RoundMetrics
    decision: PromotionDecision
    cost: Cost


RoundInput.model_rebuild()
