"""The split rule lives in calhacks_contracts; re-exported here for convenience.

Rows are split by group (a synthetic listing goes with its real base listing): train fits, calibrate picks the
threshold, val decides promotion.
"""
from calhacks_contracts.splits import group_of, split_of

__all__ = ["group_of", "split_of"]
