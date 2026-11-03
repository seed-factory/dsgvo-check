/** Programmatic API (used by the canary runner and tests). */

export { allChecks, createRegistry } from './checks/index.ts';
export { FINGERPRINT_VERSION, fingerprint, subjects } from './core/evaluation/fingerprint.ts';
export type { ExitCode, GateInput, GateResult } from './core/evaluation/gate.ts';
export { gate } from './core/evaluation/gate.ts';
export type { ReportFormat } from './core/report/reporter.ts';
export type {
  CheckResult,
  CheckStatus,
  Confidence,
  Diagnostic,
  Evidence,
  FailedReport,
  FailOn,
  Finding,
  FullReport,
  Report,
  Severity,
} from './core/report/schema.ts';
export { ReportSchema, reportJsonSchema, SCHEMA_VERSION } from './core/report/schema.ts';
export type { Logger, LogLevel } from './core/runtime/logger.ts';
export { createLogger, silentLogger } from './core/runtime/logger.ts';
export { TOOL_VERSION } from './core/runtime/version.ts';
export type { Snapshot, SnapshotSectionKey, TargetInfo } from './core/snapshot/index.ts';
export type { NetworkConfig, TestNetwork } from './core/url/net.ts';
export type { WriteResult } from './reporters/write.ts';
export { writeReports } from './reporters/write.ts';
export type { ScanResult } from './scan.ts';
export { scan } from './scan.ts';
export type { ResolvedScanOptions, ScanOptions } from './scan-options.ts';
export { DEFAULTS, resolveOptions } from './scan-options.ts';
