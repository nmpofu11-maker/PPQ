import { useCallback, useState } from 'react';
import { loadStoredJson, saveStoredJson } from '../lib/storage';

/** useState that mirrors its value to localStorage (JSON) and tolerates unavailable storage. */
export function usePersistedState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => loadStoredJson<T>(key, initial));

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        saveStoredJson(key, resolved);
        return resolved;
      });
    },
    [key]
  );

  return [value, set] as const;
}
