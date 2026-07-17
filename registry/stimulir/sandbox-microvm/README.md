# @stimulir/code-runtime-sandbox-microvm

AWS Lambda MicroVM (Firecracker) sandbox provider for code-runtime — the
substrate replacement for `@stimulir/code-runtime-sandbox-agentcore`.

## Why over AgentCore Code Interpreter

| | AgentCore Code Interpreter | Lambda MicroVM |
|---|---|---|
| Own image / Chromium | no — managed runtime, can't install a browser | **yes** — bring-your-own Dockerfile (browser-use runs *inside*) |
| Secret → sandbox env | no — `executeCommand` takes no env | **yes** — native, per-VM, via `runHookPayload` |
| Max lifetime | 900s session idle | **8h** suspend/resume |
| Isolation | shared managed interpreter | **VM** — dedicated kernel/memory/disk |
| Region | eu-west-2 (+others) | **eu-west-1** (+us-east-1, …) — **not eu-west-2** |

## Shape

Surface-compatible with `AgentCoreSandbox` (`start`/`exec`/`run`/`readFile`/`writeFile`/`dispose`),
so a consumer that drives the AgentCore sandbox directly swaps by construction.

- **Control plane** (`src/microvm.ts`): `@aws-sdk/client-lambda-microvms` —
  `RunMicrovm` → poll `GetMicrovm` until `RUNNING` → `CreateMicrovmAuthToken` →
  `TerminateMicrovm`.
- **Exec plane**: HTTPS to the running VM's endpoint (`X-aws-proxy-auth` token)
  → the in-VM exec-server on port 8080.
- **Secrets**: per-session vault keys ride `runHookPayload` (16KB, unique per
  MicroVM) → the `/run` hook parses them → they land in every exec's env.
  *(Proven live against the exec-server.)*

## Building the image (once, per environment)

The image bakes the exec-server + Chromium + Python skill deps (`image/Dockerfile`
+ `image/exec-server.mjs`).

```bash
# 1. package + upload
cd image && zip -r app.zip Dockerfile exec-server.mjs
aws s3 cp app.zip s3://<stimulir-microvm-build-bucket>/sandbox/app.zip --region eu-west-1

# 2. build the MicroVM image (runs the Dockerfile, snapshots the running state)
aws lambda-microvms create-microvm-image \
  --name stimulir-sandbox \
  --code-artifact uri=s3://<bucket>/sandbox/app.zip \
  --base-image-arn arn:aws:lambda:eu-west-1:aws:microvm-image:al2023-1 \
  --build-role-arn arn:aws:iam::<acct>:role/MicrovmBuildRole \
  --region eu-west-1

# 3. wait for state=CREATED, note the imageArn
aws lambda-microvms get-microvm-image --image-identifier stimulir-sandbox --region eu-west-1
```

Wire the resulting `imageArn` into the consumer as `imageIdentifier`.

## Usage

```ts
import { MicrovmSandbox } from "@stimulir/code-runtime-sandbox-microvm";

const box = new MicrovmSandbox({
  region: "eu-west-1",
  imageIdentifier: "arn:aws:lambda:eu-west-1:ACCT:microvm-image:stimulir-sandbox",
  secrets: { SERPER_API_KEY: vaultKey, STIMULIR_API_KEY: gatewayKey },
});
const r = await box.exec("python3 /workspace/.skills/deep-research/helpers/search_serper.py 'q'");
await box.dispose();
```

## Status

- ✅ Provider class + exec-server written; exec-server **verified live** (exec,
  secret injection via `/run`, file I/O, exit codes).
- ⏳ `pnpm add @aws-sdk/client-lambda-microvms` + `tsc` typecheck of the provider.
- ⏳ Real image build + `run-microvm` round-trip in eu-west-1 (needs the build
  bucket + `MicrovmBuildRole`).
- ⏳ Consumer swap in stimulir-console (`SANDBOX_PROVIDER` selection).
