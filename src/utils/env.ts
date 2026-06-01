/**
 * Parses a boolean environment variable.
 * Accepts "1", "true", "yes", "on" (case-insensitive) as truthy values.
 *
 * @param value - The raw environment variable value (process.env.MY_VAR)
 * @param defaultValue - Returned when value is undefined (default: false)
 */
export function parseBooleanEnv(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
