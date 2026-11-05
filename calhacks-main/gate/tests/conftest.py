import mongomock
import pytest
from calhacks_contracts.db import Repo
from pymongo import ReplaceOne

from gatepy import GATE_DIR
from gatepy.registry import discover
from gatepy.selftest import fixture_inputs
from gatepy.train import train

from expand import seed


def _bulk_write(self, requests, ordered=True, **_):
    """mongomock can't take pymongo 4.10+ ReplaceOne objects in bulk_write; apply them one by one."""
    for r in requests:
        assert isinstance(r, ReplaceOne), type(r)
        self.replace_one(r._filter, r._doc, upsert=r._upsert)


mongomock.collection.Collection.bulk_write = _bulk_write


def fresh_repo(name: str = "redteam_test") -> Repo:
    return Repo(mongomock.MongoClient()[name])


@pytest.fixture(scope="session")
def repo():
    r = fresh_repo()
    seed(r)
    return r


@pytest.fixture(scope="session")
def inputs():
    return {x.listing.listing_id: x for x in fixture_inputs()}


@pytest.fixture(scope="session")
def models_dir(tmp_path_factory):
    return tmp_path_factory.mktemp("models")


@pytest.fixture(scope="session")
def trained(repo, models_dir):
    return train(1, GATE_DIR / "train_config.yaml", out=models_dir, repo=repo)


@pytest.fixture(scope="session")
def baseline(repo, models_dir):
    return train(0, GATE_DIR / "configs" / "r0_baseline.yaml", out=models_dir, repo=repo)


@pytest.fixture(autouse=True)
def _fresh_registry():
    discover()
    yield
    discover()
