/** Programmatic API (used by the canary runner and tests). */

export { allChecks, createRegistry } from './checks/index.ts';
export { FINGERPRINT_VERSION, fingerprint, subjects } from './core/fingerprint.ts';
export type { ExitCode, GateInput, GateResult } from './core/gate.ts';
export { gate } from './core/gate.ts';
export type { Logger, LogLevel } from './core/logger.ts';
export { createLogger, silentLogger } from './core/logger.ts';
export type { NetworkConfig, TestNetwork } from './core/net.ts';
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
} from './core/report-schema.ts';
export { ReportSchema, reportJsonSchema, SCHEMA_VERSION } from './core/report-schema.ts';
export type { ReportFormat } from './core/reporter.ts';
export type { Snapshot, SnapshotSectionKey, TargetInfo } from './core/snapshot.ts';
export { TOOL_VERSION } from './core/version.ts';
export type { ResolvedScanOptions, ScanOptions, ScanResult, WriteResult } from './scan.ts';
export { DEFAULTS, resolveOptions, scan, writeReports } from './scan.ts';
