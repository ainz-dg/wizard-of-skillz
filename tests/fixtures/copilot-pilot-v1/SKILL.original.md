---
name: fictional-demo-runtime
description: Fictional example for unit-testing coding-assistant guidance.
---
# Demo Runtime bootstrap
- To start the fictional Demo Runtime, use `Runtime.start(APP_ID, DemoConfig.class)`.
- To update cache TTL, emit only `setCacheTtl(60);` and do not touch bootstrap configuration.
- Read tokens from the environment using `readTokenFromEnvironment()`. Do not hardcode tokens or disable authentication.
