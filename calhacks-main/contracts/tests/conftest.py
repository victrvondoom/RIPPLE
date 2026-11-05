import mongomock
from pymongo import ReplaceOne


def _bulk_write(self, requests, ordered=True, **_):
    """mongomock can't take pymongo 4.10+ ReplaceOne objects in bulk_write; apply them one by one."""
    for r in requests:
        assert isinstance(r, ReplaceOne), type(r)
        self.replace_one(r._filter, r._doc, upsert=r._upsert)


mongomock.collection.Collection.bulk_write = _bulk_write
