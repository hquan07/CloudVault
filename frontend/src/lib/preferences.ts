export interface AccountPreferences {
  inAppNotifications: boolean;
  browserNotifications: boolean;
  compactNavigation: boolean;
  reduceMotion: boolean;
}

export const DEFAULT_PREFERENCES: AccountPreferences = {
  inAppNotifications: true,
  browserNotifications: false,
  compactNavigation: false,
  reduceMotion: false,
};

const STORAGE_KEY = 'cloudvault_account_preferences';
export const PREFERENCES_EVENT = 'cloudvault:preferences-changed';

export function loadPreferences(): AccountPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_PREFERENCES, ...stored };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function applyPreferences(preferences: AccountPreferences) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.density = preferences.compactNavigation ? 'compact' : 'comfortable';
  document.documentElement.dataset.motion = preferences.reduceMotion ? 'reduced' : 'full';
}

export function savePreferences(preferences: AccountPreferences) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  applyPreferences(preferences);
  window.dispatchEvent(new CustomEvent<AccountPreferences>(PREFERENCES_EVENT, { detail: preferences }));
}
