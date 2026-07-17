# MicroVM sandbox image — the "bring your own image" that AgentCore could never be.
#
# Playwright's Python base already carries Chromium + all its system libs, so
# browser-use runs INSIDE this sandbox (no separate browser-service). We add
# Node (for the stdlib exec-server) and the research-skill Python deps.
#
# The MicroVM OS + service components come from --base-image-arn at build time
# (create-microvm-image), NOT from this FROM — this layer is only the app.
# noble (Ubuntu 24.04) ships Python 3.12 — jammy's 3.10 is too old for
# browser-use (which requires >=3.11). Multi-arch, so it builds on Graviton.
# The base image tag pins the pre-baked Chromium build; the pip `playwright`
# below MUST match this exact version or launch fails with "Executable doesn't
# exist" (the browsers at /ms-playwright are versioned per Playwright release).
FROM mcr.microsoft.com/playwright/python:v1.61.0-noble

# Node 20 for the exec-server (stdlib only). Jammy's apt nodejs is v12, which
# predates the `node:` import prefix the exec-server uses — install from
# NodeSource instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/sandbox

# The base image ships Chromium binaries at /ms-playwright but not always the
# playwright PYTHON package in the system interpreter — install it explicitly
# (browser-use drives Chromium through it) and pin the browsers path so a
# launch finds the pre-baked Chromium with no download at run time.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Skill runtime deps, baked in so a skill never pip-installs at run time.
# httpx + trafilatura cover the http research path; playwright + browser-use are
# the Chromium path (Chromium itself is already present from the base).
RUN pip install --no-cache-dir \
    "httpx>=0.27" \
    "trafilatura>=1.8" \
    "playwright==1.61.0" \
    "browser-use>=0.1"

# The exec-server the provider talks to.
COPY exec-server.mjs /opt/sandbox/exec-server.mjs

# The agent's working directory inside the VM.
RUN mkdir -p /workspace
ENV WORKSPACE_DIR=/workspace

# Lambda routes inbound traffic to 8080 by default.
EXPOSE 8080

# Lambda snapshots the running state, so the server is up the instant a MicroVM
# resumes from the image — no cold boot.
CMD ["node", "/opt/sandbox/exec-server.mjs"]
