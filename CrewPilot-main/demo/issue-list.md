# CrewPilot Demo Issue Candidates

**Status:** Verified Candidates (Pre-Hackathon Preparation)  
**Date:** 2026-11-01  
**Verification Method:** GitHub API & Web Search (Verified open as of November 1, 2026)  

---

## 1. Primary Demo Candidate: `psf/requests#7634`

- **Repository:** `psf/requests`
- **Issue URL:** https://github.com/psf/requests/issues/7634
- **Title:** Non-string form field names raise `AttributeError` when files are attached
- **Current Status:** OPEN
- **Estimated Complexity:** Low to Medium (~15 lines of code)
- **Relevant Source File:** `requests/models.py` (specifically around line 245 in `_encode_files`)

### Problem Summary
In `requests`, passing non-string keys in form `data` (e.g. `{1: "a"}`) works normally for urlencoded payloads. However, when files are attached (`files={"f": b"x"}`), the body transitions to multipart/form-data. In `requests/models.py`, `_encode_files` stringifies values with `str()`, but passes the field name key `k` directly to `RequestField(name=k, ...)`. When urllib3 attempts to process the field name with `.translate()`, it crashes with `AttributeError: 'int' object has no attribute 'translate'`.

### Expected Behavior
Non-string keys should be converted to strings (`str(k)`) or properly handled so that `{1: "a"}` behaves consistently whether files are attached or not.

### Reporter Reproduction Steps
```python
import requests

# Fails with AttributeError: 'int' object has no attribute 'translate':
requests.Request("POST", "http://example.com", data={1: "a"}, files={"f": b"x"}).prepare()
```

### Proposed Regression Test
```python
def test_non_string_form_field_names_with_files():
    req = requests.Request("POST", "http://example.com", data={123: "val"}, files={"f": b"content"})
    prep = req.prepare()
    assert b'name="123"' in prep.body
```

### Reproduction Status
**NOT YET VERIFIED** (Will be reproduced live by `crewpilot-repro-builder` in an isolated worktree during Milestone 2).

---

## 2. Backup Candidate A: `pydantic/pydantic#14056`

- **Repository:** `pydantic/pydantic`
- **Issue URL:** https://github.com/pydantic/pydantic/issues/14056
- **Title:** `ByteSize.human_readable()` shows `1024.0KiB` instead of `1.0MiB` just below a unit boundary
- **Current Status:** OPEN
- **Estimated Complexity:** Low (~5 lines of code)
- **Relevant Source File:** `pydantic/types.py` (inside `ByteSize.human_readable`)

### Problem Summary
`ByteSize.human_readable()` determines the display unit by evaluating `abs(num) < divisor` on the unrounded value, but then formats the number to 1 decimal place. When a value is just below a boundary (e.g. `1048575` bytes = 1,048,575 bytes, which is 1023.999 KiB), it passes `< 1024 * 1024`, selecting `KiB`. When printed with `"{:.1f}".format()`, it rounds up to `1024.0KiB` instead of shifting to `1.0MiB`.

### Expected Behavior
Rounding should occur before selecting the unit, or boundary logic should handle decimal display rounding:
- `ByteSize(1048575).human_readable()` -> `1.0MiB`
- `ByteSize(999_999).human_readable(decimal=True)` -> `1.0MB`

### Reporter Reproduction Steps
```python
from pydantic import ByteSize

print(ByteSize(1048575).human_readable())  # Outputs 1024.0KiB (expected 1.0MiB)
```

### Proposed Regression Test
```python
def test_bytesize_human_readable_boundary():
    assert ByteSize(1048575).human_readable() == "1.0MiB"
    assert ByteSize(999_999).human_readable(decimal=True) == "1.0MB"
```

### Reproduction Status
**NOT YET VERIFIED** (To be executed during hackathon).

---

## 3. Backup Candidate B: `urllib3/urllib3#5324`

- **Repository:** `urllib3/urllib3`
- **Issue URL:** https://github.com/urllib3/urllib3/issues/5324
- **Title:** `wait_for_read()` and `wait_for_socket()` raise `OverflowError` for large socket timeouts
- **Current Status:** OPEN
- **Estimated Complexity:** Medium (~10-20 lines)
- **Relevant Source File:** `src/urllib3/util/wait.py`

### Problem Summary
`select.poll()` takes timeout in milliseconds as a C signed 32-bit integer (`INT_MAX = 2147483647 ms` ~ 24.8 days). `src/urllib3/util/wait.py` multiplies seconds by 1000 and passes it directly to `poll()`. If a user or library specifies a large timeout (e.g. `1e9`), `poll()` raises `OverflowError: timeout is too large` instead of waiting or clamping to max system delay.

### Expected Behavior
Timeouts should be clamped to `2147483.647` seconds (or `INT_MAX // 1000`) before calling system polling primitives.

### Reporter Reproduction Steps
```python
import socket
from urllib3.util.wait import wait_for_read

a, b = socket.socketpair()
a.settimeout(1e9)
wait_for_read(a, a.gettimeout())  # Raises OverflowError
```

### Proposed Regression Test
```python
def test_large_socket_timeout_clamped():
    a, b = socket.socketpair()
    # Should not raise OverflowError:
    assert wait_for_read(a, timeout=1e9) is False
```

### Reproduction Status
**NOT YET VERIFIED** (To be executed during hackathon).
