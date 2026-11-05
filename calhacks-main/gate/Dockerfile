# The Gate service. Built from the repo root, since it needs contracts/, gate/ and the gates/ release archive
# (Railway settings: see gates/README.md). Python for Layer 2, Node for Layer 1's TypeScript rules.
FROM node:22-bookworm-slim AS node

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# LightGBM needs the OpenMP runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY contracts contracts
COPY gate/pyproject.toml gate/uv.lock gate/.python-version gate/
COPY gate/gatepy gate/gatepy
COPY gate/features gate/features
COPY gate/configs gate/configs
COPY gate/train_config.yaml gate/
COPY gate/layer1/package.json gate/layer1/
COPY gate/layer1/src gate/layer1/src
WORKDIR /repo/gate
RUN uv sync --frozen --no-dev --extra serve

# The release: the model file and the exact feature code it was trained with. GATE_MODEL_ID picks one of gates/;
# empty means gates/CURRENT. The build fails if the feature code doesn't match the model's hash.
ARG GATE_MODEL_ID=""
COPY gates /repo/gates
RUN uv run --no-sync gate-release install ${GATE_MODEL_ID}

# One OpenMP thread per prediction: LightGBM otherwise starts a pool sized to the host's CPUs inside every concurrent
# request, which ran out of threads on Railway ("libgomp: Thread creation failed") and restarted the service.
ENV OMP_NUM_THREADS=1
CMD ["sh", "-c", "uv run --no-sync uvicorn --factory gatepy.app:create_app --host 0.0.0.0 --port ${PORT:-8080}"]
