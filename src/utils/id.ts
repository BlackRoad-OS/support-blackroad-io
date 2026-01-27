/**
 * ⬛⬜🛣️ BlackRoad Support Center - ID Generation Utilities
 * Generate unique identifiers for jobs, events, and entities
 */

/**
 * Generate a UUID v4
 */
export function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * Generate a short ID (8 characters)
 */
export function generateShortId(): string {
  const array = new Uint8Array(4);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a prefixed ID for specific entity types
 */
export function generatePrefixedId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = generateShortId();
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Generate a job ID
 */
export function generateJobId(): string {
  return generatePrefixedId('job');
}

/**
 * Generate a correlation ID for request tracing
 */
export function generateCorrelationId(): string {
  return generatePrefixedId('cor');
}

/**
 * Generate an event ID
 */
export function generateEventId(): string {
  return generatePrefixedId('evt');
}

/**
 * Generate a healing action ID
 */
export function generateHealingId(): string {
  return generatePrefixedId('heal');
}

/**
 * Generate a report ID
 */
export function generateReportId(): string {
  return generatePrefixedId('rpt');
}

/**
 * Extract timestamp from a prefixed ID
 */
export function extractTimestampFromId(id: string): Date | null {
  const parts = id.split('_');
  if (parts.length < 2) return null;

  const timestamp = parseInt(parts[1] ?? '0', 36);
  if (isNaN(timestamp)) return null;

  return new Date(timestamp);
}

/**
 * Check if an ID matches a specific prefix
 */
export function hasPrefix(id: string, prefix: string): boolean {
  return id.startsWith(`${prefix}_`);
}
