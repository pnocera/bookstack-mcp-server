/**
 * Parses a boolean environment variable.
 * Accepts "1", "true", "yes", "on" (case-insensitive) as truthy values.
 *
 * @param value - The raw environment variable value (process.env.MY_VAR)
 * @param defaultValue - Returned when value is undefined (default: false)
 */
export declare function parseBooleanEnv(value: string | undefined, defaultValue?: boolean): boolean;
//# sourceMappingURL=env.d.ts.map