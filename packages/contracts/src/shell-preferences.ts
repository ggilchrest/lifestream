import { validateUnifiedDesktopRecord, type ContractPin } from './unified-desktop-contracts.ts';
import type { ValidationResult } from './validator.ts';
import type { PresentationPreferences } from './shell-preferences.types.ts';
export type * from './shell-preferences.types.ts';
export const SHELL_PREFERENCES_SCHEMA_ID = 'https://lifestream.dev/contracts/shell-preferences/1.1.0';
export const validateShellPreferencesRecord = (kind: string, value: unknown, pin?: ContractPin): ValidationResult => validateUnifiedDesktopRecord('shell-preferences', kind, value, pin);
/** Normalize presentation dimensions only; no unknown fields or policy/authority state survives. */
export function normalizeShellPreferenceDimensions(values: PresentationPreferences): PresentationPreferences {
  const clamp = (value: number, min: number, max: number, fallback: number) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  return { theme: values.theme, textScale: clamp(values.textScale, .75, 2, 1), motion: values.motion, contrast: values.contrast, keyboardHints: values.keyboardHints, defaultView: values.defaultView,
    layout: {sidebarWidth: Math.round(clamp(values.layout.sidebarWidth, 200, 480, 280)), activityWidth: Math.round(clamp(values.layout.activityWidth, 240, 960, 480)), activityExpanded: values.layout.activityExpanded, navigationExpanded: values.layout.navigationExpanded} };
}
