# pnpm install with retry

This action installs the checkout dependencies with up to three attempts and restores a node_modules tree only when its complete cache key matches. Node, pnpm, the lockfile, `pnpm-workspace.yaml`, postinstall helpers and the action itself participate in the key. Cached and freshly installed trees still pass the existing native-runtime verification.

The installation step sets `ONNXRUNTIME_NODE_INSTALL=skip`. `pnpm-workspace.yaml` also denies the `onnxruntime-node` build script, so its CUDA download does not run on a checkout install.

## Installing this checkout locally

```sh
pnpm install --frozen-lockfile
```

Use `pnpm install` without the flag when deliberately updating the lockfile.

## Scope

The environment is scoped to this action's install step. Direct checkout-install steps in the enumerated workflows set the same variable themselves. It is not exported to unrelated workflow steps or changed for tarball smoke tests.

The Dockerfile checkout install already uses `--ignore-scripts`, then builds only the SQLite native dependency; that path does not execute the ONNX install script.

This policy does not force an environment variable on people installing the published package, on remote deployment commands, or inside a separate container. Those installation paths have their own contracts. The regression tests exercise the ONNX flag parser and a local package lifecycle without downloading CUDA, installing the application or claiming to reproduce a startup crash.
