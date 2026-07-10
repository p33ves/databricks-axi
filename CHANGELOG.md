# Changelog

## [0.6.0](https://github.com/p33ves/databricks-axi/compare/v0.5.0...v0.6.0) (2026-07-10)


### Features

* **clusters:** add list, view, start, stop commands wrapping the databricks CLI ([#21](https://github.com/p33ves/databricks-axi/issues/21)) ([5bf83b9](https://github.com/p33ves/databricks-axi/commit/5bf83b90bb0f4090720dacdb1ae268d5e7998389))

## [0.5.0](https://github.com/p33ves/databricks-axi/compare/v0.4.0...v0.5.0) (2026-07-10)


### Features

* **workspace,fs:** add read-only workspace and fs commands ([#19](https://github.com/p33ves/databricks-axi/issues/19)) ([cad1baf](https://github.com/p33ves/databricks-axi/commit/cad1bafef90c970e8609d95eb8df540c2c3250ba))


### Bug Fixes

* **security:** redact job log output and route API bodies off argv ([#15](https://github.com/p33ves/databricks-axi/issues/15)) ([1c6e388](https://github.com/p33ves/databricks-axi/commit/1c6e3881f8b0e064685806991295dbb64add6164))

## [0.4.0](https://github.com/p33ves/databricks-axi/compare/v0.3.0...v0.4.0) (2026-07-09)


### Features

* **catalog:** add catalog domain for read-only Unity Catalog browsing ([#10](https://github.com/p33ves/databricks-axi/issues/10)) ([2e92ca1](https://github.com/p33ves/databricks-axi/commit/2e92ca1946a3f0747c432b0f13d5f0c9e7c60708))

## [0.3.0](https://github.com/p33ves/databricks-axi/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* **sql:** add sql domain (warehouses, exec via statement-API polling, statement view) and raw `api` passthrough ([#8](https://github.com/p33ves/databricks-axi/issues/8)) ([8c25df4](https://github.com/p33ves/databricks-axi/commit/8c25df453691dd9e42712cff27eef39c9cf3b341))

## [0.2.0](https://github.com/p33ves/databricks-axi/compare/v0.1.0...v0.2.0) (2026-07-07)


### Features

* **jobs:** add jobs domain — `jobs list | view | run | runs | logs | cancel` ([#5](https://github.com/p33ves/databricks-axi/issues/5)) ([cd8e551](https://github.com/p33ves/databricks-axi/commit/cd8e55109e7e22dd5628c6b65c16d5f659ae8d6a))

## 0.1.0 (2026-07-07)


### Features

* walking-skeleton CLI on axi-sdk-js (home + built-ins only) ([43113bd](https://github.com/p33ves/databricks-axi/commit/43113bdb85f4264ba6b10d6b153df1a2f346fe48))
* generated databricks-axi skill with staleness check ([994e9ed](https://github.com/p33ves/databricks-axi/commit/994e9ed666a06614272d671a3933f605448f00c6))


### Bug Fixes

* honest pre-release skill copy, home registered by name, structured errors from bin shim ([b6e8f99](https://github.com/p33ves/databricks-axi/commit/b6e8f99da7aecbc00f34a9847bc1681969754bc6))
