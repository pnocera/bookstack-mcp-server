"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBooleanEnv = parseBooleanEnv;
/**
 * Parses a boolean environment variable.
 * Accepts "1", "true", "yes", "on" (case-insensitive) as truthy values.
 *
 * @param value - The raw environment variable value (process.env.MY_VAR)
 * @param defaultValue - Returned when value is undefined (default: false)
 */
function parseBooleanEnv(value, defaultValue = false) {
    if (value === undefined)
        return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
//# sourceMappingURL=env.js.map