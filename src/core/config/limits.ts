/** Size and time limits of the renderers, taken from the settings. */
import type { ReporterLimits } from '../report/reporter.ts';
import { type Config, DEFAULT_CONFIG } from './schema.ts';

export function reporterLimits(config: Pick<Config, 'report' | 'pdf'> = DEFAULT_CONFIG): ReporterLimits {
  const { summaryMaxFindings, summaryMaxBytes, screenshotEmbedMaxBytes } = config.report;
  return { summaryMaxFindings, summaryMaxBytes, screenshotEmbedMaxBytes, pdfTimeoutMs: config.pdf.timeoutMs };
}
