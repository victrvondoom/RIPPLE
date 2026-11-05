"""Shared contracts for the Gate and the red-team loop (GitHub issue #1).

One listing shape (`Listing`) is used for real listings, synthetic listings and the Gate's input.
`SyntheticListing` wraps a `Listing` with an answer key and generator info that never reach the Gate.
"""
from calhacks_contracts.coordinator import (
    AttackSpec, Budget, CoordinatorOutput, Cost, FailureCluster, FeatureChange, HoldoutTotals, Miss,
    PromotionDecision, Rate, RoundInput, RoundMetrics, RoundReport, rate,
)
from calhacks_contracts.gate import (
    Case, Check, GateDecision, GateInput, GateRequest, KnownSeller, Mandate, Proposal, Reason, References,
)
from calhacks_contracts.listing import Checkout, Item, Listing, ListingMeta, Seller
from calhacks_contracts.synthetic import AnswerKey, GenInfo, SyntheticListing

__all__ = [
    "AnswerKey", "AttackSpec", "Budget", "Case", "Check", "Checkout", "CoordinatorOutput", "Cost",
    "FailureCluster", "FeatureChange", "GateDecision", "GateInput", "GateRequest", "GenInfo", "HoldoutTotals", "Item",
    "KnownSeller", "Listing", "ListingMeta", "Mandate", "Miss", "PromotionDecision", "Proposal", "Rate", "Reason",
    "References", "RoundInput", "RoundMetrics", "RoundReport", "Seller", "SyntheticListing", "rate",
]
