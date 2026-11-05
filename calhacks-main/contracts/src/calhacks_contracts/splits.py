"""The one split rule both sides use. Holdout listings never live in the shared database.

Rows are split by *group*: a synthetic listing belongs to the group of the real listing it was made from
(answer_key.base_listing_id), so every copy of one base listing lands on the same side and validation never tests
near-duplicates of training rows.

  train      70%  fits the model
  calibrate  10%  picks the decision threshold (never fitted on, never used for promotion)
  val        20%  validation and promotion decisions
"""
import hashlib
from typing import Literal

Split = Literal["train", "calibrate", "val"]


def group_of(listing_id: str, base_listing_id: str | None = None) -> str:
    return base_listing_id or listing_id


def split_of(listing_id: str, base_listing_id: str | None = None) -> Split:
    h = int(hashlib.sha256(group_of(listing_id, base_listing_id).encode()).hexdigest(), 16) % 10
    return "val" if h < 2 else "calibrate" if h == 2 else "train"
