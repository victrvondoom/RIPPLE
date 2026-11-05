"""A Bitdeer call that never answers is cut off by the wall-clock deadline and retried, not waited on forever."""
import threading
import time
from types import SimpleNamespace

from redteam import bitdeer


class Hanging:
    """First call blocks until released; later calls answer at once."""
    def __init__(self):
        self.calls = 0
        self.release = threading.Event()
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **_):
        self.calls += 1
        if self.calls == 1:
            self.release.wait(30)
            raise RuntimeError("released")
        msg = SimpleNamespace(content='{"ok": true}')
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)], usage=None)


def test_hung_call_times_out_and_is_retried():
    c, tally = Hanging(), bitdeer.Tally()
    t0 = time.monotonic()
    out = bitdeer.complete_json(c, "m", [], 0.5, tally, deadline=0.5, sleep=lambda _: None)
    c.release.set()
    assert out == {"ok": True}
    assert c.calls == 2 and tally.failures == 1
    assert time.monotonic() - t0 < 5


def test_errors_inside_the_call_still_reach_the_retry_logic():
    class Boom:
        chat = SimpleNamespace(completions=SimpleNamespace(create=lambda **_: (_ for _ in ()).throw(ValueError("x"))))
    tally = bitdeer.Tally()
    assert bitdeer.complete_json(Boom(), "m", [], 0.5, tally, attempts=2, sleep=lambda _: None) is None
    assert tally.failures == 2
